#!/usr/bin/env node
// Profiles the Review Durable Object's storage writes on local workerd, fully
// offline (fixtures in profile-writes/worker.ts). Runs a mocked review
// lifecycle and a mid-run eviction recovery, and prints a JSON profile:
// SQLite cursor row counters per phase, table and statement, alarm calls,
// and work assertions.
//
//   node scripts/profile-writes.mjs [--label name] [--repeats n] [--out file]
//
// Node, not Bun: wrangler cannot forward requests to the local Worker under Bun.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { unstable_startWorker } from "wrangler";

const { values: args } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    repeats: { type: "string", default: "1" },
    out: { type: "string" },
    "allow-idle-alarm": { type: "boolean", default: false },
  },
});

const here = new URL(".", import.meta.url).pathname;
const git = (...a) =>
  execFileSync("git", a, { cwd: here, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worker = await unstable_startWorker({
  config: `${here}profile-writes/wrangler.jsonc`,
  dev: { inspector: false, persist: false, logLevel: "error" },
});
await worker.ready;
const base = await worker.url;

async function call(path) {
  const res = await fetch(new URL(path, base));
  const body = await res.json();
  if (!res.ok)
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const newHead = () =>
  [...crypto.getRandomValues(new Uint8Array(20))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function review(head) {
  const at = (action, phase) =>
    call(`/review/${action}/${head}${phase ? `?phase=${phase}` : ""}`);
  return {
    start: (phase) => at("start", phase),
    view: (phase) => at("view", phase),
    alarm: (phase) => at("alarm", phase),
    evict: () => at("evict"),
    drain: () => at("drain"),
    storedAlarm: () => at("stored-alarm"),
    async settle(phase) {
      for (let i = 0; i < 400; i++) {
        const v = await at("probe", phase);
        if (v.status !== "running" && v.status !== "scanning") return v;
        await sleep(50);
      }
      throw new Error(`review ${head} did not settle`);
    },
  };
}

function work(view, fixture, storedAlarm) {
  return {
    status: view.status,
    failure: view.failure,
    findings: view.review.findings.length,
    lookups: view.review.lookups.length,
    verdict: view.review.verdict?.decision ?? null,
    scan: view.review.scan?.status ?? null,
    activity: view.activity.length,
    requests: fixture.requests,
    unexpected: fixture.unexpected,
    storedAlarm: storedAlarm === null ? null : "set",
  };
}

async function lifecycle() {
  await call("/fixture/reset");
  const head = newHead();
  const r = review(head);
  const tallies = [];
  const alarms = [];
  const drained = (d) => {
    tallies.push(...d.tallies);
    alarms.push(...d.alarms);
  };
  const alarmAfter = {};
  const after = async (phase) => {
    await sleep(100);
    alarmAfter[phase] = (await r.storedAlarm()) === null ? null : "set";
  };
  await r.start("start");
  await r.settle("start");
  await after("start");
  await r.start("repeat-start");
  await after("repeat-start");
  for (let i = 0; i < 3; i++) await r.view("view-warm");
  await after("view-warm");
  drained(await r.drain());
  await r.evict();
  await r.view("view-cold");
  await after("view-cold");
  await r.view("view-after-cold");
  await r.alarm("alarm-after-done");
  await after("alarm-after-done");
  drained(await r.drain());
  await r.evict();
  await r.alarm("cold-alarm-after-done");
  await after("cold-alarm-after-done");
  const stored = await r.storedAlarm();
  const final = await r.view("final-check");
  drained(await r.drain());
  return {
    scenario: "lifecycle",
    events: await call("/fixture/events"),
    head,
    alarmAfter,
    alarms,
    tallies,
    work: work(final, await call("/fixture/state"), stored),
  };
}

async function recovery() {
  await call("/fixture/reset");
  await call("/fixture/hang?turn=3");
  const head = newHead();
  const r = review(head);
  const tallies = [];
  const alarms = [];
  const drained = (d) => {
    tallies.push(...d.tallies);
    alarms.push(...d.alarms);
  };
  await r.start("before-eviction");
  for (let i = 0; !(await call("/fixture/state")).hung; i++) {
    if (i > 400) throw new Error("model never reached the hang turn");
    await sleep(25);
  }
  await sleep(100);
  const alarmAtEviction = (await r.storedAlarm()) === null ? null : "set";
  drained(await r.drain());
  await r.evict();
  await r.alarm("recovery");
  await r.settle("recovery");
  const stored = await r.storedAlarm();
  const final = await r.view("final-check");
  drained(await r.drain());
  return {
    scenario: "recovery",
    alarmAfter: { "before-eviction": alarmAtEviction },
    events: await call("/fixture/events"),
    head,
    alarms,
    tallies,
    work: work(final, await call("/fixture/state"), stored),
  };
}

function checks(run) {
  const failed = [];
  const expect = (ok, what) => ok || failed.push(what);
  const of = (name, phase) =>
    run.events.filter((e) => e.event === name && (!phase || e.phase === phase));
  const w = run.work;
  expect(
    w.status === "done" && w.findings === 2 && w.lookups === 2,
    "review completed with 2 findings and 2 lookups",
  );
  expect(w.unexpected.length === 0, "no request left the fixtures");
  expect(
    args["allow-idle-alarm"] || w.storedAlarm === null,
    "no alarm remains after the review is finished",
  );
  expect(
    w.requests.model === (run.scenario === "lifecycle" ? 5 : 6),
    "the scripted model ran each turn once, plus the hung turn's retry",
  );
  expect(of("review.finished").length === 1, "the verdict is logged once");
  if (run.scenario === "lifecycle") {
    for (const name of [
      "review.recovery_detected",
      "review.recovery_phase",
      "review.recovery_task_ended",
    ])
      expect(of(name).length === 0, `no ${name} without an interruption`);
    const coldBoots = of("review.boot", "view-cold");
    expect(
      coldBoots.length === 1 && coldBoots[0].interruptedTasks === 0,
      "a cold read of a finished review boots with no interrupted task",
    );
    expect(
      of("review.alarm", "alarm-after-done").length === 1,
      "a warm alarm after completion is logged as an alarm, not a recovery",
    );
    expect(
      of("review.boot", "cold-alarm-after-done").every(
        (e) => e.interruptedTasks === 0,
      ),
      "a cold alarm after completion finds no interrupted task",
    );
  } else {
    expect(
      of("review.recovery_detected", "before-eviction").length === 0,
      "the first boot detects nothing",
    );
    const detected = of("review.recovery_detected", "recovery");
    expect(
      detected.length === 1 && detected[0].tasks.length >= 1,
      "the boot after eviction detects the interrupted task",
    );
    const ids = new Set(detected.flatMap((e) => e.tasks.map((t) => t.taskId)));
    expect(
      of("review.recovery_phase", "recovery").some((e) => ids.has(e.taskId)),
      "an interrupted task runs a phase again",
    );
    expect(
      of("review.recovery_task_ended", "recovery").some(
        (e) => ids.has(e.taskId) && e.outcome === "done",
      ),
      "an interrupted task reaches done in the recovery boot",
    );
    const finished = of("review.finished", "recovery");
    expect(
      finished.length === 1 && finished[0].bootId === detected[0]?.bootId,
      "the verdict is logged by the recovering boot",
    );
    expect(
      new Set(run.events.map((e) => e.objectId)).size === 1 &&
        new Set(run.events.map((e) => e.bootId)).size >= 2,
      "events correlate one object across boots",
    );
  }
  return failed;
}

const APP_DOC = /\{(?:"review\.state"|review\.state)\}$/;
const MIXED_DOC = /\{.*review\.state.*\}$/;

function summarize(run) {
  const phases = {};
  for (const t of run.tallies) {
    if (t.origin === "probe") continue;
    const s = (phases[t.phase] ??= {
      sqlRowsWritten: 0,
      appDocRowsWritten: 0,
      mixedDocRowsWritten: 0,
      frameworkRowsWritten: 0,
      sqlWriteStatements: 0,
      setAlarm: 0,
      setAlarmUnchanged: 0,
      deleteAlarm: 0,
      byTable: {},
    });
    if (t.op === "setAlarm") {
      s.setAlarm += t.calls;
      s.setAlarmUnchanged += t.sameTimeSetAlarm;
      continue;
    }
    if (t.op === "deleteAlarm") {
      s.deleteAlarm += t.calls;
      continue;
    }
    if (!t.rowsWritten) continue;
    s.sqlRowsWritten += t.rowsWritten;
    s.sqlWriteStatements += t.calls;
    if (APP_DOC.test(t.table)) s.appDocRowsWritten += t.rowsWritten;
    else if (MIXED_DOC.test(t.table)) s.mixedDocRowsWritten += t.rowsWritten;
    else s.frameworkRowsWritten += t.rowsWritten;
    s.byTable[t.table] = (s.byTable[t.table] ?? 0) + t.rowsWritten;
  }
  for (const s of Object.values(phases))
    s.billedRowsWritten = s.sqlRowsWritten + s.setAlarm + s.deleteAlarm;
  const probe = run.tallies
    .filter((t) => t.origin === "probe")
    .reduce((n, t) => n + t.rowsWritten, 0);
  return {
    scenario: run.scenario,
    phases,
    alarmAfter: run.alarmAfter ?? {},
    probeRowsWritten: probe,
    work: run.work,
  };
}

const runs = [];
try {
  for (let i = 0; i < Number(args.repeats); i++) {
    runs.push(await lifecycle());
    runs.push(await recovery());
  }
} finally {
  await worker.dispose();
}

const profile = {
  label: args.label,
  at: new Date().toISOString(),
  head: git("rev-parse", "HEAD"),
  srcDiff: git("diff", "--stat", "HEAD", "--", "../src"),
  runs: runs.map((run) => ({
    ...run,
    summary: summarize(run),
    failed: checks(run),
  })),
};
const json = JSON.stringify(profile, null, 2);
if (args.out) writeFileSync(args.out, json);
for (const run of profile.runs) {
  for (const f of run.failed) console.log(`FAILED ${run.scenario}: ${f}`);
  const {
    scenario,
    phases,
    alarmAfter,
    probeRowsWritten,
    work: w,
  } = run.summary;
  console.log(
    `${args.label} ${scenario}: ${w.status} findings=${w.findings} lookups=${w.lookups} unexpected=${w.unexpected.length} alarm=${w.storedAlarm} probeRows=${probeRowsWritten}`,
  );
  for (const [phase, s] of Object.entries(phases))
    console.log(
      `  ${phase.padEnd(22)} billed=${String(s.billedRowsWritten).padStart(4)} sql=${String(s.sqlRowsWritten).padStart(4)} (pi-durable ${s.frameworkRowsWritten}, review.state ${s.appDocRowsWritten}, mixed ${s.mixedDocRowsWritten}) setAlarm=${s.setAlarm} (unchanged ${s.setAlarmUnchanged}) deleteAlarm=${s.deleteAlarm}${phase in alarmAfter ? ` alarmAfter=${alarmAfter[phase]}` : ""}`,
    );
}
if (profile.runs.some((r) => r.failed.length)) process.exitCode = 1;
