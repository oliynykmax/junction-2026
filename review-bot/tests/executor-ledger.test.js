import { expect, test } from "bun:test";
import { recordExecutor } from "../src/executor";

const checkout = {
  session: "session",
  owner: "o",
  repo: "r",
  sha: "sha",
  githubToken: "secret-token",
};
const command = { session: "session", command: "secret-command" };

for (const outcome of [
  "checkout",
  "completed",
  "nonzero",
  "timeout",
  "checkout rejection",
  "command rejection",
  "configuration rejection",
]) {
  test(`executor ledger records ${outcome} without private data`, async () => {
    const events = [];
    const error = new Error("secret-error");
    const isCheckout = outcome.startsWith("checkout");
    const rejects = outcome.endsWith("rejection");
    const result = isCheckout
      ? { workspace: "secret-workspace", commit: "sha" }
      : {
          exitCode:
            outcome === "nonzero" ? 17 : outcome === "timeout" ? 124 : 0,
          timedOut: outcome === "timeout",
          stdout: "secret-output",
          stderr: "secret-stderr",
        };
    const calls = [];
    const execute = async (...args) => {
      calls.push(args);
      if (rejects) throw error;
      return result;
    };
    const recorded = recordExecutor(
      () => {
        if (outcome === "configuration rejection") throw error;
        return {
          checkout: execute,
          shell: execute,
          release: async () => ({ released: true }),
        };
      },
      (event) => events.push(event),
    );
    const signal = new AbortController().signal;
    const pending = isCheckout
      ? recorded.checkout(checkout, signal)
      : recorded.shell(command, signal);
    if (rejects) {
      expect(await pending.catch((caught) => caught)).toBe(error);
    } else {
      expect(await pending).toBe(result);
    }
    expect(calls).toEqual(
      outcome === "configuration rejection"
        ? []
        : [[isCheckout ? checkout : command, signal]],
    );
    expect(events).toEqual([
      {
        kind: "shell",
        name: isCheckout ? "checkout" : "command",
        ms: expect.any(Number),
        ok: !rejects && outcome !== "timeout",
        ...(!isCheckout && !rejects
          ? { detail: { exit: result.exitCode, timedOut: result.timedOut } }
          : {}),
      },
    ]);
    expect(events[0].ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("secret");
  });
}
