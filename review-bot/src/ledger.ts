// The dashboard's D1 ledger. Each Review object writes its own run row and a
// few typed events at boundaries. Every method is synchronous and never
// throws: telemetry must not block or fail a review.

import type { LifecycleEvent } from "./lifecycle";
import type { FailureClass, RunStatus } from "./status";
import type { Target, Verdict } from "./reviewer";

export type ModelUsage = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

/** What the ledger stores about a run: identity, status, outcome, usage. */
export type RunSnapshot = {
  runKey: string;
  target: Target;
  model: string | null;
  startedAt: number;
  status: Exclude<RunStatus, "not_started">;
  decision: Verdict["decision"] | null;
  findings: number;
  failure: FailureClass | null;
  usage: ModelUsage[];
};

type Detail = Record<string, string | number | boolean>;

export type LedgerEvent = {
  kind: "modal" | "mcp" | "mcp_connect" | "github_token" | "lifecycle";
  name: string;
  ok: boolean;
  ms: number | null;
  detail?: Detail;
};

export type RecoveryOutcome = "open" | "recovered" | "failed" | "unverified";

export type RecoveryCounts = {
  tasks: number;
  scanComplete: boolean;
  endedOk: number;
  endedBad: number;
};

/** How a boot's recovery ended, given the run's status once its work stopped. */
export function resolveRecovery(
  r: RecoveryCounts,
  run: RunSnapshot["status"],
): RecoveryOutcome {
  if (r.endedBad > 0 || run === "failed") return "failed";
  if (run !== "done") return "open";
  return r.scanComplete && r.endedOk >= r.tasks ? "recovered" : "unverified";
}

const FLUSH_AT = 20;
const BUFFER_CAP = 200;
/** Events one boot may write; a runaway loop cannot fill D1. */
const BOOT_EVENT_CAP = 500;
const DETAIL_MAX = 512;

type Ids = { objectId: string; bootId: string };
type Pending = LedgerEvent & { at: number };

export class Ledger {
  readonly #db: D1Database | undefined;
  readonly #ids: Ids;
  readonly #defer: (p: Promise<unknown>) => void;
  #buffer: Pending[] = [];
  #written = 0;
  #dropped = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #lastSnapshot: string | null = null;
  #recovery: RecoveryCounts | null = null;

  constructor(
    db: D1Database | undefined,
    ids: Ids,
    defer: (p: Promise<unknown>) => void,
  ) {
    this.#db = db;
    this.#ids = ids;
    this.#defer = defer;
  }

  event(e: LedgerEvent): void {
    if (!this.#db) return;
    if (this.#buffer.length >= BUFFER_CAP || this.#written >= BOOT_EVENT_CAP) {
      this.#dropped++;
      return;
    }
    this.#written++;
    this.#buffer.push({ ...e, at: Date.now() });
    if (this.#buffer.length >= FLUSH_AT) this.flush();
  }

  /** Forwards the lifecycle events the dashboard reads; boots and alarms stay log-only. */
  lifecycle(e: LifecycleEvent): void {
    if (!this.#db) return;
    switch (e.event) {
      case "review.recovery_detected":
        this.#recovery = {
          tasks: e.tasks.length,
          scanComplete: e.scanComplete,
          endedOk: 0,
          endedBad: 0,
        };
        this.event({
          kind: "lifecycle",
          name: e.event,
          ok: true,
          ms: null,
          detail: { tasks: e.tasks.length, scanComplete: e.scanComplete },
        });
        this.#write("recovery", [this.#recoveryRow("open")]);
        return;
      case "review.recovery_task_ended": {
        const ok = e.outcome === "done" && e.status === "ok";
        if (this.#recovery) {
          if (ok) this.#recovery.endedOk++;
          else this.#recovery.endedBad++;
        }
        this.event({
          kind: "lifecycle",
          name: e.event,
          ok,
          ms: null,
          detail: { task: e.taskName, outcome: e.outcome },
        });
        return;
      }
      case "review.finished":
        this.event({
          kind: "lifecycle",
          name: e.event,
          ok: true,
          ms: null,
          detail: { decision: e.decision, findings: e.findings },
        });
        return;
    }
  }

  /**
   * Upserts the run row from a fresh snapshot. Repeats converge and write no
   * rows: updates apply only to changed values, ended_at keeps its first
   * value, and the status event is logged only when the stored status changes.
   */
  record(read: () => Promise<RunSnapshot | null>): void {
    if (!this.#db) return;
    this.#enqueue("record", async () => {
      const s = await read();
      if (!s) return;
      const json = JSON.stringify(s);
      if (json === this.#lastSnapshot) return;
      this.#lastSnapshot = json;
      const terminal = s.status === "done" || s.status === "failed";
      const status = s.status === "scanning" ? "running" : s.status;
      const statements = [
        this.#prepare(
          `INSERT INTO events (at, object_id, boot_id, kind, name, ok, ms, detail)
           SELECT ?1, ?2, ?3, 'lifecycle', ?4, ?5, NULL, ?6
           WHERE NOT EXISTS (SELECT 1 FROM runs WHERE object_id = ?2 AND status = ?7)`,
          Date.now(),
          this.#ids.objectId,
          this.#ids.bootId,
          `review.${status}`,
          status === "failed" ? 0 : 1,
          detailJson(s.failure ? { failure: s.failure } : undefined),
          status,
        ),
        this.#runRow(s, status, terminal),
        ...s.usage.map((u) =>
          this.#prepare(
            `INSERT INTO run_models (object_id, model, input, output, cache_read, cache_write, cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (object_id, model) DO UPDATE SET
               input = excluded.input, output = excluded.output,
               cache_read = excluded.cache_read, cache_write = excluded.cache_write,
               cost_usd = excluded.cost_usd
             WHERE run_models.input IS NOT excluded.input OR run_models.output IS NOT excluded.output
               OR run_models.cache_read IS NOT excluded.cache_read
               OR run_models.cache_write IS NOT excluded.cache_write`,
            this.#ids.objectId,
            u.model,
            u.input,
            u.output,
            u.cacheRead,
            u.cacheWrite,
            u.costUsd,
          ),
        ),
      ];
      if (terminal && this.#recovery) {
        const outcome = resolveRecovery(this.#recovery, s.status);
        statements.push(this.#recoveryRow(outcome));
      }
      statements.push(...this.#drain());
      await this.#db!.batch(statements);
    });
  }

  flush(): void {
    if (!this.#db || (!this.#buffer.length && !this.#dropped)) return;
    // Drained now, so events arriving before the write runs start a new buffer.
    const statements = this.#drain();
    statements.push(
      this.#prepare(
        "UPDATE runs SET last_seen_at = ? WHERE object_id = ?",
        Date.now(),
        this.#ids.objectId,
      ),
    );
    this.#write("flush", statements);
  }

  #drain(): D1PreparedStatement[] {
    const events = this.#buffer;
    this.#buffer = [];
    if (this.#dropped) {
      events.push({
        kind: "lifecycle",
        name: "ledger.events_dropped",
        ok: false,
        ms: null,
        at: Date.now(),
        detail: { n: this.#dropped },
      });
      this.#dropped = 0;
    }
    return events.map((e) =>
      this.#prepare(
        "INSERT INTO events (at, object_id, boot_id, kind, name, ok, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        e.at,
        this.#ids.objectId,
        this.#ids.bootId,
        e.kind,
        e.name,
        e.ok ? 1 : 0,
        e.ms === null ? null : Math.round(e.ms),
        detailJson(e.detail),
      ),
    );
  }

  #runRow(
    s: RunSnapshot,
    status: string,
    terminal: boolean,
  ): D1PreparedStatement {
    const t = s.target;
    const now = Date.now();
    const cost = s.usage.reduce((sum, u) => sum + u.costUsd, 0);
    return this.#prepare(
      `INSERT INTO runs (object_id, run_key, owner, repo, number, head_sha, mode, model, started_at, last_seen_at, ended_at, status, decision, findings, failure, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (object_id) DO UPDATE SET
         model = excluded.model, last_seen_at = excluded.last_seen_at,
         ended_at = COALESCE(runs.ended_at, excluded.ended_at),
         status = excluded.status, decision = excluded.decision,
         findings = excluded.findings, failure = excluded.failure,
         cost_usd = excluded.cost_usd
       WHERE excluded.status = 'running' OR runs.status IS NOT excluded.status
         OR runs.decision IS NOT excluded.decision OR runs.findings IS NOT excluded.findings
         OR runs.failure IS NOT excluded.failure OR runs.cost_usd IS NOT excluded.cost_usd`,
      this.#ids.objectId,
      s.runKey,
      t.owner,
      t.repo,
      t.number,
      t.headSha,
      t.mode ?? "webhook",
      s.model,
      s.startedAt,
      now,
      terminal ? now : null,
      status,
      s.decision,
      s.findings,
      s.failure,
      cost,
    );
  }

  #recoveryRow(outcome: RecoveryOutcome): D1PreparedStatement {
    const r = this.#recovery!;
    const now = Date.now();
    return this.#prepare(
      `INSERT INTO recoveries (boot_id, object_id, detected_at, tasks, scan_complete, ended_ok, ended_bad, resolved_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (boot_id) DO UPDATE SET
         ended_ok = excluded.ended_ok, ended_bad = excluded.ended_bad,
         resolved_at = excluded.resolved_at, outcome = excluded.outcome`,
      this.#ids.bootId,
      this.#ids.objectId,
      now,
      r.tasks,
      r.scanComplete ? 1 : 0,
      r.endedOk,
      r.endedBad,
      outcome === "open" ? null : now,
      outcome,
    );
  }

  #prepare(sql: string, ...values: unknown[]): D1PreparedStatement {
    return this.#db!.prepare(sql).bind(...values);
  }

  /** Writes run in issue order, so a settle never lands before the start it follows. */
  #enqueue(op: string, work: () => Promise<void>): void {
    const next = this.#queue.then(work).catch((error) =>
      console.warn({
        event: "ledger.write_failed",
        op,
        error: String(error).slice(0, 200),
      }),
    );
    this.#queue = next;
    this.#defer(next);
  }

  #write(op: string, statements: D1PreparedStatement[]): void {
    this.#enqueue(op, async () => {
      await this.#db!.batch(statements);
    });
  }
}

function detailJson(detail: Detail | undefined): string | null {
  if (!detail) return null;
  const json = JSON.stringify(detail);
  return json.length > DETAIL_MAX ? JSON.stringify({ truncated: true }) : json;
}
