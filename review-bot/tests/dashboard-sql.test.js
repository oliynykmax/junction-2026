import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dashboardView, parseQuery } from "../src/dashboard";

// D1 binds numbers as REAL and rejects surplus parameters. Keep both constraints.
function d1(sqlite) {
  return {
    prepare(sql) {
      const count = Math.max(
        0,
        ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])),
      );
      const statement = (values) => ({
        results: () =>
          sqlite
            .prepare(
              sql.replace(/\?(\d+)/g, (parameter, index) =>
                typeof values[Number(index) - 1] === "number"
                  ? `CAST(${parameter} AS REAL)`
                  : parameter,
              ),
            )
            .all(...values),
        bind(...values) {
          expect(values).toHaveLength(count);
          return statement(values);
        },
      });
      return statement([]);
    },
    async batch(statements) {
      return statements.map((s) => ({ results: s.results() }));
    },
  };
}

test("dashboard SQL selects windows, filters joined rows and buckets persisted events", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(
      await Bun.file(
        new URL("../migrations/0001_ledger.sql", import.meta.url),
      ).text(),
    );
    const from = 1_800_000_000_000;
    const hour = 3_600_000;
    const to = from + 24 * hour;
    const previous = from - 24 * hour;
    sqlite.run("UPDATE meta SET v = ? WHERE k = 'collection_started_at'", [
      String(previous),
    ]);
    const run = (id, start, owner = "Team", repo = "Demo") => {
      sqlite.run(
        `INSERT INTO runs (object_id, run_key, owner, repo, number, head_sha, mode,
        started_at, last_seen_at, ended_at, status, decision, findings, cost_usd)
        VALUES (?, ?, ?, ?, 1, 'sha', 'webhook', ?, ?, ?, 'done', 'no_blockers_found', 2, 0.5)`,
        [id, id, owner, repo, start, start + 60_000, start + 60_000],
      );
      sqlite.run(
        "INSERT INTO run_models VALUES (?, 'model', 10, 20, 0, 0, 0.5)",
        [id],
      );
    };
    const event = (id, at, kind, name, ok = 1, detail = null) =>
      sqlite.run(
        "INSERT INTO events (object_id, at, boot_id, kind, name, ok, ms, detail) VALUES (?, ?, 'boot', ?, ?, ?, 100, ?)",
        [
          id,
          at,
          kind,
          name,
          ok,
          detail === null ? null : JSON.stringify(detail),
        ],
      );
    run("old", previous - 1);
    run("previous", previous);
    run("previous-end", from - 1);
    run("current", from);
    run("current-end", to - 1);
    run("next", to);
    run("other-owner", from, "Other", "Demo");
    run("other-repo", from, "Team", "Other");
    for (const id of [
      "old",
      "previous",
      "previous-end",
      "current",
      "current-end",
      "next",
      "other-owner",
      "other-repo",
    ]) {
      event(id, from, "modal", "scan");
      event(id, from, "shell", "checkout");
      event(id, to + 1, "lifecycle", "review.done", 1, {
        passed: 2,
        counterexample: 1,
        not_run: 3,
      });
    }
    for (const at of [
      from - 1,
      from,
      from + hour - 1,
      from + hour,
      to - 1,
      to,
    ]) {
      event("current", at, "shell", "command", 0);
    }
    event("orphan", from, "shell", "command");
    event("current", from, "lifecycle", "ledger.events_dropped", 1, { n: 4 });
    sqlite.run(
      "INSERT INTO recoveries (boot_id, object_id, detected_at, tasks, scan_complete, outcome) VALUES ('boot', 'current', ?, 1, 1, 'recovered')",
      [from],
    );
    const query = parseQuery(
      new URLSearchParams({
        from: String(from),
        to: String(to),
        repo: "TEAM/DEMO",
      }),
      to,
    );
    const view = await dashboardView(d1(sqlite), query, to);
    expect(view.kpis).toMatchObject({
      reviews: 2,
      done: 2,
      costUsd: 1,
      findings: 4,
    });
    expect(view.previous).toMatchObject({ reviews: 2, done: 2, costUsd: 1 });
    expect(view.recent.map((r) => r.runKey)).toEqual([
      "current-end",
      "current",
    ]);
    expect(view.models).toMatchObject([
      { model: "model", runs: 2, input: 20, output: 40, costUsd: 1 },
    ]);
    expect(view.series).toHaveLength(24);
    expect(view.series[0]).toMatchObject({
      done: 1,
      cost: { model: 0.5 },
      calls: { shell: { n: 8, bad: 2 } },
    });
    expect(view.series[1].calls.shell).toEqual({ n: 1, bad: 1 });
    expect(view.series[23]).toMatchObject({
      done: 1,
      calls: { shell: { n: 1, bad: 1 } },
    });
    expect(view.series[0].p95.shell).toBe(100);
    expect(view.tools.find((t) => t.name === "command")).toEqual({
      kind: "shell",
      name: "command",
      calls: 4,
      errors: 4,
      p50Ms: 100,
      p95Ms: 100,
    });
    expect(view.funnel.map((s) => s.n)).toEqual([2, 2, 2, 2, 2]);
    expect(view.verification).toEqual({
      runs: 2,
      passed: 4,
      counterexample: 2,
      not_run: 6,
    });
    expect(view.droppedEvents).toBe(4);
    expect(view.recoveries).toMatchObject({ detected: 1, recovered: 1 });
    const all = await dashboardView(d1(sqlite), { ...query, repo: null }, to);
    expect(all.kpis.reviews).toBe(4);
    expect(all.previous.reviews).toBe(2);
    expect(all.funnel.map((s) => s.n)).toEqual([4, 4, 4, 4, 4]);
    expect(all.verification).toEqual({
      runs: 4,
      passed: 8,
      counterexample: 4,
      not_run: 12,
    });
    expect(all.tools.find((t) => t.name === "command")).toMatchObject({
      calls: 5,
      errors: 4,
    });
  } finally {
    sqlite.close();
  }
});
