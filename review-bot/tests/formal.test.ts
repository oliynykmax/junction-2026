import { expect, test } from "bun:test";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  receiptFrom,
  uncoveredVerificationFiles,
  verificationProblems,
  type VerificationInput,
} from "../src/formal";
import { FormalDemo } from "../web/formal";

const valid: VerificationInput = {
  files: ["src/cache.ts"],
  target: "review cache key",
  property: "A review from one head cannot be read for another head.",
  harm: "A named owner could see stale evidence.",
  method: "TLA+",
  checker: "TLC 2.19",
  command: "tlc CacheScope.tla",
  outcome: "passed",
  result: "No violation in 312 states.",
  scope: "Two pull requests and three heads each.",
  broken_variant: "Dropping the head from the key creates a stale read trace.",
  assumptions: ["writes are atomic"],
  limits: ["does not prove the Worker implementation"],
};

test("a claimed pass needs a reproducible failed mutation and explicit limits", () => {
  expect(verificationProblems(valid, valid.files)).toEqual([]);
  const problems = verificationProblems(
    { ...valid, broken_variant: "", limits: [] },
    valid.files,
  );
  expect(problems.join(" ")).toContain("broken_variant");
  expect(problems.join(" ")).toContain("at least one limit");
});

test("unrun and counterexample records cannot hide their outcome", () => {
  expect(
    verificationProblems(
      {
        ...valid,
        outcome: "not_run",
        result: "No violations found.",
        broken_variant: undefined,
      },
      valid.files,
    ).join(" "),
  ).toContain("why no checker result exists");
  expect(
    verificationProblems(
      {
        ...valid,
        outcome: "counterexample",
        result: "The run produced a bad result.",
        broken_variant: undefined,
      },
      valid.files,
    ).join(" "),
  ).toContain("trace, violation or failure");
});

test("coverage is computed from the immutable changed-file list", () => {
  const receipt = receiptFrom("r1", valid);
  expect(
    uncoveredVerificationFiles(
      [{ path: "src/cache.ts" }, { path: "tests/cache.test.ts" }],
      [receipt],
    ),
  ).toEqual(["tests/cache.test.ts"]);
});

test("the walkthrough shows checked, broken and unverified receipts distinctly", () => {
  const html = renderToString(h(FormalDemo, { scenario: "all" }));
  expect(html).toContain("synthetic walkthrough");
  expect(html).toContain("Reported pass");
  expect(html).toContain("Counterexample");
  expect(html).toContain("Not verified");
  expect(html).toContain("Reported mutation result");
  expect(html).toContain("Does not cover");
  expect(html).toContain("not checker execution or result authenticity");
});

test("receipts reject unknown files, blank evidence and oversized mutation reports", () => {
  expect(verificationProblems(valid, []).join(" ")).toContain("Not changed");
  const problems = verificationProblems(
    {
      ...valid,
      command: " ",
      scope: " ",
      assumptions: [" "],
      broken_variant: "x".repeat(901),
    },
    valid.files,
  ).join(" ");
  expect(problems).toContain("Write the command");
  expect(problems).toContain("Write the scope");
  expect(problems).toContain("assumption cannot be blank");
  expect(problems).toContain("broken_variant must be under");
});
