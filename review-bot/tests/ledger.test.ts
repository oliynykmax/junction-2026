import { expect, test } from "bun:test";
import { Ledger, resolveRecovery, type RunSnapshot } from "../src/ledger";

type Call = { sql: string; values: unknown[] };

function fakeDb(fail = false) {
  const batches: Call[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({ sql, values }),
    }),
    batch: async (statements: Call[]) => {
      if (fail) throw new Error("D1 down");
      batches.push(statements);
      return [];
    },
  };
  return { db: db as unknown as D1Database, batches };
}

function ledger(db: D1Database | undefined) {
  const pending: Promise<unknown>[] = [];
  const l = new Ledger(db, { objectId: "obj", bootId: "boot" }, (p) =>
    pending.push(p),
  );
  return { l, settled: () => Promise.all(pending) };
}

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runKey: "o/r#1@sha",
  target: {
    owner: "o",
    repo: "r",
    number: 1,
    headSha: "sha",
    installationId: 1,
  },
  model: "anthropic/m",
  startedAt: 1,
  status: "running",
  decision: null,
  findings: 0,
  failure: null,
  usage: [],
  ...over,
});

const event = { kind: "mcp", name: "s/t", ok: true, ms: 5 } as const;

test("recovery resolution", () => {
  const r = { tasks: 2, scanComplete: true, endedOk: 2, endedBad: 0 };
  expect(resolveRecovery(r, "done")).toBe("recovered");
  expect(resolveRecovery({ ...r, endedOk: 1 }, "done")).toBe("unverified");
  expect(resolveRecovery({ ...r, scanComplete: false }, "done")).toBe(
    "unverified",
  );
  expect(resolveRecovery({ ...r, endedBad: 1 }, "done")).toBe("failed");
  expect(resolveRecovery(r, "failed")).toBe("failed");
  expect(resolveRecovery(r, "running")).toBe("open");
});

test("with no binding every call is a silent no-op", async () => {
  const { l, settled } = ledger(undefined);
  l.event(event);
  l.record(async () => snapshot());
  l.flush();
  await settled();
});

test("a failing database never throws into the review", async () => {
  const { db } = fakeDb(true);
  const { l, settled } = ledger(db);
  expect(() => {
    l.record(async () => snapshot());
    l.event(event);
    l.flush();
  }).not.toThrow();
  await settled();
});

test("events buffer until 20, then flush in one batch with a last_seen touch", async () => {
  const { db, batches } = fakeDb();
  const { l, settled } = ledger(db);
  for (let i = 0; i < 19; i++) l.event(event);
  await settled();
  expect(batches).toHaveLength(0);
  l.event(event);
  await settled();
  expect(batches).toHaveLength(1);
  expect(
    batches[0].filter((s) => s.sql.startsWith("INSERT INTO events")),
  ).toHaveLength(20);
  expect(batches[0].at(-1)?.sql).toStartWith("UPDATE runs SET last_seen_at");
});

test("an identical snapshot is written once; a terminal one upserts usage and a status event", async () => {
  const { db, batches } = fakeDb();
  const { l, settled } = ledger(db);
  l.record(async () => snapshot());
  l.record(async () => snapshot());
  await settled();
  expect(batches).toHaveLength(1);
  const usage = [
    {
      model: "m",
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      costUsd: 0.5,
    },
  ];
  l.record(async () =>
    snapshot({ status: "done", decision: "no_blockers_found", usage }),
  );
  await settled();
  const [event, run, models] = batches[1];
  expect(event.sql).toContain("WHERE NOT EXISTS");
  expect(event.values).toContain("review.done");
  expect(run.sql).toStartWith("INSERT INTO runs");
  expect(models.sql).toStartWith("INSERT INTO run_models");
  expect(models.sql).toContain("ON CONFLICT (object_id, model)");
});

test("a null snapshot writes nothing", async () => {
  const { db, batches } = fakeDb();
  const { l, settled } = ledger(db);
  l.record(async () => null);
  await settled();
  expect(batches).toHaveLength(0);
});

test("events past the boot cap are dropped and counted, never stored", async () => {
  const { db, batches } = fakeDb();
  const { l, settled } = ledger(db);
  for (let i = 0; i < 510; i++) l.event(event);
  l.flush();
  await settled();
  const inserts = batches
    .flat()
    .filter((s) => s.sql.startsWith("INSERT INTO events"));
  expect(inserts.filter((s) => s.values.includes("s/t"))).toHaveLength(500);
  const drop = inserts.find((s) => s.values.includes("ledger.events_dropped"));
  expect(drop?.values.at(-1)).toBe(JSON.stringify({ n: 10 }));
});

test("recovery detection writes an open row, and a done settle resolves it", async () => {
  const { db, batches } = fakeDb();
  const { l, settled } = ledger(db);
  const ids = { objectId: "obj", bootId: "boot" };
  l.lifecycle({
    ...ids,
    event: "review.recovery_detected",
    scanComplete: true,
    tasks: [{ taskId: 1, taskName: "t", taskPhase: null, restarts: 0 }],
  });
  l.lifecycle({
    ...ids,
    event: "review.recovery_task_ended",
    taskId: 1,
    taskName: "t",
    outcome: "done",
    status: "ok",
  });
  l.record(async () => snapshot({ status: "done" }));
  await settled();
  const rows = batches
    .flat()
    .filter((s) => s.sql.startsWith("INSERT INTO recoveries"));
  expect(rows.map((r) => r.values.at(-1))).toEqual(["open", "recovered"]);
});
