import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { run } from "./process.mjs";

const PORT = Number(process.env.EXECUTOR_PORT ?? 8787);
const ROOT = process.env.EXECUTOR_WORK_ROOT ?? "/tmp/bumble-review-shell";
const TOKEN = process.env.EXECUTOR_TOKEN;
const IMAGE = process.env.EXECUTOR_IMAGE ?? "localhost/bumble-worker:latest";
const LABEL = "dev.oliinyk.bumble.executor";
const SCOPE = process.env.EXECUTOR_SCOPE ?? "production";
const IDLE_MS = Number(process.env.EXECUTOR_IDLE_MS ?? 600_000);
const LIFETIME_MS = 45 * 60_000;
const MAX_SESSIONS = 2;
const sessions = new Map();
if (!TOKEN) throw new Error("EXECUTOR_TOKEN is required");
if (!/^[a-zA-Z0-9_-]+$/.test(SCOPE)) throw new Error("invalid executor scope");

const environment = process.env;
const podman = (args, options = {}) =>
  run("podman", args, { env: environment, timeoutMs: 30_000, ...options });
async function checked(file, args, options) {
  const result = await run(file, args, options);
  if (result.exitCode !== 0) throw new Error(`${file} ${args[0]} failed`);
  return result;
}
async function pm(args, options) {
  const result = await podman(args, options);
  if (result.exitCode !== 0) throw new Error(`podman ${args[0]} failed`);
  return result;
}
function key(session) {
  return createHash("sha256").update(string(session, "session")).digest("hex");
}
function string(value, name) {
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required`);
  return value;
}
function match(value, name, pattern) {
  const parsed = string(value, name);
  if (!pattern.test(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}
async function destroy(session) {
  session.ready = false;
  session.busy = true;
  const result = await podman(
    ["rm", "--force", "--time", "0", "--ignore", session.name],
    {
      timeoutMs: 10_000,
    },
  );
  if (result.exitCode !== 0) throw new Error("worker cleanup failed");
  const network = (
    await pm([
      "network",
      "ls",
      "-q",
      "--filter",
      `label=${LABEL}=${SCOPE}`,
      "--filter",
      `name=^${session.name}$`,
    ])
  ).stdout.trim();
  if (network) await pm(["network", "rm", network]);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
}
async function cleanup() {
  const { stdout } = await pm([
    "ps",
    "-aq",
    "--filter",
    `label=${LABEL}=${SCOPE}`,
  ]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) await pm(["rm", "-f", "--time", "0", ...ids]);
  const networks = (
    await pm(["network", "ls", "-q", "--filter", `label=${LABEL}=${SCOPE}`])
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (networks.length) await pm(["network", "rm", ...networks]);
}
async function checkout(input, signal) {
  const owner = match(input.owner, "owner", /^[A-Za-z0-9_.-]+$/);
  const repo = match(input.repo, "repo", /^[A-Za-z0-9_.-]+$/);
  const commit = match(input.sha, "sha", /^[0-9a-f]{40}$/);
  const base =
    input.baseSha == null
      ? null
      : match(input.baseSha, "baseSha", /^[0-9a-f]{40}$/);
  const token = string(input.githubToken, "githubToken");
  if (/[\r\n\0]/.test(token)) throw new Error("invalid githubToken");
  const id = key(input.session);
  const old = sessions.get(id);
  if (old?.busy) throw new Error("session busy");
  if (old) {
    old.busy = true;
    await destroy(old);
  }
  if (sessions.size >= MAX_SESSIONS)
    throw new Error("executor capacity reached; retry later");
  const session = {
    key: id,
    name: `bumble-${SCOPE}-${randomUUID()}`,
    busy: true,
    ready: false,
    touched: Date.now(),
    created: Date.now(),
  };
  sessions.set(id, session);
  const workspace = resolve(ROOT, id, "repo");
  let staging;
  try {
    staging = await mkdtemp(resolve(ROOT, "fetch-"));
    const checkout = resolve(staging, "repo");
    const git = (args, auth = false) =>
      checked("git", args, {
        cwd: staging,
        env: {
          HOME: staging,
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          ...(auth && {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          }),
        },
        signal,
        timeoutMs: 120_000,
      });
    await git(["init", checkout]);
    await git([
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      `https://github.com/${owner}/${repo}.git`,
    ]);
    await git(
      ["-C", checkout, "fetch", "origin", commit, ...(base ? [base] : [])],
      true,
    );
    await git(["-C", checkout, "checkout", "--detach", commit]);
    signal.throwIfAborted();
    await pm(
      [
        "network",
        "create",
        "--label",
        `${LABEL}=${SCOPE}`,
        "--opt",
        "isolate=true",
        session.name,
      ],
      { signal },
    );
    await pm(
      [
        "create",
        "--name",
        session.name,
        "--label",
        `${LABEL}=${SCOPE}`,
        "--network",
        session.name,
        "--pid",
        "private",
        "--ipc",
        "private",
        "--cpus",
        "1.5",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "--pids-limit",
        "512",
        "--security-opt",
        "no-new-privileges",
        "--log-driver",
        "none",
        "--workdir",
        "/",
        IMAGE,
        "sleep",
        "infinity",
      ],
      { signal },
    );
    await pm(["start", session.name], { signal });
    await pm(["exec", session.name, "mkdir", "-p", workspace], { signal });
    await pm(["cp", `${checkout}/.`, `${session.name}:${workspace}`], {
      signal,
    });
    session.ready = true;
    return { workspace, commit, ...(base && { base }) };
  } catch (error) {
    await destroy(session);
    throw error;
  } finally {
    session.busy = false;
    session.touched = Date.now();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
async function shell(input, signal) {
  const session = sessions.get(key(input.session));
  if (!session?.ready) throw new Error("checkout required");
  if (session.busy) throw new Error("session busy");
  const command = string(input.command, "command");
  const workspace = resolve(ROOT, session.key, "repo");
  const cwd =
    typeof input.cwd === "string" && input.cwd
      ? resolve(workspace, input.cwd)
      : workspace;
  const requested = Number(input.timeoutMs ?? 900_000);
  const timeoutMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, 900_000)
      : 900_000;
  session.busy = true;
  try {
    return await podman(
      ["exec", "--workdir", cwd, session.name, "/bin/bash", "-c", command],
      { timeoutMs, signal, cancel: () => destroy(session) },
    );
  } finally {
    session.busy = false;
    session.touched = Date.now();
  }
}
async function bodyOf(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 1_000_000) throw new Error("request body exceeds 1 MB");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts));
}
const server = createServer(async (request, response) => {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const authorization = request.headers.authorization ?? "";
    const actual = Buffer.from(
      authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
    );
    const expected = Buffer.from(TOKEN);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") throw new Error("POST required");
    const input = await bodyOf(request);
    let result;
    if (request.url === "/v1/checkout")
      result = await checkout(input, controller.signal);
    else if (request.url === "/v1/shell")
      result = await shell(input, controller.signal);
    else if (request.url === "/v1/release") {
      const session = sessions.get(key(input.session));
      if (session) {
        if (session.busy) throw new Error("session busy");
        await destroy(session);
      }
      result = { released: true };
    } else throw new Error("unknown endpoint");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(result));
  } catch (error) {
    response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: error.message }));
  }
});
await mkdir(ROOT, { recursive: true, mode: 0o700 });
await cleanup();
// Staging contains only broker-fetched Git data, never worker-controlled paths.
await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true, mode: 0o700 });
const reaper = setInterval(
  () => {
    for (const session of sessions.values()) {
      if (
        (!session.busy && Date.now() - session.touched > IDLE_MS) ||
        Date.now() - session.created > LIFETIME_MS
      ) {
        session.ready = false;
        session.busy = true;
        void destroy(session).catch(() => {});
      }
    }
  },
  Math.min(IDLE_MS, 30_000),
);
async function shutdown() {
  clearInterval(reaper);
  server.close();
  await cleanup();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(PORT, process.env.EXECUTOR_BIND ?? "0.0.0.0");
