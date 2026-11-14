import { expect, test } from "bun:test";
import { run } from "../executor/process.mjs";

test("deadline kills a grandchild holding inherited pipes and settles", async () => {
  const started = Date.now();
  const result = await run("bash", ["-c", "sleep 30 & echo $!; wait"], {
    timeoutMs: 100,
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  const state = await run("ps", ["-o", "stat=", "-p", result.stdout.trim()]);
  expect(
    state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
  ).toBe(true);
});

test("abort settles independent of inherited pipes", async () => {
  const controller = new AbortController();
  const result = run("bash", ["-c", "sleep 30 & wait"], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  expect((await result).exitCode).toBe(137);
});
