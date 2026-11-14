import { expect, test } from "bun:test";
import {
  type DashboardRows,
  type DbRun,
  MAX_WINDOW_MS,
  mcpRows,
  modelRow,
  parseQuery,
  percentile,
  QueryError,
  recoveryCounts,
  shapeView,
  STALE_MS,
} from "../src/dashboard";

const now = 1_800_000_000_000;
const q = (s: string) => parseQuery(new URLSearchParams(s), now);
const oid = "f".repeat(64);

test("defaults to the last 24 hours with no filters", () => {
  expect(q("")).toEqual({
    from: now - 86_400_000,
    to: now,
    status: null,
    repo: null,
    cursor: null,
  });
});

test("parses filters and a cursor", () => {
  expect(
    q(
      `from=1&to=2&status=stale&repo=Oliynykmax/Junction-2026&cursor=123.${oid}`,
    ),
  ).toEqual({
    from: 1,
    to: 2,
    status: "stale",
    repo: { owner: "oliynykmax", repo: "junction-2026" },
    cursor: { startedAt: 123, objectId: oid },
  });
});

test("rejects out-of-bounds or malformed queries", () => {
  for (const bad of [
    `from=0&to=${MAX_WINDOW_MS + 1}`,
    "from=5&to=5",
    "from=-1",
    "to=1e9",
    "status=pending",
    "repo=a/b/c",
    "repo=a';--/b",
    "cursor=1.xyz",
  ])
    expect(() => q(bad)).toThrow(QueryError);
});

const run = (over: Partial<DbRun>): DbRun => ({
  object_id: oid,
  run_key: "o/r#1@sha",
  owner: "o",
  repo: "r",
  number: 1,
  head_sha: "a".repeat(40),
  mode: "webhook",
  model: "anthropic/m",
  started_at: now - 60_000,
  last_seen_at: now - 1_000,
  ended_at: null,
  status: "running",
  decision: null,
  findings: null,
  failure: null,
  cost_usd: 0,
  ...over,
});

const empty: DashboardRows = {
  meta: [{ v: String(now - 5 * 86_400_000) }],
  counts: [],
  runs: [],
  models: [],
  calls: [],
  recoveries: [],
  log: [],
  dropped: [{ n: null }],
};

test("a running row last seen over 15 minutes ago shows as stale, not failed", () => {
  const view = shapeView(
    q(""),
    { ...empty, runs: [run({ last_seen_at: now - STALE_MS - 1 })] },
    now,
  );
  expect(view.runs.rows[0].status).toBe("stale");
});

test("links each run to its report page by mode", () => {
  const view = shapeView(
    q(""),
    { ...empty, runs: [run({}), run({ mode: "manual" })] },
    now,
  );
  expect(view.runs.rows.map((r) => r.link)).toEqual([
    `/r/o/r/1?sha=${"a".repeat(40)}`,
    `/m/o/r/1?sha=${"a".repeat(40)}`,
  ]);
});

test("pages at 50 rows with a keyset cursor from the last shown row", () => {
  const runs = Array.from({ length: 51 }, (_, i) =>
    run({ object_id: i.toString(16).padStart(64, "0"), started_at: now - i }),
  );
  const view = shapeView(q(""), { ...empty, runs }, now);
  expect(view.runs.rows).toHaveLength(50);
  expect(view.runs.next).toBe(
    `${now - 49}.${(49).toString(16).padStart(64, "0")}`,
  );
  expect(
    shapeView(q(""), { ...empty, runs: runs.slice(0, 50) }, now).runs.next,
  ).toBeNull();
});

test("reports collection start honestly, null when unknown", () => {
  expect(shapeView(q(""), empty, now).collectionStartedAt).toBe(
    now - 5 * 86_400_000,
  );
  expect(
    shapeView(q(""), { ...empty, meta: [] }, now).collectionStartedAt,
  ).toBeNull();
});

test("prompt cache share is cache reads over all prompt tokens, null without any", () => {
  const m = {
    model: "x",
    runs: 1,
    input: 100,
    output: 5,
    cache_read: 300,
    cache_write: 100,
    cost_usd: 1,
  };
  expect(modelRow(m).promptCacheHitRatio).toBe(0.6);
  expect(
    modelRow({ ...m, input: 0, cache_read: 0, cache_write: 0 })
      .promptCacheHitRatio,
  ).toBeNull();
});

test("nearest-rank percentiles ignore missing durations", () => {
  expect(percentile([], 50)).toBeNull();
  expect(percentile([null, 30, 10, 20], 50)).toBe(20);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
});

test("groups MCP calls by server and tool, busiest first", () => {
  const rows = mcpRows([
    { kind: "mcp", name: "mslearn/search", ok: 1, ms: 100 },
    { kind: "mcp", name: "contextdev/web-search", ok: 0, ms: 300 },
    { kind: "mcp", name: "contextdev/web-search", ok: 1, ms: 200 },
  ]);
  expect(rows).toEqual([
    {
      server: "contextdev",
      tool: "web-search",
      calls: 2,
      errors: 1,
      p50Ms: 200,
    },
    { server: "mslearn", tool: "search", calls: 1, errors: 0, p50Ms: 100 },
  ]);
});

test("summarizes calls, token cache and dropped events", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      calls: [
        { kind: "modal", name: "scan", ok: 1, ms: 1000 },
        { kind: "modal", name: "scan", ok: 0, ms: 3000 },
        { kind: "mcp_connect", name: "mslearn", ok: 0, ms: 8000 },
        { kind: "github_token", name: "hit", ok: 1, ms: 0 },
        { kind: "github_token", name: "miss", ok: 1, ms: 200 },
        { kind: "github_token", name: "hit", ok: 1, ms: 0 },
      ],
      dropped: [{ n: 7 }],
    },
    now,
  );
  expect(view.modal).toEqual({ calls: 2, failed: 1, p50Ms: 1000, p95Ms: 3000 });
  expect(view.connections).toEqual({
    mcpConnects: 1,
    mcpConnectFailures: 1,
    mcpCalls: 0,
    tokenCacheHits: 2,
    tokenCacheMisses: 1,
  });
  expect(view.droppedEvents).toBe(7);
  expect(view.billing.modal).toBe("unavailable");
});

test("an open recovery followed by a later detection on the same object is superseded", () => {
  expect(
    recoveryCounts([
      { boot_id: "b1", object_id: "x", detected_at: 1, outcome: "open" },
      { boot_id: "b2", object_id: "x", detected_at: 2, outcome: "recovered" },
      { boot_id: "b3", object_id: "y", detected_at: 3, outcome: "open" },
      { boot_id: "b4", object_id: "z", detected_at: 4, outcome: "unverified" },
    ]),
  ).toEqual({
    detected: 4,
    open: 1,
    recovered: 1,
    failed: 0,
    unverified: 1,
    superseded: 1,
  });
});
