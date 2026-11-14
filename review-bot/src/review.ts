// One Durable Object per (pull request, head commit). It holds a pi-durable
// Harness on the object's SQLite storage and runs the reviewer agent on it.

import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
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
import { type AppSecrets, installationToken } from "./github";
import { mcpExtension, mcpNamespaces, mcpServers } from "./mcp";
import type { Check, ScanResult } from "./scanners";
import {
  EMPTY_REVIEW,
  ReviewDoc,
  reviewerExtension,
  type ReviewState,
  type Target,
} from "./reviewer";

export interface Env extends AppSecrets {
  WEBHOOK_SECRET: string;
  REVIEW_BASE_URL: string;
  REVIEW_PROMPT_URL: string;
  MODEL_ID: string;
  THINKING_LEVEL: ModelThinkingLevel;
  ANTHROPIC_API_KEY: string;
  SCANNER_URL: string;
  SCANNER_TOKEN: string;
  MCP_SERVERS?: Record<string, unknown>;
  REVIEWS: DurableObjectNamespace<Review>;
}

export type Activity =
  | { kind: "say"; text: string }
  | { kind: "call"; name: string; args: unknown }
  | { kind: "result"; name: string; isError: boolean; text: string };

export type ReviewView = {
  status: "not_started" | "scanning" | "running" | "done" | "failed";
  failure: string | null;
  review: Omit<ReviewState, "prompt"> & {
    prompt: { url: string; sha256: string } | null;
  };
  activity: Activity[];
  costUsd: number;
};

const HEARTBEAT_MS = 60_000;
const PROVIDER = "anthropic";

export function reviewKey(t: {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}) {
  return `${t.owner}/${t.repo}#${t.number}@${t.headSha}`;
}

export class Review extends DurableObject<Env> {
  #harness!: Harness;
  #scanTask!: ReturnType<typeof reviewerExtension>["scanTask"];
  #tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    void state.blockConcurrencyWhile(async () => {
      // Armed before anything can throw, so an object whose open fails is started again.
      const fallback = Date.now() + HEARTBEAT_MS;
      const current = await state.storage.getAlarm();
      if (current === null || current > fallback)
        await state.storage.setAlarm(fallback);

      const models = createModels({
        authContext: {
          env: async (name) =>
            (env as unknown as Record<string, string | undefined>)[name],
          fileExists: async () => false,
        },
      });
      models.setProvider(anthropicProvider());
      const registry = createRegistry();
      const reviewer = reviewerExtension({
        token: (id) => this.#token(id),
        scan: (target, token, checks) => this.#scan(target, token, checks),
      });
      this.#scanTask = reviewer.scanTask;
      registry.install(reviewer.extension);
      const servers = mcpServers(env.MCP_SERVERS);
      registry.install(await mcpExtension(servers));
      registry.install(
        createCodemodeExtension({
          sandbox: createInlineCodemodeSandbox(),
          namespaces: mcpNamespaces(servers),
          models: false,
        }),
      );

      this.#harness = await Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        {
          models,
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
    await this.#arm({ ...this.#harness.wake(), active: true });
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
      state.model = `${PROVIDER}/${this.env.MODEL_ID} thinking=${this.env.THINKING_LEVEL}`;
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
  }

  async view(): Promise<ReviewView> {
    const root = await this.#root();
    const [state, live, page] = await Promise.all([
      this.#harness.snapshot(ReviewDoc, root.id, ctx),
      this.#harness.snapshot(LiveDoc, root.id, ctx),
      root.entries({ order: "ascending" }, 1000, undefined, ctx),
    ]);
    const [usage, inspection] = await Promise.all([
      this.#harness.usage(ctx),
      this.#harness.inspect(ctx),
    ]);
    const review = state ?? EMPTY_REVIEW;
    const failure = live?.runFailure
      ? `${live.runFailure.reason}${live.runFailure.detail ? `: ${live.runFailure.detail}` : ""}`
      : null;
    const status = !review.target
      ? "not_started"
      : review.verdict
        ? "done"
        : failure
          ? "failed"
          : review.scan?.status === "pending"
            ? "scanning"
            : inspection.tasks.length > 0
              ? "running"
              : "failed";

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

    const { prompt, ...rest } = review;
    return {
      status,
      failure:
        status === "failed"
          ? (failure ?? "the model stopped without calling finish_review")
          : null,
      review: {
        ...rest,
        prompt: prompt && { url: prompt.url, sha256: prompt.sha256 },
      },
      activity,
      costUsd: Object.values(usage.models).reduce(
        (sum, u) => sum + u.cost.total,
        0,
      ),
    };
  }

  #root(): Promise<Conversation> {
    return this.#harness.root(ctx, {
      agent: {
        model: { provider: PROVIDER, modelId: this.env.MODEL_ID },
        thinkingLevel: this.env.THINKING_LEVEL,
        maxTurns: 80,
      },
    });
  }

  async #scan(
    target: Target,
    token: string,
    checks: Check[],
  ): Promise<ScanResult[]> {
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
    });
    if (!res.ok)
      throw new Error(`scanner -> ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async #token(installationId: number): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000)
      return cached.token;
    const fresh = await installationToken(this.env, installationId);
    this.#tokens.set(installationId, fresh);
    return fresh.token;
  }

  async #arm(wake: Wake): Promise<void> {
    // A recovery heartbeat while work runs, never later than the earliest sleep.
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
    const at =
      heartbeat === undefined || wake.at === undefined
        ? (heartbeat ?? wake.at)
        : Math.min(heartbeat, wake.at);
    if (at === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}
