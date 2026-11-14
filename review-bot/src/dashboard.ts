// The public operations dashboard: one JSON view over the D1 ledger, and the
// page shell for the Preact client in web/dashboard.tsx. It shows only what
// the ledger holds: ids, enums, counts, times and model usage.

import type { RecoveryOutcome } from "./ledger";
import type { FailureClass } from "./status";

export const STALE_MS = 15 * 60_000;
export const MAX_WINDOW_MS = 30 * 86_400_000;
export const RETENTION_MS = 30 * 86_400_000;
const DEFAULT_WINDOW_MS = 86_400_000;
const PAGE = 50;
const LOG = 200;
const MCP_GROUPS = 50;
/** Call rows read per window for percentiles; more are counted but not ranked. */
const SAMPLE = 5_000;

export type ShownStatus = "done" | "failed" | "running" | "stale";
const SHOWN: readonly ShownStatus[] = ["done", "failed", "running", "stale"];

export type DashboardQuery = {
  from: number;
  to: number;
  status: ShownStatus | null;
  repo: { owner: string; repo: string } | null;
  cursor: { startedAt: number; objectId: string } | null;
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

  const status = params.get("status") || null;
  if (status !== null && !SHOWN.includes(status as ShownStatus))
    throw new QueryError("unknown status");

  const repoRaw = params.get("repo") || null;
  let repo: DashboardQuery["repo"] = null;
  if (repoRaw !== null) {
    const m = /^([\w.-]{1,100})\/([\w.-]{1,100})$/.exec(repoRaw);
    if (!m) throw new QueryError("repo must be owner/name");
    repo = { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
  }

  const cursorRaw = params.get("cursor") || null;
  let cursor: DashboardQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(cursorRaw);
    if (!m) throw new QueryError("bad cursor");
    cursor = { startedAt: Number(m[1]), objectId: m[2] };
  }
  return { from, to, status: status as ShownStatus | null, repo, cursor };
}

export type RunRow = {
  objectId: string;
  runKey: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  mode: "webhook" | "manual";
  model: string | null;
  startedAt: number;
  lastSeenAt: number;
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

export type McpRow = {
  server: string;
  tool: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
};

export type LogRow = {
  at: number;
  runKey: string | null;
  kind: string;
  name: string;
  ok: boolean;
  ms: number | null;
  detail: Record<string, string | number | boolean> | null;
};

export type DashboardView = {
  collectionStartedAt: number | null;
  window: { from: number; to: number };
  generatedAt: number;
  runs: {
    counts: Record<ShownStatus, number>;
    rows: RunRow[];
    next: string | null;
  };
  models: ModelRow[];
  modal: {
    calls: number;
    failed: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  mcp: McpRow[];
  connections: {
    mcpConnects: number;
    mcpConnectFailures: number;
    mcpCalls: number;
    tokenCacheHits: number;
    tokenCacheMisses: number;
  };
  recoveries: Record<RecoveryOutcome | "superseded", number> & {
    detected: number;
  };
  billing: {
    model: "estimate_from_pi_usage";
    cloudflare: "unavailable";
    modal: "unavailable";
    mcp: "unavailable";
  };
  log: LogRow[];
  droppedEvents: number;
};

// Row shapes as D1 returns them.
export type DbRun = {
  object_id: string;
  run_key: string;
  owner: string;
  repo: string;
  number: number;
  head_sha: string;
  mode: string;
  model: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  status: string;
  decision: string | null;
  findings: number | null;
  failure: string | null;
  cost_usd: number;
};
export type DbModel = {
  model: string;
  runs: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
};
export type DbCall = {
  kind: string;
  name: string;
  ok: number;
  ms: number | null;
};
export type DbRecovery = {
  boot_id: string;
  object_id: string;
  detected_at: number;
  outcome: string;
};
export type DbEvent = DbCall & {
  at: number;
  run_key: string | null;
  detail: string | null;
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
    objectId: r.object_id,
    runKey: r.run_key,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    headSha: r.head_sha,
    mode,
    model: r.model,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    endedAt: r.ended_at,
    status: shownStatus(r, now),
    decision: r.decision,
    findings: r.findings,
    failure: r.failure as FailureClass | null,
    costUsd: r.cost_usd,
    link: `/${mode === "manual" ? "m" : "r"}/${r.owner}/${r.repo}/${r.number}?sha=${r.head_sha}`,
  };
}

export function modelRow(m: DbModel): ModelRow {
  const prompt = m.input + m.cache_read + m.cache_write;
  return {
    model: m.model,
    runs: m.runs,
    input: m.input,
    output: m.output,
    cacheRead: m.cache_read,
    cacheWrite: m.cache_write,
    promptCacheHitRatio: prompt > 0 ? m.cache_read / prompt : null,
    costUsd: m.cost_usd,
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

export function mcpRows(calls: readonly DbCall[]): McpRow[] {
  const groups = new Map<string, DbCall[]>();
  for (const c of calls) {
    const group = groups.get(c.name);
    if (group) group.push(c);
    else groups.set(c.name, [c]);
  }
  return [...groups]
    .map(([name, group]) => {
      const slash = name.indexOf("/");
      return {
        server: slash < 0 ? name : name.slice(0, slash),
        tool: slash < 0 ? "" : name.slice(slash + 1),
        calls: group.length,
        errors: group.filter((c) => !c.ok).length,
        p50Ms: percentile(
          group.map((c) => c.ms),
          50,
        ),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server))
    .slice(0, MCP_GROUPS);
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

function parseDetail(raw: string | null): LogRow["detail"] {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as LogRow["detail"]) : null;
  } catch {
    return null;
  }
}

export type DashboardRows = {
  meta: { v: string }[];
  counts: { s: string; n: number }[];
  runs: DbRun[];
  models: DbModel[];
  calls: DbCall[];
  recoveries: DbRecovery[];
  log: DbEvent[];
  dropped: { n: number | null }[];
};

export function shapeView(
  q: DashboardQuery,
  rows: DashboardRows,
  now: number,
): DashboardView {
  const counts: Record<ShownStatus, number> = {
    done: 0,
    failed: 0,
    running: 0,
    stale: 0,
  };
  for (const c of rows.counts)
    if (c.s in counts) counts[c.s as ShownStatus] += c.n;
  const page = rows.runs.slice(0, PAGE);
  const last = page.at(-1);
  const of = (kind: string) => rows.calls.filter((c) => c.kind === kind);
  const modal = of("modal");
  const connects = of("mcp_connect");
  const tokens = of("github_token");
  const started = Number(rows.meta[0]?.v);
  return {
    collectionStartedAt:
      Number.isFinite(started) && started > 0 ? started : null,
    window: { from: q.from, to: q.to },
    generatedAt: now,
    runs: {
      counts,
      rows: page.map((r) => runRow(r, now)),
      next:
        rows.runs.length > PAGE && last
          ? `${last.started_at}.${last.object_id}`
          : null,
    },
    models: rows.models.map(modelRow),
    modal: {
      calls: modal.length,
      failed: modal.filter((c) => !c.ok).length,
      p50Ms: percentile(
        modal.map((c) => c.ms),
        50,
      ),
      p95Ms: percentile(
        modal.map((c) => c.ms),
        95,
      ),
    },
    mcp: mcpRows(of("mcp")),
    connections: {
      mcpConnects: connects.length,
      mcpConnectFailures: connects.filter((c) => !c.ok).length,
      mcpCalls: of("mcp").length,
      tokenCacheHits: tokens.filter((c) => c.name === "hit").length,
      tokenCacheMisses: tokens.filter((c) => c.name === "miss").length,
    },
    recoveries: recoveryCounts(rows.recoveries),
    billing: {
      model: "estimate_from_pi_usage",
      cloudflare: "unavailable",
      modal: "unavailable",
      mcp: "unavailable",
    },
    log: rows.log.map((e) => ({
      at: e.at,
      runKey: e.run_key,
      kind: e.kind,
      name: e.name,
      ok: e.ok === 1,
      ms: e.ms,
      detail: parseDetail(e.detail),
    })),
    droppedEvents: rows.dropped[0]?.n ?? 0,
  };
}

const STATUS_SQL = `CASE WHEN r.status IN ('done', 'failed') THEN r.status
  WHEN r.last_seen_at < ?1 THEN 'stale' ELSE 'running' END`;

export async function dashboardView(
  db: D1Database,
  q: DashboardQuery,
  now: number,
): Promise<DashboardView> {
  // ?1 stale cutoff, ?2 from, ?3 to, ?4 owner, ?5 repo (NULL for all).
  const base = [
    now - STALE_MS,
    q.from,
    q.to,
    q.repo?.owner ?? null,
    q.repo?.repo ?? null,
  ];
  const runWhere = `r.started_at >= ?2 AND r.started_at < ?3 AND (?4 IS NULL OR (r.owner = ?4 AND r.repo = ?5))`;
  const eventWhere = `e.at >= ?2 AND e.at < ?3 AND (?4 IS NULL OR EXISTS (
    SELECT 1 FROM runs r WHERE r.object_id = e.object_id AND r.owner = ?4 AND r.repo = ?5))`;
  const page = `AND (?7 IS NULL OR r.started_at < ?7 OR (r.started_at = ?7 AND r.object_id < ?8))`;
  const stmt = (sql: string, ...extra: unknown[]) =>
    db.prepare(sql).bind(...base, ...extra);
  const [meta, counts, runs, models, calls, recoveries, log, dropped] =
    await db.batch([
      db.prepare("SELECT v FROM meta WHERE k = 'collection_started_at'"),
      stmt(
        `SELECT ${STATUS_SQL} AS s, COUNT(*) AS n FROM runs r WHERE ${runWhere} GROUP BY s`,
      ),
      stmt(
        `SELECT r.* FROM runs r WHERE ${runWhere} AND (?6 IS NULL OR ${STATUS_SQL} = ?6) ${page}
       ORDER BY r.started_at DESC, r.object_id DESC LIMIT ${PAGE + 1}`,
        q.status,
        q.cursor?.startedAt ?? null,
        q.cursor?.objectId ?? null,
      ),
      stmt(
        `SELECT m.model, COUNT(*) AS runs, SUM(m.input) AS input, SUM(m.output) AS output,
         SUM(m.cache_read) AS cache_read, SUM(m.cache_write) AS cache_write, SUM(m.cost_usd) AS cost_usd
       FROM run_models m JOIN runs r ON r.object_id = m.object_id
       WHERE ${runWhere} GROUP BY m.model ORDER BY cost_usd DESC`,
      ),
      stmt(
        `SELECT e.kind, e.name, e.ok, e.ms FROM events e
       WHERE e.kind IN ('modal', 'mcp', 'mcp_connect', 'github_token') AND ${eventWhere}
       ORDER BY e.at DESC LIMIT ${SAMPLE}`,
      ),
      stmt(
        `SELECT c.boot_id, c.object_id, c.detected_at, c.outcome FROM recoveries c
       WHERE c.detected_at >= ?2 AND c.detected_at < ?3 AND (?4 IS NULL OR EXISTS (
         SELECT 1 FROM runs r WHERE r.object_id = c.object_id AND r.owner = ?4 AND r.repo = ?5))
       ORDER BY c.detected_at`,
      ),
      stmt(
        `SELECT e.at, r.run_key, e.kind, e.name, e.ok, e.ms, e.detail FROM events e
       LEFT JOIN runs r ON r.object_id = e.object_id
       WHERE ${eventWhere} ORDER BY e.at DESC, e.id DESC LIMIT ${LOG}`,
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
      counts: counts.results as DashboardRows["counts"],
      runs: runs.results as DbRun[],
      models: models.results as DbModel[],
      calls: calls.results as DbCall[],
      recoveries: recoveries.results as DbRecovery[],
      log: log.results as DbEvent[],
      dropped: dropped.results as DashboardRows["dropped"],
    },
    now,
  );
}

const NO_STORE = { "cache-control": "no-store" };

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
    return Response.json(await dashboardView(db, q, now), {
      headers: NO_STORE,
    });
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
