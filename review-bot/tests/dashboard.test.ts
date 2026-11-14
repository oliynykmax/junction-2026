import { expect, test } from "bun:test";
import {
  bucketMs,
  type DashboardRows,
  type DbRun,
  MAX_WINDOW_MS,
  modelRows,
  parseQuery,
  percentile,
  QueryError,
  recoveryCounts,
  shapeView,
  STALE_MS,
} from "../src/dashboard";

const now = 1_800_000_000_000;
const HOUR = 3_600_000;
const q = (s: string) => parseQuery(new URLSearchParams(s), now);

test("defaults to the last 24 hours across all repositories", () => {
  expect(q("")).toEqual({ from: now - 24 * HOUR, to: now, repo: null });
});

test("parses a window and a repository filter", () => {
  expect(q("from=1&to=2&repo=Oliynykmax/Junction-2026")).toEqual({
    from: 1,
    to: 2,
    repo: { owner: "oliynykmax", repo: "junction-2026" },
  });
});

test("rejects out-of-bounds or malformed queries", () => {
  for (const bad of [
    `from=0&to=${MAX_WINDOW_MS + 1}`,
    "from=5&to=5",
    "from=-1",
    "to=1e9",
    "repo=a/b/c",
    "repo=a';--/b",
  ])
    expect(() => q(bad)).toThrow(QueryError);
});

test("buckets keep every window at 36 bars or fewer", () => {
  expect(bucketMs(HOUR)).toBe(5 * 60_000);
  expect(bucketMs(24 * HOUR)).toBe(HOUR);
  expect(bucketMs(7 * 24 * HOUR)).toBe(6 * HOUR);
  expect(bucketMs(30 * 24 * HOUR)).toBe(24 * HOUR);
});

const run = (over: Partial<DbRun>): DbRun => ({
  run_key: "o/r#1@sha",
  owner: "o",
  repo: "r",
  number: 1,
  head_sha: "a".repeat(40),
  mode: "webhook",
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
  runs: [],
  runModels: [],
  counts: [],
  samples: [],
  reached: [],
  settled: [],
  recoveries: [],
  dropped: [{ n: null }],
};

const done = (startedAgo: number, minutes: number, over: Partial<DbRun> = {}) =>
  run({
    started_at: now - startedAgo,
    ended_at: now - startedAgo + minutes * 60_000,
    status: "done",
    decision: "no_blockers_found",
    findings: 2,
    cost_usd: 0.5,
    ...over,
  });

test("a running row last seen over 15 minutes ago is open, not failed", () => {
  const view = shapeView(
    q(""),
    { ...empty, runs: [run({ last_seen_at: now - STALE_MS - 1 })] },
    now,
  );
  expect(view.recent[0].status).toBe("stale");
  expect(view.kpis).toMatchObject({ reviews: 1, open: 1, failed: 0 });
  expect(view.series.at(-1)).toMatchObject({ open: 1, failed: 0 });
});

test("links each run to its report page by mode", () => {
  const view = shapeView(
    q(""),
    { ...empty, runs: [run({}), run({ mode: "manual" })] },
    now,
  );
  expect(view.recent.map((r) => r.link)).toEqual([
    `/r/o/r/1?sha=${"a".repeat(40)}`,
    `/m/o/r/1?sha=${"a".repeat(40)}`,
  ]);
});

test("places runs and their cost in the bucket they started in", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      runs: [
        done(30 * 60_000, 5),
        done(3 * HOUR + 2, 12),
        run({
          started_at: now - 3 * HOUR - 1,
          status: "failed",
          failure: "scanner",
        }),
      ],
      runModels: [
        {
          model: "a/x",
          started_at: now - 30 * 60_000,
          input: 1,
          output: 1,
          cache_read: 0,
          cache_write: 0,
          cost_usd: 0.25,
        },
      ],
    },
    now,
  );
  expect(view.series).toHaveLength(24);
  expect(view.window.bucketMs).toBe(HOUR);
  expect(view.series[23]).toMatchObject({
    done: 1,
    findings: 2,
    cost: { "a/x": 0.25 },
  });
  expect(view.series[20]).toMatchObject({ done: 1, failed: 1 });
  expect(view.kpis).toMatchObject({
    reviews: 3,
    done: 2,
    failed: 1,
    findings: 4,
  });
  expect(view.outcomes).toEqual({
    noBlockers: 2,
    changesRequested: 0,
    open: 0,
    failed: { scanner: 1 },
  });
});

test("compares with the previous window only when the ledger was collecting then", () => {
  const rows = {
    ...empty,
    runs: [done(HOUR, 3), done(25 * HOUR, 9), done(26 * HOUR, 9)],
  };
  const view = shapeView(q(""), rows, now);
  expect(view.kpis.reviews).toBe(1);
  expect(view.previous).toMatchObject({ reviews: 2, medianMs: 9 * 60_000 });
  const fresh = shapeView(
    q(""),
    { ...rows, meta: [{ v: String(now - 30 * HOUR) }] },
    now,
  );
  expect(fresh.previous).toBeNull();
});

test("bins done runs by time to verdict, with an open last bin", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      runs: [done(HOUR, 1), done(HOUR, 3), done(HOUR, 3.5), done(HOUR, 90)],
    },
    now,
  );
  expect(view.durations[0]).toEqual({ toMs: 2 * 60_000, n: 1 });
  expect(view.durations[1]).toEqual({ toMs: 4 * 60_000, n: 2 });
  expect(view.durations.at(-1)).toEqual({ toMs: null, n: 1 });
  expect(view.kpis.medianMs).toBe(3 * 60_000);
});

test("the funnel counts runs that reached each step", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      runs: [
        done(HOUR, 3),
        done(HOUR, 3, { decision: "changes_requested" }),
        run({}),
      ],
      reached: [
        { kind: "modal", n: 3 },
        { kind: "shell", n: 2 },
      ],
    },
    now,
  );
  expect(view.funnel).toEqual([
    { step: "started", n: 3 },
    { step: "scanned", n: 3 },
    { step: "checked_out", n: 2 },
    { step: "verdict", n: 2 },
    { step: "no_blockers", n: 1 },
  ]);
});

test("sums verification receipts from terminal status events, skipping runs that predate them", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      settled: [
        {
          detail: JSON.stringify({ passed: 2, counterexample: 1, not_run: 3 }),
        },
        {
          detail: JSON.stringify({ passed: 1, counterexample: 0, not_run: 0 }),
        },
        { detail: JSON.stringify({ failure: "scanner" }) },
        { detail: null },
        { detail: "not json" },
      ],
    },
    now,
  );
  expect(view.verification).toEqual({
    passed: 3,
    counterexample: 1,
    not_run: 3,
    runs: 2,
  });
});

test("tool rows take exact counts across buckets and latency from the sample", () => {
  const view = shapeView(
    q(""),
    {
      ...empty,
      counts: [
        { kind: "shell", name: "command", b: 22, n: 9_000, bad: 3 },
        { kind: "shell", name: "command", b: 23, n: 1_000, bad: 1 },
        { kind: "mcp", name: "mslearn/search", b: 23, n: 4, bad: 0 },
        { kind: "github_token", name: "hit", b: 23, n: 50, bad: 0 },
      ],
      samples: [
        { kind: "shell", name: "command", at: now - 10, ms: 100 },
        { kind: "shell", name: "command", at: now - 20, ms: 900 },
      ],
    },
    now,
  );
  expect(view.tools).toEqual([
    {
      kind: "shell",
      name: "command",
      calls: 10_000,
      errors: 4,
      p50Ms: 100,
      p95Ms: 900,
    },
    {
      kind: "mcp",
      name: "mslearn/search",
      calls: 4,
      errors: 0,
      p50Ms: null,
      p95Ms: null,
    },
  ]);
  expect(view.series[22].calls.shell).toEqual({ n: 9_000, bad: 3 });
  expect(view.series[23].p95.shell).toBe(900);
  expect(view.series[23].p95.mcp).toBeNull();
  expect(view.connections.tokenCacheHits).toBe(50);
});

test("reports collection start honestly, null when unknown", () => {
  expect(shapeView(q(""), empty, now).collectionStartedAt).toBe(
    now - 5 * 86_400_000,
  );
  expect(
    shapeView(q(""), { ...empty, meta: [] }, now).collectionStartedAt,
  ).toBeNull();
});

test("models aggregate per-run usage; cache share is cache reads over all prompt tokens", () => {
  const m = {
    model: "x",
    started_at: now,
    input: 50,
    output: 5,
    cache_read: 150,
    cache_write: 50,
    cost_usd: 1,
  };
  const [row] = modelRows([m, m]);
  expect(row).toMatchObject({
    runs: 2,
    input: 100,
    cacheRead: 300,
    costUsd: 2,
  });
  expect(row.promptCacheHitRatio).toBe(0.6);
  expect(
    modelRows([{ ...m, input: 0, cache_read: 0, cache_write: 0 }])[0]
      .promptCacheHitRatio,
  ).toBeNull();
});

test("nearest-rank percentiles ignore missing durations", () => {
  expect(percentile([], 50)).toBeNull();
  expect(percentile([null, 30, 10, 20], 50)).toBe(20);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
});

test("an open recovery followed by a later detection on the same object is superseded", () => {
  expect(
    recoveryCounts([
      { object_id: "x", detected_at: 1, outcome: "open" },
      { object_id: "x", detected_at: 2, outcome: "recovered" },
      { object_id: "y", detected_at: 3, outcome: "open" },
      { object_id: "z", detected_at: 4, outcome: "unverified" },
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

test("flags a run read that hit its cap so the page can say figures are partial", () => {
  expect(shapeView(q(""), empty, now).truncated).toBeNull();
  const runs = Array.from({ length: 5_000 }, () => done(HOUR, 3));
  expect(shapeView(q(""), { ...empty, runs }, now).truncated).toBe(5_000);
});
