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
    let stdoutTruncated = false;
    let stderrTruncated = false;
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
          stdoutTruncated,
          stderrTruncated,
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
      const available = MAX_OUTPUT - stdout.length;
      if (chunk.length > available) stdoutTruncated = true;
      if (available > 0)
        stdout = Buffer.concat([stdout, chunk.subarray(0, available)]);
    });
    child.stderr.on("data", (chunk) => {
      const available = MAX_OUTPUT - stderr.length;
      if (chunk.length > available) stderrTruncated = true;
      if (available > 0)
        stderr = Buffer.concat([stderr, chunk.subarray(0, available)]);
    });
    child.once("error", (error) => finish(1, false, error));
    child.once("close", (code) => {
      if (!stopping) finish(code);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
