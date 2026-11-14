import { expect, test } from "bun:test";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  receiptFrom,
  uncoveredVerificationFiles,
  verificationProblems,
  type VerificationInput,
} from "../src/formal";
import type { ConversationId } from "@earendil-works/pi-durable";
import { FormalDemo, VerdictBadge, VerificationReceipts } from "../web/formal";

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

test("fix checks retain fail-before and pass-after separately from checker mutation evidence", () => {
  const input: VerificationInput = {
    ...valid,
    outcome: "counterexample",
    result: "Failed arity bound at input 2.",
    broken_variant: undefined,
    fix_check: {
      outcome: "passed",
      command: "bun test arity-repro.ts",
      before: "Failed at arity 2 on pinned head.",
      after: "Passed with proposed guard on scratch copy.",
    },
  };
  expect(verificationProblems(input, valid.files)).toEqual([]);
  const receipt = receiptFrom("fixed", input);
  expect(receipt.fixCheck?.before).toContain("Failed");
  expect(receipt.fixCheck?.after).toContain("Passed");
  expect(receipt.brokenVariant).toBeNull();
  expect(
    verificationProblems({ ...input, outcome: "not_run" }, valid.files).join(
      " ",
    ),
  ).toContain("requires a counterexample");
  expect(
    verificationProblems(
      {
        ...input,
        fix_check: { command: "", before: "", after: "", outcome: "passed" },
      },
      valid.files,
    ).join(" "),
  ).toContain("fix_check");
});

test("finding rendering preserves legacy bodies and shows reason evidence fix and scoped checks", async () => {
  const { FindingDetails } = await import("../web/findings");
  const base = {
    id: "f",
    path: "src/cache.ts",
    line: 12,
    severity: "high" as const,
    title: "Stale cache read",
    body: "Legacy finding body.",
    source: "agent" as const,
    suggestedPatch: null,
  };
  const legacy = renderToString(h(FindingDetails, { f: base }));
  expect(legacy).toContain("Legacy finding body.");
  expect(legacy).not.toContain("Proposed fix");
  const f = {
    ...base,
    reason: "The owner sees stale evidence.",
    evidence: {
      kind: "code" as const,
      detail: "The cache key omits the head.",
      supporting: ["Existing test fails at the stale read."],
    },
    fix: "Include the head in the cache key.",
  };
  const proposed = renderToString(h(FindingDetails, { f }));
  expect(proposed).toContain(f.reason);
  expect(proposed).toContain(f.evidence.detail);
  expect(proposed).toContain(f.evidence.supporting[0]);
  expect(proposed).toContain("Proposed fix, not tested");
  const verification = receiptFrom("r", {
    ...valid,
    outcome: "counterexample",
    result: "Counterexample: stale read.",
    fix_check: {
      outcome: "passed",
      command: "bun test cache-repro.ts",
      before: "Failed stale read.",
      after: "Passed with head key.",
    },
  });
  const verdict = {
    verdict: "reproduced" as const,
    receiptId: "r",
    note: "The repro returned the old review.",
    receipt: verification,
  };
  const tested = renderToString(h(FindingDetails, { f: { ...f, verdict } }));
  expect(tested).toContain("Fix tested on scratch copy");
  expect(tested).toContain(verdict.note);
  const failedFix = {
    ...verification,
    fixCheck: {
      command: "bun test cache-repro.ts",
      before: "Failed stale read.",
      after: "Failed with proposed fix.",
      outcome: "failed" as const,
    },
  };
  const failed = renderToString(
    h(FindingDetails, {
      f: { ...f, verdict: { ...verdict, receipt: failedFix } },
    }),
  );
  expect(failed).toContain("Proposed fix, scratch check failed");
});

test("a verdict badge links to its receipt in the verifier's section, under its blind checks", () => {
  const receipt = receiptFrom("call/1", valid);
  const badge = renderToString(
    h(VerdictBadge, {
      verdict: { verdict: "not_reproduced", receiptId: receipt.id, note: "n" },
    }),
  );
  const section = renderToString(
    h(VerificationReceipts, {
      receipts: [receipt],
      running: false,
      verifier: {
        status: "done",
        conversationId: 2 as ConversationId,
        checks: [
          {
            id: "c",
            requirement: "A new push gets a fresh review.",
            path: "tests/fresh.test.ts",
            content: "test()",
          },
        ],
        verdicts: {},
        summary: "The blind check passes at the head.",
      },
    }),
  );
  const href = badge.match(/href="#([^"]+)"/)?.[1];
  expect(badge).toContain("Not reproduced by verifier");
  expect(section).toContain(`id="${href}"`);
  expect(section).toContain("What the verifier reports");
  expect(section).toContain("Checks written before seeing the change");
  expect(section).toContain("A new push gets a fresh review.");
  expect(section).toContain("tests/fresh.test.ts");
  const unchecked = renderToString(
    h(VerdictBadge, {
      verdict: { verdict: "not_checked", receiptId: null, note: "n" },
    }),
  );
  expect(unchecked).not.toContain("href");
});
