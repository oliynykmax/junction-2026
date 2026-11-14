import { expect, test } from "bun:test";
import { failureClass, reviewStatus } from "../src/status";

const target = {
  owner: "o",
  repo: "r",
  number: 1,
  headSha: "a".repeat(40),
  installationId: 1,
};
const verdict = {
  decision: "no_blockers_found" as const,
  summary: "",
  notChecked: [],
  dismissed: [],
};

test("a review with no target has not started", () => {
  expect(
    reviewStatus({ target: null, verdict: null, scan: null }, null, 3),
  ).toBe("not_started");
});

test("a verdict means done, even beside a later run failure", () => {
  expect(
    reviewStatus({ target, verdict, scan: null }, { reason: "model_error" }, 0),
  ).toBe("done");
});

test("a run failure without a verdict means failed", () => {
  expect(
    reviewStatus(
      { target, verdict: null, scan: null },
      { reason: "faulted" },
      2,
    ),
  ).toBe("failed");
});

test("a pending scan is scanning, live tasks are running, neither is failed", () => {
  const scan = { status: "pending" as const, results: [], error: null };
  expect(reviewStatus({ target, verdict: null, scan }, null, 1)).toBe(
    "scanning",
  );
  expect(reviewStatus({ target, verdict: null, scan: null }, null, 1)).toBe(
    "running",
  );
  expect(reviewStatus({ target, verdict: null, scan: null }, null, 0)).toBe(
    "failed",
  );
});

test("failure classes come from the reason and a fixed detail prefix, never the text", () => {
  expect(failureClass(null)).toBe("no_finish");
  expect(
    failureClass({ reason: "model_error", detail: "429 secret-ish text" }),
  ).toBe("model_error");
  expect(failureClass({ reason: "reset" })).toBe("aborted");
  expect(failureClass({ reason: "turn_limit", detail: "80 turns" })).toBe(
    "no_finish",
  );
  expect(
    failureClass({ reason: "faulted", detail: "scanner -> 502: bad gateway" }),
  ).toBe("scanner");
  expect(
    failureClass({
      reason: "faulted",
      detail: "GET /repos/o/r/pulls/1 -> 404: nope",
    }),
  ).toBe("github");
  expect(
    failureClass({ reason: "faulted", detail: "installation token -> 401: x" }),
  ).toBe("github");
  expect(failureClass({ reason: "faulted", detail: "TypeError: boom" })).toBe(
    "other",
  );
});
