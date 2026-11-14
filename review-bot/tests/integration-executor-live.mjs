import assert from "node:assert/strict";
import { run } from "../executor/process.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const scope = `test${process.pid}`;
const port = 19000 + (process.pid % 1000);
const token =
  process.env.GITHUB_TOKEN ??
  execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const label = `label=dev.oliinyk.bumble.executor=${scope}`;
const podman = (...args) =>
  execFileSync("podman", args, { encoding: "utf8" }).trim();
let broker;
const host = createServer((_, response) => response.end("HOST CONTROL PLANE"));
await new Promise((r) => host.listen(18081, "127.0.0.1", r));
function start() {
  const env = {
    ...process.env,
    EXECUTOR_TOKEN: "live-test-broker-secret",
    EXECUTOR_PORT: String(port),
    EXECUTOR_SCOPE: scope,
    EXECUTOR_IDLE_MS: "3000",
    EXECUTOR_WORK_ROOT: `/tmp/bumble-live-${scope}`,
  };
  broker = process.env.TEST_MANAGER_SOCKET
    ? spawn(
        "podman",
        [
          "run",
          "--rm",
          "--name",
          `${scope}-manager`,
          "--publish",
          `127.0.0.1:${port}:${port}`,
          "--volume",
          `${process.env.TEST_MANAGER_SOCKET}:/run/podman/podman.sock`,
          "--env",
          "CONTAINER_HOST=unix:///run/podman/podman.sock",
          ...[
            "EXECUTOR_TOKEN",
            "EXECUTOR_PORT",
            "EXECUTOR_SCOPE",
            "EXECUTOR_IDLE_MS",
            "EXECUTOR_WORK_ROOT",
          ].flatMap((k) => ["--env", k]),
          "localhost/bumble-manager:test",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      )
    : spawn(process.execPath, ["executor/server.mjs"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
}
function stop(signal) {
  if (process.env.TEST_MANAGER_SOCKET)
    podman("kill", "--signal", signal, `${scope}-manager`);
  else broker.kill(signal);
}

async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}`);
      return;
    } catch {}
    if (broker.exitCode !== null) throw new Error("broker exited");
    await delay(100);
  }
  throw new Error("broker startup timeout");
}
async function call(path, input, signal, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer live-test-broker-secret" },
    body: JSON.stringify(input),
    signal,
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
const input = {
  owner: "oliynykmax",
  repo: "junction-2026",
  sha: "e0384be7fbeb7b4c39992a272b92f1ec545855d4",
  baseSha: "76cf85e03550c40577958e97a355ecf7e9109913",
  githubToken: token,
};
const checkout = (session) => call("checkout", { ...input, session });
const shell = (session, command, extra = {}) =>
  call("shell", { session, command, ...extra });
try {
  assert.equal(
    (
      await run("podman", [
        "run",
        "--rm",
        "--network",
        "host",
        "--workdir",
        "/",
        "localhost/bumble-worker:latest",
        "curl",
        "--max-time",
        "3",
        "-fsS",
        "http://127.0.0.1:18081",
      ])
    ).stdout,
    "HOST CONTROL PLANE",
  );
  podman(
    "create",
    "--name",
    `${scope}-unrelated`,
    "--label",
    `dev.oliinyk.bumble.executor=${scope}other`,
    "localhost/bumble-worker:latest",
    "sleep",
    "infinity",
  );
  start();
  await ready();
  const first = await checkout("first");
  assert.equal(first.commit, input.sha);
  let result = await shell(
    "first",
    `test "$(id -u)" = 0 && test -w . && test -z "$(git status --porcelain)" && test "$(git rev-parse HEAD)" = ${input.sha} && git diff ${input.baseSha}...HEAD --stat && git log ${input.baseSha}..HEAD --oneline && echo PRIVATE_FIRST > /foreign-secret && apt-get update -qq && apt-get install -y -qq jq && curl -fsSL https://example.com >/dev/null`,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  console.log(
    "PASS root, writable clean checkout, pinned head/base/history, apt install, outbound HTTPS",
  );
  await checkout("second");
  result = await shell(
    "second",
    'test ! -e /foreign-secret && test ! -S /run/podman/podman.sock && test ! -d /app && ! env | grep -E \'EXECUTOR_TOKEN|GITHUB_TOKEN|CONTAINER_HOST\' && node -e \'const fs=require("fs"); const needles=[["live-test", "broker-secret"].join("-"),["server", ".mjs"].join(""),["Authorization", ": Basic"].join("")]; for(const p of fs.readdirSync("/proc").filter(p=>/^\\d+$/.test(p))) for(const f of ["cmdline","environ"]) {try { const b=fs.readFileSync(`/proc/${p}/${f}`).toString(); if(needles.some(n=>b.includes(n))) process.exit(1); } catch {} }\' && ! curl --max-time 1 -fsS http://127.0.0.1:18081',
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const ids = podman("ps", "-aq", "--filter", label).split(/\s+/);
  const info = JSON.parse(podman("inspect", ...ids));
  for (const container of info) {
    assert.equal(container.HostConfig.Memory, 4294967296);
    assert.equal(container.HostConfig.PidsLimit, 512);
    assert.equal(container.HostConfig.NanoCpus, 1500000000);
    const networkName = container.Name.replace(/^\//, "");
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [
      networkName,
    ]);
    const network = JSON.parse(podman("network", "inspect", networkName))[0];
    assert.equal(network.options.isolate, "true");
    assert.equal(container.Mounts.length, 0);
  }
  console.log(
    "PASS cross-review source/credential/socket isolation, host-loopback denial, actual resource config",
  );
  await call("checkout", { ...input, session: "capacity" }, undefined, 400);
  const busy = shell("second", "sleep 1");
  await delay(200);
  assert.equal(
    (await call("checkout", { ...input, session: "second" }, undefined, 400))
      .error,
    "session busy",
  );
  assert.equal(
    (
      await call(
        "shell",
        { session: "second", command: "true" },
        undefined,
        400,
      )
    ).error,
    "session busy",
  );
  await busy;
  console.log(
    "PASS capacity bound and explicit same-session checkout/shell race rejection",
  );
  const started = Date.now();
  result = await shell("first", "setsid bash -c 'sleep 300 & wait' & wait", {
    timeoutMs: 250,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 12000);
  assert.equal(podman("ps", "-aq", "--filter", label).split(/\s+/).length, 1);
  console.log(
    "PASS timeout removes whole worker including setsid grandchildren and settles HTTP",
  );
  await call("release", { session: "second" });
  stop("SIGTERM");
  await new Promise((r) => broker.once("exit", r));
  assert.equal(podman("ps", "-aq", "--filter", label), "");
  start();
  await ready();
  await checkout("disconnect");
  const cancel = new AbortController();
  const work = call(
    "shell",
    {
      session: "disconnect",
      command: "setsid bash -c 'sleep 300 & wait' & wait",
    },
    cancel.signal,
  ).catch(() => null);
  await delay(250);
  cancel.abort();
  await work;
  for (let i = 0; i < 100 && podman("ps", "-aq", "--filter", label); i++)
    await delay(100);
  assert.equal(podman("ps", "-aq", "--filter", label), "");
  await checkout("reset");
  await shell("reset", "echo dirty > dirty");
  await checkout("reset");
  assert.equal(
    (
      await shell(
        "reset",
        'test ! -f dirty && test -z "$(git status --porcelain)"',
      )
    ).exitCode,
    0,
  );
  await call("release", { session: "reset" });
  assert.equal(podman("ps", "-aq", "--filter", label), "");
  await checkout("idle");
  await delay(6500);
  assert.equal(podman("ps", "-aq", "--filter", label), "");
  await checkout("restart");
  stop("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  start();
  await ready();
  assert.equal(podman("ps", "-aq", "--filter", label), "");
  assert.equal(podman("container", "exists", `${scope}-unrelated`), "");
  console.log(
    "PASS disconnect, reset, terminal release, idle expiry, restart and shutdown cleanup with unrelated container preserved",
  );
} finally {
  if (broker?.exitCode === null) {
    stop("SIGTERM");
    await new Promise((r) => broker.once("exit", r));
  }
  host.close();
  podman("rm", "-f", "--ignore", `${scope}-unrelated`);
  const ids = podman("ps", "-aq", "--filter", label);
  if (ids) podman("rm", "-f", ...ids.split(/\s+/));
}
