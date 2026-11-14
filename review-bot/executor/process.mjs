import { spawn } from "node:child_process";

const MAX_OUTPUT = 128 * 1024;

export function run(
  file,
  args,
  { cwd, env, timeoutMs = 900_000, signal, cancel } = {},
) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let done = false;
    let stopping = false;
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code, timedOut = false, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else
        resolve({
          exitCode: code ?? 1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
        });
    };
    const stop = (timedOut) => {
      if (done || stopping) return;
      stopping = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      // Container removal kills even descendants that created a new session.
      Promise.resolve(cancel?.()).then(
        () => finish(137, timedOut),
        () => finish(137, timedOut),
      );
    };
    const abort = () => stop(false);
    const timer = setTimeout(() => stop(true), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([
        stdout,
        chunk.subarray(0, Math.max(0, MAX_OUTPUT - stdout.length)),
      ]);
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([
        stderr,
        chunk.subarray(0, Math.max(0, MAX_OUTPUT - stderr.length)),
      ]);
    });
    child.once("error", (error) => finish(1, false, error));
    child.once("close", (code) => {
      if (!stopping) finish(code);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
