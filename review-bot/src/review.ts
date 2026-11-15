// One Durable Object per (pull request, head commit). It holds a pi-durable
// Harness on the object's SQLite storage and runs the reviewer agent on it.

import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { verdaProvider } from "./verda";
import {
  AssistantEntry,
  type Conversation,
  createRegistry,
  Harness,
  LiveDoc,
  ToolResultEntry,
  type Wake,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { alarmWrite, HEARTBEAT_MS } from "./alarm";
import { type VerificationReceipt, verificationCounts } from "./formal";
import type { FindingVerdict } from "./verifier";
import { fromStored, heldBack, type Stored } from "./findings";
import { evidenceHtml } from "./evidence";
import { executor, recordExecutor } from "./executor";
import { Ledger, type RunSnapshot } from "./ledger";
import { interruptedTasks, Lifecycle } from "./lifecycle";
import {
  type PublicAppSecrets,
  publishReview,
  installationToken,
  publicInstallationToken,
} from "./github";
import { reviewKey, reviewLink } from "./review-key";
import { mcpExtension, mcpNamespaces, mcpServers } from "./mcp";
import type { ManualGate } from "./manual-gate";
import { failureClass, reviewStatus, type RunStatus } from "./status";
import type { Check, ScanResult } from "./scanners";
import type { Echo, SignOff } from "./signoff";
import {
  EMPTY_REVIEW,
  type Finding,
  recordLookup,
  ReviewDoc,
  reviewerExtension,
  type ReviewState,
  type Target,
} from "./reviewer";

export interface Env extends PublicAppSecrets {
  WEBHOOK_SECRET: string;
  REVIEW_BASE_URL: string;
  REVIEW_PROMPT_URL: string;
  MODELS: ModelChoice[];
  THINKING_LEVEL: ModelThinkingLevel;
  ANTHROPIC_API_KEY?: string;
  VERDA_API_KEY?: string;
  SCANNER_URL: string;
  SCANNER_TOKEN: string;
  /** Loopback URL for the intentionally unrestricted ephemeral shell service. */
  EXECUTOR_URL?: string;
  /** Shared secret between the CellD Worker and the shell service. */
  EXECUTOR_TOKEN?: string;
  MCP_SERVERS?: Record<string, unknown>;
  CONTEXT_DEV_API_KEY?: string;
  /** GitHub App user authorization, for the owner's sign-off. Optional: without them the page cannot sign. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Signs the sign-in session cookies. */
  SESSION_SECRET?: string;
  REVIEWS: DurableObjectNamespace<Review>;
  MANUAL_GATE: DurableObjectNamespace<ManualGate>;
  ASSETS: Fetcher;
  /** The dashboard's ledger. Unbound (as in the write profile), telemetry is off. */
  LEDGER?: D1Database;
}

export type ModelChoice = { provider: "anthropic" | "verda"; id: string };

export type Activity =
  | { kind: "say"; text: string }
  | { kind: "call"; name: string; args: unknown }
  | { kind: "result"; name: string; isError: boolean; text: string };

/** The verifier's verdict on a finding, with the receipt it links. */
export type ViewedVerdict = FindingVerdict & { receipt?: VerificationReceipt };

export type ReviewView = {
  status: RunStatus;
  failure: string | null;
  review: Omit<ReviewState, "prompt" | "findings" | "brief"> & {
    prompt: { url: string; sha256: string } | null;
    findings: (Stored<Finding> & { verdict?: ViewedVerdict })[];
  };
  heldBack: number;
  activity: Activity[];
  costUsd: number;
  evidenceHtml: string;
  /** The named owner's sign-off on this commit, if any. */
  signOff: SignOff | null;
};

// Kept in the object's own key-value storage, outside the agent's documents,
// so nothing the agent does can write or change it.
const SIGNOFF_KEY = "signoff:v1";

export { reviewLink } from "./review-key";

export class Review extends DurableObject<Env> {
  #harness!: Harness;
  #scanTask!: ReturnType<typeof reviewerExtension>["scanTask"];
  #verifier!: ReturnType<typeof reviewerExtension>["verifier"];
  #tokens = new Map<number | "public", { token: string; expiresAt: number }>();
  #issuedAlarm: number | null = null;
  #lifecycle!: Lifecycle;
  readonly #ledger: Ledger;
  /** This boot saw work active, so its end is a run outcome worth recording. */
  #working = false;
  #model: ModelChoice;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const ids = { objectId: state.id.toString(), bootId: crypto.randomUUID() };
    this.#ledger = new Ledger(env.LEDGER, ids, (p) => state.waitUntil(p));
    // The object id derives from the review key, so each (PR, commit) keeps
    // one model across retries while reviews spread evenly over MODELS.
    const bucket = parseInt(state.id.toString().slice(-8), 16);
    this.#model = env.MODELS[bucket % env.MODELS.length]!;
    void state.blockConcurrencyWhile(async () => {
      // Armed before anything can throw, so an object whose open fails is started again.
      const fallback = Date.now() + HEARTBEAT_MS;
      const current = await state.storage.getAlarm();
      this.#issuedAlarm = current;
      if (current === null || current > fallback) {
        this.#issuedAlarm = fallback;
        await state.storage.setAlarm(fallback);
      }

      const models = createModels({
        authContext: {
          env: async (name) =>
            (env as unknown as Record<string, string | undefined>)[name],
          fileExists: async () => false,
        },
      });
      models.setProvider(anthropicProvider());
      models.setProvider(verdaProvider());
      const registry = createRegistry();
      const recorded = recordExecutor(
        () => executor(env),
        (event) => this.#ledger.event(event),
      );
      const reviewer = reviewerExtension({
        token: (id) => this.#token(id),
        scan: (target, token, checks) => this.#scan(target, token, checks),
        publish: (target, token, findings, risk) =>
          target.mode === "manual"
            ? Promise.resolve()
            : publishReview(
                token,
                target,
                findings,
                reviewLink(env, target),
                risk,
              ),
        finished: (decision, findings) => {
          this.#lifecycle.finished(decision, findings);
          this.#ledger.record(() => this.#snapshot());
        },
        checkout: recorded.checkout,
        shell: recorded.shell,
        release: recorded.release,
      });
      this.#scanTask = reviewer.scanTask;
      this.#verifier = reviewer.verifier;
      registry.install(reviewer.extension);
      registry.install(reviewer.verifier);
      const servers = mcpServers(
        env.MCP_SERVERS,
        env as unknown as Record<string, unknown>,
      );
      registry.install(
        await mcpExtension(servers, {
          before: recordLookup,
          after: (call) =>
            this.#ledger.event({
              kind: "mcp",
              name: `${call.server}/${call.tool}`,
              ok: call.ok,
              ms: call.ms,
              detail: call.aborted ? { aborted: true } : undefined,
            }),
          connected: (server, ok, ms) =>
            this.#ledger.event({ kind: "mcp_connect", name: server, ok, ms }),
        }),
      );
      registry.install(
        createCodemodeExtension({
          sandbox: createInlineCodemodeSandbox(),
          namespaces: mcpNamespaces(servers),
          models: false,
        }),
      );

      const storage = await openDurableObjectSqliteStorage(state.storage);
      this.#lifecycle = new Lifecycle(
        ids,
        await interruptedTasks(storage, ctx),
        (event) => this.#ledger.lifecycle(event),
      );
      this.#harness = await Harness.open(
        storage,
        {
          models,
          telemetry: this.#lifecycle.telemetry,
          registry,
          settings: { retry: { maxRetries: 3 }, afterFailedRun: "withdraw" },
          onWake: (wake) =>
            void this.#arm(wake).catch(() => state.abort("alarm write failed")),
          identity: {
            attribution: {
              name: "earned-trust-review",
              url: env.REVIEW_BASE_URL,
            },
          },
        },
        ctx,
      );
      await this.#arm(this.#harness.wake());
      this.#harness.resume();
    });
  }

  override async alarm(): Promise<void> {
    // The alarm that fired is consumed.
    this.#issuedAlarm = null;
    const wake = this.#harness.wake();
    this.#lifecycle.alarm(wake);
    this.#ledger.flush();
    await this.#arm(wake);
    this.#harness.resume();
  }

  /** Idempotent: a second call for the same commit finds the review already started. */
  async start(target: Target): Promise<void> {
    const root = await this.#root();
    const existing = await this.#harness.snapshot(ReviewDoc, root.id, ctx);
    if (existing?.target) return;

    const res = await fetch(this.env.REVIEW_PROMPT_URL);
    if (!res.ok) throw new Error(`review prompt -> ${res.status}`);
    const text = await res.text();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    await root.commit(async (tx) => {
      const state = await tx.doc(ReviewDoc, root.id);
      state.target = target;
      state.prompt = { url: this.env.REVIEW_PROMPT_URL, sha256, text };
      state.model = `${this.#model.provider}/${this.#model.id} thinking=${this.env.THINKING_LEVEL}`;
      state.startedAt = Date.now();
    }, ctx);
    await this.#arm({ ...this.#harness.wake(), active: true });
    await root.commit(async (tx) => {
      const state = await tx.doc(ReviewDoc, root.id);
      if (state.scan) return;
      state.scan = { status: "pending", results: [], error: null };
      await tx.createTask(this.#scanTask, null, {
        ownership: { kind: "conversation" },
      });
    }, ctx);
    this.#ledger.record(() => this.#snapshot());
  }

  async hasStarted(): Promise<boolean> {
    const root = await this.#root();
    return Boolean(
      (await this.#harness.snapshot(ReviewDoc, root.id, ctx))?.target,
    );
  }

  /** Stores the first sign-off for this commit. Returns the earlier one if it lost the race. */
  async storeSignOff(record: SignOff): Promise<SignOff | null> {
    const earlier = await this.ctx.storage.get<SignOff>(SIGNOFF_KEY);
    if (earlier) return earlier;
    await this.ctx.storage.put(SIGNOFF_KEY, record);
    return null;
  }

  async getSignOff(): Promise<SignOff | null> {
    return (await this.ctx.storage.get<SignOff>(SIGNOFF_KEY)) ?? null;
  }

  async recordEcho(echo: { comment: Echo; status: Echo }): Promise<void> {
    const record = await this.ctx.storage.get<SignOff>(SIGNOFF_KEY);
    if (record) await this.ctx.storage.put(SIGNOFF_KEY, { ...record, echo });
  }

  async view(): Promise<ReviewView> {
    const root = await this.#root();
    const [{ review, runFailure, status, usage }, page, signOff] =
      await Promise.all([
        this.#read(),
        root.entries({ order: "ascending" }, 1000, undefined, ctx),
        this.ctx.storage.get<SignOff>(SIGNOFF_KEY),
      ]);
    const failure = runFailure
      ? `${runFailure.reason}${runFailure.detail ? `: ${runFailure.detail}` : ""}`
      : null;

    const activity: Activity[] = [];
    for (const entry of page.items) {
      const message = entry.model?.[0];
      if (AssistantEntry.is(entry) && message?.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim())
            activity.push({ kind: "say", text: block.text });
          if (block.type === "toolCall")
            activity.push({
              kind: "call",
              name: block.name,
              args: block.arguments,
            });
        }
      } else if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
        const text = message.content
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("");
        activity.push({
          kind: "result",
          name: message.toolName,
          isError: message.isError,
          text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text,
        });
      }
    }

    const { prompt, brief: _brief, ...rest } = review;
    const verdicts =
      review.verifier?.status === "done" ? review.verifier.verdicts : {};
    const findings = review.findings.map((finding) => {
      const verdict = verdicts[finding.id];
      const receipt =
        verdict?.receiptId &&
        review.verifications?.find((r) => r.id === verdict.receiptId);
      return {
        ...fromStored(finding),
        ...(verdict && {
          verdict: { ...verdict, ...(receipt && { receipt }) },
        }),
      };
    });
    return {
      status,
      failure:
        status === "failed"
          ? (failure ?? "the model stopped without calling finish_review")
          : null,
      review: {
        ...rest,
        findings,
        prompt: prompt && { url: prompt.url, sha256: prompt.sha256 },
      },
      heldBack: findings.filter(heldBack).length,
      evidenceHtml: evidenceHtml(review.evidence),
      activity,
      costUsd: Object.values(usage.models).reduce(
        (sum, u) => sum + u.cost.total,
        0,
      ),
      signOff: signOff ?? null,
    };
  }

  async #read() {
    const root = await this.#root();
    const [state, live, usage, inspection] = await Promise.all([
      this.#harness.snapshot(ReviewDoc, root.id, ctx),
      this.#harness.snapshot(LiveDoc, root.id, ctx),
      this.#harness.usage(ctx),
      this.#harness.inspect(ctx),
    ]);
    const review = state ?? EMPTY_REVIEW;
    const runFailure = live?.runFailure ?? null;
    const status = reviewStatus(review, runFailure, inspection.tasks.length);
    return { review, runFailure, status, usage };
  }

  async #snapshot(): Promise<RunSnapshot | null> {
    const { review, runFailure, status, usage } = await this.#read();
    if (!review.target || status === "not_started") return null;
    return {
      runKey: reviewKey(review.target),
      target: review.target,
      model: review.model,
      startedAt: review.startedAt ?? Date.now(),
      status,
      decision: review.verdict?.decision ?? null,
      findings: review.findings.length,
      failure: status === "failed" ? failureClass(runFailure) : null,
      verifications: verificationCounts(review.verifications ?? []),
      usage: Object.entries(usage.models).map(([model, u]) => ({
        model,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        costUsd: u.cost.total,
      })),
    };
  }

  #root(): Promise<Conversation> {
    return this.#harness.root(ctx, {
      agent: {
        model: { provider: this.#model.provider, modelId: this.#model.id },
        thinkingLevel: this.env.THINKING_LEVEL,
        maxTurns: 80,
        // The verifier's tools belong to the child that verify starts.
        extensions: { remove: [this.#verifier] },
      },
    });
  }

  async #scan(
    target: Target,
    token: string,
    checks: Check[],
  ): Promise<ScanResult[]> {
    const started = Date.now();
    const res = await fetch(`${this.env.SCANNER_URL}/scan`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.SCANNER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        owner: target.owner,
        repo: target.repo,
        sha: target.headSha,
        token,
        checks,
      }),
    }).catch((error) => {
      this.#scanEvent(false, started, 0, checks.length);
      throw error;
    });
    this.#scanEvent(res.ok, started, res.status, checks.length);
    if (!res.ok)
      throw new Error(`scanner -> ${res.status}: ${await res.text()}`);
    return res.json();
  }

  #scanEvent(ok: boolean, started: number, status: number, checks: number) {
    this.#ledger.event({
      kind: "modal",
      name: "scan",
      ok,
      ms: Date.now() - started,
      detail: { status, checks },
    });
    // One scan per review, and evictions often follow: write it now.
    this.#ledger.flush();
  }

  async #token(installationId: number | "public"): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
      this.#ledger.event({
        kind: "github_token",
        name: "hit",
        ok: true,
        ms: 0,
      });
      return cached.token;
    }
    const started = Date.now();
    const issuing =
      installationId === "public"
        ? publicInstallationToken(this.env)
        : installationToken(this.env, installationId);
    const fresh = await issuing.catch((error) => {
      this.#ledger.event({
        kind: "github_token",
        name: "miss",
        ok: false,
        ms: Date.now() - started,
      });
      throw error;
    });
    this.#ledger.event({
      kind: "github_token",
      name: "miss",
      ok: true,
      ms: Date.now() - started,
    });
    this.#tokens.set(installationId, fresh);
    return fresh.token;
  }

  async #arm(wake: Wake): Promise<void> {
    if (wake.active) this.#working = true;
    else if (this.#working) {
      this.#working = false;
      this.#ledger.record(() => this.#snapshot());
    }
    // Storage applies alarm writes in issue order, so update before awaiting.
    const write = alarmWrite(wake, Date.now(), this.#issuedAlarm);
    if (write.op === "delete") {
      this.#issuedAlarm = null;
      await this.ctx.storage.deleteAlarm();
    } else if (write.op === "set") {
      this.#issuedAlarm = write.at;
      await this.ctx.storage.setAlarm(write.at);
    }
  }
}
