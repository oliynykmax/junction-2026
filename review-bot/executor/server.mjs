// The CellD Worker cannot spawn processes. This localhost-only service gives
// the review agent the explicitly approved free shell in a disposable Podman
// container. There is intentionally no command allow-list.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.EXECUTOR_PORT ?? 8787);
const ROOT = process.env.EXECUTOR_WORK_ROOT ?? "/tmp/bumble-review-shell";
const TOKEN = process.env.EXECUTOR_TOKEN ?? "";
const MAX_BODY_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

if (!TOKEN) throw new Error("EXECUTOR_TOKEN is required");

function fail(status, error) {
  const body = JSON.stringify({ error });
  return { status, body };
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function equalToken(candidate) {
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function bodyOf(request) {
  let size = 0;
  const parts = [];
  for await (const part of request) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MB");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("request body is not JSON");
  }
}

function string(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function safeName(value, name) {
  const result = string(value, name);
  if (!/^[A-Za-z0-9_.-]+$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function sha(value, name) {
  const result = string(value, name);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function sessionRoot(session) {
  return resolve(ROOT, createHash("sha256").update(string(session, "session")).digest("hex"));
}

function append(current, chunk) {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const available = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, available).toString("utf8");
}

function run(file, args, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function shellEnvironment() {
  // The free shell receives root in its own container, but never the request
  // authentication header or a GitHub checkout token.
  return {
    HOME: "/root",
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: "dumb",
  };
}

async function checkout(input) {
  const session = sessionRoot(input.session);
  const owner = safeName(input.owner, "owner");
  const repo = safeName(input.repo, "repo");
  const commit = sha(input.sha, "sha");
  const githubToken = string(input.githubToken, "githubToken");
  const workspace = resolve(session, "repo");
  await rm(session, { recursive: true, force: true });
  await mkdir(session, { recursive: true });
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  const remote = `https://github.com/${owner}/${repo}.git`;
  const git = async (...args) => {
    const result = await run("git", args, {
      cwd: session,
      env: shellEnvironment(),
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  };
  await git("init", workspace);
  await git("-C", workspace, "remote", "add", "origin", remote);
  // The token exists only in this child command's argv. It is neither saved in
  // .git/config nor inherited by commands the agent subsequently runs.
  await git(
    "-C",
    workspace,
    "-c",
    `http.extraHeader=Authorization: Basic ${basic}`,
    "fetch",
    "--depth=1",
    "origin",
    commit,
  );
  await git("-C", workspace, "checkout", "--detach", "FETCH_HEAD");
  await writeFile(
    resolve(workspace, ".bumble-checkout.json"),
    JSON.stringify({ owner, repo, commit }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return { workspace, commit };
}

async function shell(input) {
  const session = sessionRoot(input.session);
  const workspace = resolve(session, "repo");
  const command = string(input.command, "command");
  const cwd =
    typeof input.cwd === "string" && input.cwd
      ? input.cwd.startsWith("/")
        ? input.cwd
        : resolve(workspace, input.cwd)
      : workspace;
  const requested = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  return run("/bin/bash", ["-c", command], {
    cwd,
    env: shellEnvironment(),
    timeoutMs,
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") return reply(response, 404, fail(404, "not found").body);
    const auth = request.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !equalToken(auth.slice(7)))
      return reply(response, 401, fail(401, "unauthorized").body);
    const input = await bodyOf(request);
    if (request.url === "/v1/checkout")
      return reply(response, 200, JSON.stringify(await checkout(input)));
    if (request.url === "/v1/shell")
      return reply(response, 200, JSON.stringify(await shell(input)));
    return reply(response, 404, fail(404, "not found").body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply(response, 400, fail(400, message).body);
  }
});

await mkdir(ROOT, { recursive: true });
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bumble free shell executor listening on 127.0.0.1:${PORT}`);
});
