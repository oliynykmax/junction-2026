// The public operations dashboard: one JSON view over the D1 ledger, and the
// page shell for the Preact client in web/dashboard.tsx. It shows only what
// the ledger holds: ids, enums, counts, times and model usage. The view is
// shaped for charts: time buckets, distributions and a pipeline funnel.

import type { VerificationOutcome } from "./formal";
import type { RecoveryOutcome } from "./ledger";
import type { FailureClass } from "./status";

export const STALE_MS = 15 * 60_000;
export const MAX_WINDOW_MS = 30 * 86_400_000;
export const RETENTION_MS = 30 * 86_400_000;
const DEFAULT_WINDOW_MS = 86_400_000;
const MAX_BUCKETS = 36;
const BUCKET_STEPS_MS = [
  5 * 60_000,
  15 * 60_000,
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
];
const RECENT = 6;
const TOOLS = 12;
/** Runs read per query, current and previous window together. */
const RUN_LIMIT = 5_000;
/** Newest rows per call kind read for percentiles, so one kind cannot crowd out another. Counts come from exact SQL totals, not from this sample. */
const SAMPLE = 2_500;
/** Upper edges of the review duration histogram; the last bin is open. */
const DURATION_EDGES_MS = [2, 4, 6, 8, 10, 15, 20, 30, 45, 60].map(
  (m) => m * 60_000,
);

export type ShownStatus = "done" | "failed" | "running" | "stale";
export const CALL_KINDS = ["shell", "mcp", "modal"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export type DashboardQuery = {
  from: number;
  to: number;
  repo: { owner: string; repo: string } | null;
};

export class QueryError extends Error {}

/** Parses the query string; throws QueryError on anything out of bounds. */
export function parseQuery(
  params: URLSearchParams,
  now: number,
): DashboardQuery {
  const int = (name: string, fallback: number) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    if (!/^\d{1,15}$/.test(raw))
      throw new QueryError(`${name} must be epoch ms`);
    return Number(raw);
  };
  const to = int("to", now);
  const from = int("from", to - DEFAULT_WINDOW_MS);
  if (from >= to) throw new QueryError("from must be before to");
  if (to - from > MAX_WINDOW_MS) throw new QueryError("window is over 30 days");

  const repoRaw = params.get("repo") || null;
  let repo: DashboardQuery["repo"] = null;
  if (repoRaw !== null) {
    const m = /^([\w.-]{1,100})\/([\w.-]{1,100})$/.exec(repoRaw);
    if (!m) throw new QueryError("repo must be owner/name");
    repo = { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
  }
  return { from, to, repo };
}

/** The smallest bucket step that keeps the window within MAX_BUCKETS bars. */
export function bucketMs(span: number): number {
  return (
    BUCKET_STEPS_MS.find((step) => span / step <= MAX_BUCKETS) ??
    BUCKET_STEPS_MS.at(-1)!
  );
}

export type RunRow = {
  runKey: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  mode: "webhook" | "manual";
  startedAt: number;
  endedAt: number | null;
  status: ShownStatus;
  decision: string | null;
  findings: number | null;
  failure: FailureClass | null;
  costUsd: number;
  link: string;
};

export type ModelRow = {
  model: string;
  runs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / (input + cacheRead + cacheWrite); null with no prompt tokens. */
  promptCacheHitRatio: number | null;
  costUsd: number;
};

export type Kpis = {
  reviews: number;
  done: number;
  failed: number;
  open: number;
  costUsd: number;
  findings: number;
  /** Median start-to-verdict time of done runs. */
  medianMs: number | null;
};

export type Bucket = {
  t: number;
  done: number;
  failed: number;
  open: number;
  findings: number;
  /** Estimated model cost of the runs started in this bucket, by model. */
  cost: Record<string, number>;
  calls: Record<CallKind, { n: number; bad: number }>;
  /** p95 latency of the sampled calls in this bucket. */
  p95: Record<CallKind, number | null>;
};

export type ToolRow = {
  kind: CallKind;
  name: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
};

export const FUNNEL_STEPS = [
  "started",
  "scanned",
  "checked_out",
  "verdict",
  "no_blockers",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type DashboardView = {
  collectionStartedAt: number | null;
  window: { from: number; to: number; bucketMs: number };
  generatedAt: number;
  kpis: Kpis;
  /** The same figures for the window just before, or null when the ledger did not collect then. */
  previous: Kpis | null;
  series: Bucket[];
  models: ModelRow[];
  outcomes: {
    noBlockers: number;
    changesRequested: number;
    open: number;
    failed: Partial<Record<FailureClass, number>>;
  };
  durations: { toMs: number | null; n: number }[];
  funnel: { step: FunnelStep; n: number }[];
  verification: Record<VerificationOutcome, number> & { runs: number };
  tools: ToolRow[];
  connections: {
    mcpConnects: number;
    mcpConnectFailures: number;
    tokenCacheHits: number;
    tokenCacheMisses: number;
  };
  recoveries: Record<RecoveryOutcome | "superseded", number> & {
    detected: number;
  };
  recent: RunRow[];
  droppedEvents: number;
};

// Row shapes as D1 returns them.
export type DbRun = {
  run_key: string;
  owner: string;
  repo: string;
  number: number;
  head_sha: string;
  mode: string;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  status: string;
  decision: string | null;
  findings: number | null;
  failure: string | null;
  cost_usd: number;
};
export type DbRunModel = {
  model: string;
  started_at: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
};
/** Exact count per kind, name and bucket; `bad` counts ok = 0. */
export type DbCount = {
  kind: string;
  name: string;
  b: number;
  n: number;
  bad: number;
};
export type DbSample = { kind: string; name: string; at: number; ms: number };
export type DbReached = { kind: string; n: number };
export type DbRecovery = {
  object_id: string;
  detected_at: number;
  outcome: string;
};

export type DashboardRows = {
  meta: { v: string }[];
  runs: DbRun[];
  runModels: DbRunModel[];
  counts: DbCount[];
  samples: DbSample[];
  reached: DbReached[];
  settled: { detail: string | null }[];
  recoveries: DbRecovery[];
  dropped: { n: number | null }[];
};

export function shownStatus(
  row: Pick<DbRun, "status" | "last_seen_at">,
  now: number,
): ShownStatus {
  if (row.status === "done" || row.status === "failed") return row.status;
  return now - row.last_seen_at > STALE_MS ? "stale" : "running";
}

export function runRow(r: DbRun, now: number): RunRow {
  const mode = r.mode === "manual" ? "manual" : "webhook";
  return {
    runKey: r.run_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    headSha: r.head_sha,
    mode,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: shownStatus(r, now),
    decision: r.decision,
    findings: r.findings,
    failure: r.failure as FailureClass | null,
    costUsd: r.cost_usd,
    link: `/${mode === "manual" ? "m" : "r"}/${r.owner}/${r.repo}/${r.number}?sha=${r.head_sha}`,
  };
}

/** Nearest-rank percentile of `ms`, ignoring nulls. */
export function percentile(
  ms: readonly (number | null)[],
  p: number,
): number | null {
  const sorted = ms
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

export function modelRows(rows: readonly DbRunModel[]): ModelRow[] {
  const by = new Map<string, Omit<ModelRow, "promptCacheHitRatio">>();
  for (const m of rows) {
    const row = by.get(m.model) ?? {
      model: m.model,
      runs: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    row.runs++;
    row.input += m.input;
    row.output += m.output;
    row.cacheRead += m.cache_read;
    row.cacheWrite += m.cache_write;
    row.costUsd += m.cost_usd;
    by.set(m.model, row);
  }
  return [...by.values()]
    .map((m) => {
      const prompt = m.input + m.cacheRead + m.cacheWrite;
      return {
        ...m,
        promptCacheHitRatio: prompt > 0 ? m.cacheRead / prompt : null,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function kpis(runs: readonly DbRun[], now: number): Kpis {
  const k: Kpis = {
    reviews: runs.length,
    done: 0,
    failed: 0,
    open: 0,
    costUsd: 0,
    findings: 0,
    medianMs: null,
  };
  const durations: number[] = [];
  for (const r of runs) {
    const s = shownStatus(r, now);
    if (s === "done") {
      k.done++;
      k.findings += r.findings ?? 0;
      if (r.ended_at !== null) durations.push(r.ended_at - r.started_at);
    } else if (s === "failed") k.failed++;
    else k.open++;
    k.costUsd += r.cost_usd;
  }
  k.medianMs = percentile(durations, 50);
  return k;
}

export function durationBins(runs: readonly DbRun[]): DashboardView["durations"] {
  const bins = [
    ...DURATION_EDGES_MS.map((toMs) => ({ toMs, n: 0 })),
    { toMs: null, n: 0 },
  ];
  for (const r of runs) {
    if (r.status !== "done" || r.ended_at === null) continue;
    const ms = r.ended_at - r.started_at;
    const i = DURATION_EDGES_MS.findIndex((edge) => ms < edge);
    bins[i < 0 ? bins.length - 1 : i].n++;
  }
  return bins;
}

export function toolRows(
  counts: readonly DbCount[],
  samples: readonly DbSample[],
): ToolRow[] {
  const totals = new Map<string, ToolRow>();
  for (const c of counts) {
    if (!isCallKind(c.kind)) continue;
    const key = `${c.kind}\0${c.name}`;
    const row = totals.get(key) ?? {
      kind: c.kind,
      name: c.name,
      calls: 0,
      errors: 0,
      p50Ms: null,
      p95Ms: null,
    };
    row.calls += c.n;
    row.errors += c.bad;
    totals.set(key, row);
  }
  const ms = groupBy(samples, (s) => `${s.kind}\0${s.name}`);
  return [...totals.entries()]
    .map(([key, row]) => {
      const sample = (ms.get(key) ?? []).map((s) => s.ms);
      return {
        ...row,
        p50Ms: percentile(sample, 50),
        p95Ms: percentile(sample, 95),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, TOOLS);
}

/** Sums the receipt counts that terminal status events carry. Runs from before receipts were logged add nothing. */
export function verificationTotals(
  settled: readonly { detail: string | null }[],
): DashboardView["verification"] {
  const totals = { passed: 0, counterexample: 0, not_run: 0, runs: 0 };
  for (const { detail } of settled) {
    const d = parseDetail(detail);
    if (!d || !("passed" in d)) continue;
    totals.runs++;
    for (const k of ["passed", "counterexample", "not_run"] as const)
      totals[k] += typeof d[k] === "number" ? d[k] : 0;
  }
  return totals;
}

/**
 * Counts recovery rows by outcome. An open row followed by a later detection
 * on the same object is superseded: that boot died again before resolving.
 */
export function recoveryCounts(
  rows: readonly DbRecovery[],
): DashboardView["recoveries"] {
  const counts = {
    detected: rows.length,
    open: 0,
    recovered: 0,
    failed: 0,
    unverified: 0,
    superseded: 0,
  };
  const latest = new Map<string, number>();
  for (const r of rows)
    latest.set(
      r.object_id,
      Math.max(latest.get(r.object_id) ?? 0, r.detected_at),
    );
  for (const r of rows) {
    const outcome = r.outcome as RecoveryOutcome;
    if (outcome === "open" && r.detected_at < (latest.get(r.object_id) ?? 0))
      counts.superseded++;
    else if (outcome in counts) counts[outcome]++;
  }
  return counts;
}

function isCallKind(kind: string): kind is CallKind {
  return (CALL_KINDS as readonly string[]).includes(kind);
}

function groupBy<T>(items: readonly T[], key: (t: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function parseDetail(
  raw: string | null,
): Record<string, string | number | boolean> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, string | number | boolean>)
      : null;
  } catch {
    return null;
  }
}

const perKind = <T>(make: () => T) =>
  Object.fromEntries(CALL_KINDS.map((k) => [k, make()])) as Record<CallKind, T>;

export function shapeView(
  q: DashboardQuery,
  rows: DashboardRows,
  now: number,
): DashboardView {
  const span = q.to - q.from;
  const step = bucketMs(span);
  const slot = (t: number) => Math.floor((t - q.from) / step);
  const series: Bucket[] = Array.from(
    { length: Math.ceil(span / step) },
    (_, i) => ({
      t: q.from + i * step,
      done: 0,
      failed: 0,
      open: 0,
      findings: 0,
      cost: {},
      calls: perKind(() => ({ n: 0, bad: 0 })),
      p95: perKind(() => null),
    }),
  );
  const at = (t: number) => series[slot(t)];

  const current = rows.runs.filter((r) => r.started_at >= q.from);
  const before = rows.runs.filter((r) => r.started_at < q.from);
  for (const r of current) {
    const b = at(r.started_at);
    if (!b) continue;
    const s = shownStatus(r, now);
    if (s === "done") {
      b.done++;
      b.findings += r.findings ?? 0;
    } else if (s === "failed") b.failed++;
    else b.open++;
  }
  for (const m of rows.runModels) {
    const b = at(m.started_at);
    if (b) b.cost[m.model] = (b.cost[m.model] ?? 0) + m.cost_usd;
  }
  for (const c of rows.counts) {
    const b = series[c.b];
    if (!b || !isCallKind(c.kind)) continue;
    b.calls[c.kind].n += c.n;
    b.calls[c.kind].bad += c.bad;
  }
  const sampled = groupBy(rows.samples, (s) => `${s.kind}\0${slot(s.at)}`);
  for (const [i, b] of series.entries())
    for (const kind of CALL_KINDS)
      b.p95[kind] = percentile(
        (sampled.get(`${kind}\0${i}`) ?? []).map((s) => s.ms),
        95,
      );

  const k = kpis(current, now);
  const started = Number(rows.meta[0]?.v);
  const collectionStartedAt =
    Number.isFinite(started) && started > 0 ? started : null;
  const failed: Partial<Record<FailureClass, number>> = {};
  let noBlockers = 0;
  let changesRequested = 0;
  for (const r of current) {
    const s = shownStatus(r, now);
    if (s === "failed") {
      const f = (r.failure ?? "other") as FailureClass;
      failed[f] = (failed[f] ?? 0) + 1;
    } else if (s === "done") {
      if (r.decision === "changes_requested") changesRequested++;
      else noBlockers++;
    }
  }
  const reached = (kind: string) =>
    rows.reached.find((r) => r.kind === kind)?.n ?? 0;
  const total = (kind: string, name?: string, bad = false) =>
    rows.counts
      .filter((c) => c.kind === kind && (name === undefined || c.name === name))
      .reduce((n, c) => n + (bad ? c.bad : c.n), 0);

  return {
    collectionStartedAt,
    window: { from: q.from, to: q.to, bucketMs: step },
    generatedAt: now,
    kpis: k,
    previous:
      collectionStartedAt !== null && collectionStartedAt <= q.from - span
        ? kpis(before, now)
        : null,
    series,
    models: modelRows(rows.runModels),
    outcomes: { noBlockers, changesRequested, open: k.open, failed },
    durations: durationBins(current),
    funnel: [
      { step: "started", n: k.reviews },
      { step: "scanned", n: reached("modal") },
      { step: "checked_out", n: reached("shell") },
      { step: "verdict", n: k.done },
      { step: "no_blockers", n: noBlockers },
    ],
    verification: verificationTotals(rows.settled),
    tools: toolRows(rows.counts, rows.samples),
    connections: {
      mcpConnects: total("mcp_connect"),
      mcpConnectFailures: total("mcp_connect", undefined, true),
      tokenCacheHits: total("github_token", "hit"),
      tokenCacheMisses: total("github_token", "miss"),
    },
    recoveries: recoveryCounts(rows.recoveries),
    recent: current.slice(0, RECENT).map((r) => runRow(r, now)),
    droppedEvents: rows.dropped[0]?.n ?? 0,
  };
}

export async function dashboardView(
  db: D1Database,
  q: DashboardQuery,
  now: number,
): Promise<DashboardView> {
  const span = q.to - q.from;
  // ?1 from, ?2 to, ?3 owner, ?4 repo (NULL for all), ?5 bucket ms, ?6 previous window start.
  // D1 binds JS numbers as REAL, so integer arithmetic on them needs a CAST.
  const base = [
    q.from,
    q.to,
    q.repo?.owner ?? null,
    q.repo?.repo ?? null,
    bucketMs(span),
    q.from - span,
  ];
  const repoOf = (alias: string) =>
    `(?3 IS NULL OR (${alias}.owner = ?3 AND ${alias}.repo = ?4))`;
  const runWhere = `r.started_at >= ?1 AND r.started_at < ?2 AND ${repoOf("r")}`;
  const eventWhere = `e.at >= ?1 AND e.at < ?2 AND (?3 IS NULL OR EXISTS (
    SELECT 1 FROM runs r WHERE r.object_id = e.object_id AND r.owner = ?3 AND r.repo = ?4))`;
  const ofRunsInWindow = `e.object_id IN (SELECT r.object_id FROM runs r WHERE ${runWhere})`;
  // D1 refuses more bindings than a statement references.
  const stmt = (sql: string) => {
    const used = Math.max(...[...sql.matchAll(/\?(\d)/g)].map((m) => +m[1]));
    return db.prepare(sql).bind(...base.slice(0, used));
  };
  const [
    meta,
    runs,
    runModels,
    counts,
    samples,
    reached,
    settled,
    recoveries,
    dropped,
  ] = await db.batch([
    db.prepare("SELECT v FROM meta WHERE k = 'collection_started_at'"),
    stmt(
      `SELECT r.run_key, r.owner, r.repo, r.number, r.head_sha, r.mode, r.started_at,
         r.last_seen_at, r.ended_at, r.status, r.decision, r.findings, r.failure, r.cost_usd
       FROM runs r WHERE r.started_at >= ?6 AND r.started_at < ?2 AND ${repoOf("r")}
       ORDER BY r.started_at DESC LIMIT ${RUN_LIMIT}`,
    ),
    stmt(
      `SELECT m.model, r.started_at, m.input, m.output, m.cache_read, m.cache_write, m.cost_usd
       FROM run_models m JOIN runs r ON r.object_id = m.object_id WHERE ${runWhere}`,
    ),
    stmt(
      `SELECT e.kind, e.name, CAST((e.at - ?1) / ?5 AS INTEGER) AS b, COUNT(*) AS n, SUM(e.ok = 0) AS bad
       FROM events e WHERE e.kind IN ('shell', 'mcp', 'modal', 'mcp_connect', 'github_token')
         AND ${eventWhere}
       GROUP BY e.kind, e.name, b LIMIT 10000`,
    ),
    stmt(
      `SELECT kind, name, at, ms FROM (
         SELECT e.kind, e.name, e.at, e.ms,
           ROW_NUMBER() OVER (PARTITION BY e.kind ORDER BY e.at DESC) AS rn
         FROM events e WHERE e.kind IN ('shell', 'mcp', 'modal') AND e.ms IS NOT NULL
           AND ${eventWhere}
       ) WHERE rn <= ${SAMPLE}`,
    ),
    stmt(
      `SELECT e.kind, COUNT(DISTINCT e.object_id) AS n FROM events e
       WHERE e.ok = 1 AND ((e.kind = 'modal' AND e.name = 'scan')
         OR (e.kind = 'shell' AND e.name = 'checkout')) AND ${ofRunsInWindow}
       GROUP BY e.kind`,
    ),
    stmt(
      `SELECT e.detail FROM events e
       WHERE e.kind = 'lifecycle' AND e.name IN ('review.done', 'review.failed')
         AND ${ofRunsInWindow} LIMIT ${RUN_LIMIT}`,
    ),
    stmt(
      `SELECT c.object_id, c.detected_at, c.outcome FROM recoveries c
       WHERE c.detected_at >= ?1 AND c.detected_at < ?2 AND (?3 IS NULL OR EXISTS (
         SELECT 1 FROM runs r WHERE r.object_id = c.object_id AND r.owner = ?3 AND r.repo = ?4))
       ORDER BY c.detected_at`,
    ),
    stmt(
      `SELECT SUM(json_extract(e.detail, '$.n')) AS n FROM events e
       WHERE e.kind = 'lifecycle' AND e.name = 'ledger.events_dropped' AND ${eventWhere}`,
    ),
  ]);
  return shapeView(
    q,
    {
      meta: meta.results as DashboardRows["meta"],
      runs: runs.results as DbRun[],
      runModels: runModels.results as DbRunModel[],
      counts: counts.results as DbCount[],
      samples: samples.results as DbSample[],
      reached: reached.results as DbReached[],
      settled: settled.results as DashboardRows["settled"],
      recoveries: recoveries.results as DbRecovery[],
      dropped: dropped.results as DashboardRows["dropped"],
    },
    now,
  );
}

const NO_STORE = { "cache-control": "no-store" };
const JSON_NO_STORE = {
  ...NO_STORE,
  "content-type": "application/json;charset=UTF-8",
};
/** Public endpoint: identical queries in one isolate share a result for a few seconds, so open tabs cannot multiply D1 reads. */
const CACHE_MS = 5_000;
const CACHE_KEYS = 20;
const cache = new Map<string, { at: number; body: string }>();

export async function dashboardApi(
  db: D1Database | undefined,
  url: URL,
): Promise<Response> {
  if (!db)
    return Response.json(
      { error: "ledger not bound" },
      { status: 503, headers: NO_STORE },
    );
  const now = Date.now();
  let q: DashboardQuery;
  try {
    q = parseQuery(url.searchParams, now);
  } catch (error) {
    if (error instanceof QueryError)
      return Response.json(
        { error: error.message },
        { status: 400, headers: NO_STORE },
      );
    throw error;
  }
  try {
    const key = JSON.stringify([q.to - q.from, q.repo]);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS)
      return new Response(hit.body, { headers: JSON_NO_STORE });
    const body = JSON.stringify(await dashboardView(db, q, now));
    if (cache.size >= CACHE_KEYS) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, body });
    return new Response(body, { headers: JSON_NO_STORE });
  } catch (error) {
    console.warn({
      event: "dashboard.query_failed",
      error: String(error).slice(0, 200),
    });
    return Response.json(
      { error: "ledger unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}

/** Deletes events past retention. Run tables are small and kept. */
export async function pruneLedger(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("DELETE FROM events WHERE at < ?")
    .bind(now - RETENTION_MS)
    .run();
}

export function dashboardPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bumble Bot operations</title>
<link rel="icon" href="/favicon.svg?v=bumble-bot" type="image/svg+xml">
<link rel="icon" href="/favicon.ico?v=bumble-bot" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=bumble-bot">
<link rel="stylesheet" href="/review/app.css">
<script type="module" src="/review/dashboard.js"></script>
</head>
<body>
<div id="app"></div>
<noscript>This page needs JavaScript to show the dashboard.</noscript>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}
