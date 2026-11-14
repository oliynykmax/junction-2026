import { expect, test } from "bun:test";
import {
  capturedFiles,
  changeProblems,
  EMPTY_REVIEW,
  type ReviewState,
  reviewerExtension,
  starProblems,
  summaryProblems,
  uncoveredFiles,
} from "../src/reviewer";
import { receiptFrom } from "../src/formal";
import { changeSentence } from "../web/shared";

const file = (filename: string, patch?: string) => ({
  filename,
  status: "modified",
  additions: 3,
  deletions: 1,
  patch,
});

const change = {
  title: "Guard type-argument lookup",
  tags: ["bug fix", "Source Generator"],
  summary: "Resolves type arguments through the constructed type.",
  files: ["src/TypeCollector.cs"],
};

const star = {
  situation: "The generator threw on closed generic structs.",
  task: "Stop indexing past the type's own parameters.",
  action: "Resolve arguments through the constructed type.",
  result: "Six new tests pass; NativeAOT is unverified.",
};

const finish = (rest: object = {}) => ({
  ...star,
  summary: "s",
  not_checked: [],
  ...rest,
});

function harness(state: ReviewState) {
  const { extension } = reviewerExtension({
    token: async () => "token",
    publish: async () => {},
    finished: () => {},
    scan: async () => [],
  });
  const tool = (name: string) => {
    const t = extension.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  let call = 0;
  const api = () => ({
    conversationId: "root",
    callId: `call-${++call}`,
    snapshot: async () => state,
    commit: async (cb: (tx: unknown) => unknown) =>
      cb({ doc: async () => state }),
  });
  const run = (name: string, args: any) =>
    (tool(name).execute as any)(args, api(), {});
  return { run };
}

function reviewWith(paths: string[]): ReviewState {
  return {
    ...structuredClone(EMPTY_REVIEW),
    target: {
      owner: "o",
      repo: "r",
      number: 1,
      headSha: "a".repeat(40),
      installationId: 1,
    },
    lookups: [{ tool: "docs", args: "{}", at: 1 }],
    files: capturedFiles(paths.map((p) => file(p, "@@ -1 +1 @@\n-a\n+b"))),
    verifications: paths.length
      ? [
          receiptFrom("seed", {
            files: paths,
            target: "cache key",
            property: "A read stays scoped to its commit.",
            harm: "A human could read stale evidence.",
            method: "TLA+",
            checker: "TLC 2.19",
            command: "tlc CacheScope.tla",
            outcome: "passed",
            result: "No violation in 12 states.",
            scope: "Two heads and every read/write order.",
            broken_variant: "Removing the head key produces a stale read.",
            assumptions: ["writes are atomic"],
            limits: ["does not model eviction"],
          }),
        ]
      : [],
  };
}

test("captured files keep patches under the caps and drop the rest", () => {
  const files = capturedFiles([
    file("a.cs", "x".repeat(100)),
    file("big.cs", "x".repeat(20_001)),
    file("binary.png"),
  ]);
  expect(files.map((f) => [f.path, f.patch?.length ?? null])).toEqual([
    ["a.cs", 100],
    ["big.cs", null],
    ["binary.png", null],
  ]);
  const many = capturedFiles(
    Array.from({ length: 12 }, (_, i) => file(`f${i}`, "x".repeat(19_000))),
  );
  expect(many.filter((f) => f.patch).length).toBe(10);
});

test("change and summary problems flag the sentence, tag limits and unknown files", () => {
  expect(changeProblems(change, ["src/TypeCollector.cs"])).toEqual([]);
  const problems = changeProblems(
    { ...change, tags: ["a", "b", "c", "d"], files: ["nope.cs"] },
    ["src/TypeCollector.cs"],
  );
  expect(summaryProblems("I added a guard.").join(" ")).toContain(
    "summary speaks in the first person",
  );
  expect(summaryProblems(" ")).toEqual(["Write the summary sentence."]);
  expect(summaryProblems(change.summary)).toEqual([]);
  expect(problems.join(" ")).toContain("Give 1 to 3 tags");
  expect(problems.join(" ")).toContain(
    "Not changed in this pull request: nope.cs",
  );
});

test("star problems flag empty and long parts", () => {
  expect(starProblems(star)).toEqual([]);
  const problems = starProblems({
    ...star,
    task: "x".repeat(401),
    result: " ",
  });
  expect(problems.join(" ")).toContain("task is 401 characters");
  expect(problems.join(" ")).toContain("Write the result sentence.");
});

test("changes from older reviews show their stored Action", () => {
  const base = { id: "c", title: "t", tags: ["docs"], files: ["a.md"] };
  expect(changeSentence({ ...base, summary: "Adds a section." })).toBe(
    "Adds a section.",
  );
  expect(changeSentence({ ...base, action: "Fixes the typo." })).toBe(
    "Fixes the typo.",
  );
  expect(changeSentence(base)).toBeNull();
});

test("star problems flag plural first person and mine", () => {
  for (const result of [
    "We updated the retry logic.",
    "The retry logic is ours now.",
    "Our tests cover it.",
    "The fix is mine.",
  ])
    expect(starProblems({ ...star, result }).join(" ")).toContain(
      "result speaks in the first person",
    );
  expect(
    starProblems({
      ...star,
      result: "Users see fewer retries; the PR adds a USB test.",
    }),
  ).toEqual([]);
  for (const action of [
    "Retries failed I/O operations once.",
    "Moves the bucket to us-east-1 and the cache to /var/our-cache.",
  ])
    expect(starProblems({ ...star, action })).toEqual([]);
});

test("star problems flag the reviewer speaking in the first person", () => {
  const problems = starProblems({
    ...star,
    result: "The PR adds tests (I did not read or run them).",
    situation: "My reading is that the generator threw.",
  });
  expect(problems.join(" ")).toContain("result speaks in the first person");
  expect(problems.join(" ")).toContain("situation speaks in the first person");
  expect(
    starProblems({
      ...star,
      action:
        "Updates README, Directory.Packages.props and IMessagePackFormatter.",
    }),
  ).toEqual([]);
});

test("finish_review stores the PR's STAR on the verdict", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const { run } = harness(state);
  await run("describe_change", change);
  await run("finish_review", finish());
  expect(state.verdict?.star).toEqual(star);
});

test("finish_review refuses an invalid STAR twice, then finishes without it", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const { run } = harness(state);
  await run("describe_change", change);
  for (let i = 0; i < 2; i++) {
    const res = await run("finish_review", finish({ result: "I checked it." }));
    expect(res.isError).toBe(true);
    expect(state.verdict).toBeNull();
  }
  const res = await run("finish_review", finish({ result: "I checked it." }));
  expect(res.isError).toBeUndefined();
  expect(state.verdict?.star).toBeUndefined();
  expect(state.verdict?.notChecked.join(" ")).toContain(
    "result speaks in the first person",
  );
});

test("finish_review refuses an invalid STAR without finishing", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const { run } = harness(state);
  await run("describe_change", change);
  const res = await run("finish_review", finish({ action: "" }));
  expect(res.isError).toBe(true);
  expect(res.output[0].text).toContain("Write the action sentence.");
  expect(state.verdict).toBeNull();
});

test("finish_review requires a bounded verification receipt for every changed file", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  state.verifications = [];
  const { run } = harness(state);
  await run("describe_change", change);
  const missing = await run("finish_review", finish());
  expect(missing.isError).toBe(true);
  expect(missing.output[0].text).toContain("verification receipt");
  expect(state.verdict).toBeNull();

  const invalid = await run("record_verification", {
    files: ["src/TypeCollector.cs"],
    target: "TypeCollector.GetTypeArguments",
    property: "Closed generic arguments stay in bounds.",
    harm: "The source generator can throw for a valid user type.",
    method: "Dafny",
    checker: "Dafny 4.10",
    command: "dafny verify verification/TypeArguments.dfy",
    outcome: "passed",
    result: "Verified for every modeled input.",
    scope: "Type arities 0 through 4.",
    assumptions: ["The model matches the source indexing rules."],
    limits: ["Does not verify reflection metadata."],
  });
  expect(invalid.isError).toBe(true);
  expect(invalid.output[0].text).toContain("broken_variant");

  const recorded = await run("record_verification", {
    files: ["src/TypeCollector.cs"],
    target: "TypeCollector.GetTypeArguments",
    property: "Closed generic arguments stay in bounds.",
    harm: "The source generator can throw for a valid user type.",
    method: "Dafny",
    checker: "Dafny 4.10",
    command: "dafny verify verification/TypeArguments.dfy",
    outcome: "passed",
    result: "Verified for every modeled input.",
    scope: "Type arities 0 through 4.",
    broken_variant: "Removing the arity guard produces a failed bound proof.",
    assumptions: ["The model matches the source indexing rules."],
    limits: ["Does not verify reflection metadata."],
  });
  expect(recorded.isError).toBeUndefined();
  await run("finish_review", finish());
  expect(state.verdict).not.toBeNull();
});

test("finish gate rejects every incomplete receipt set in a two-file review", async () => {
  const paths = ["src/TypeCollector.cs", "tests/TypeCollector.test.cs"];
  for (const covered of [[], [paths[0]], [paths[1]], paths]) {
    const state = reviewWith(paths);
    state.verifications = covered.length
      ? [
          receiptFrom(`receipt-${covered.length}`, {
            files: covered,
            target: "generic type lookup",
            property:
              "A review cannot settle before every changed file has a receipt.",
            harm: "The owner could mistake an uncovered change for checked work.",
            method: "property test",
            checker: "Bun 1.4",
            command: "bun test tests/changes.test.ts",
            outcome: "passed",
            result: "Every bounded coverage combination behaved as expected.",
            scope: "The four receipt subsets of a two-file review.",
            broken_variant:
              "Removing the completion check lets a one-file receipt settle the review.",
            assumptions: [
              "The Durable Object invokes finish_review once per completion.",
            ],
            limits: [
              "This is a bounded two-file check, not a proof of all runtime failures.",
            ],
          }),
        ]
      : [];
    const { run } = harness(state);
    await run("describe_change", { ...change, files: paths });
    const result = await run("finish_review", finish());
    if (covered.length === paths.length) {
      expect(result.isError).toBeUndefined();
      expect(state.verdict).not.toBeNull();
    } else {
      expect(state.verdict).toBeNull();
      expect(result.isError).toBe(true);
      expect(result.output[0].text).toContain("verification receipt");
    }
  }
});

test("describe_change records a change, lowercases tags and replaces by title", async () => {
  const state = reviewWith(["src/TypeCollector.cs", "tests/T.cs"]);
  const { run } = harness(state);
  expect((await run("describe_change", change)).isError).toBeUndefined();
  await run("describe_change", {
    ...change,
    files: ["src/TypeCollector.cs", "tests/T.cs"],
  });
  expect(state.changes).toHaveLength(1);
  expect(state.changes?.[0].tags).toEqual(["bug fix", "source generator"]);
  expect(state.changes?.[0].summary).toBe(change.summary);
  expect(state.changes?.[0].files).toEqual([
    "src/TypeCollector.cs",
    "tests/T.cs",
  ]);
  expect(uncoveredFiles(state)).toEqual([]);
});

test("describe_change refuses a bad summary twice, then records the change without it", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const { run } = harness(state);
  for (let i = 0; i < 2; i++) {
    const res = await run("describe_change", {
      ...change,
      summary: "I fixed it.",
    });
    expect(res.isError).toBe(true);
    expect(state.changes).toEqual([]);
  }
  const res = await run("describe_change", {
    ...change,
    summary: "I fixed it.",
  });
  expect(res.isError).toBeUndefined();
  expect(state.changes?.[0].summary).toBeUndefined();
  expect(uncoveredFiles(state)).toEqual([]);
});

test("describe_change refuses invalid input without recording it", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const res = await harness(state).run("describe_change", {
    ...change,
    files: ["other.cs"],
  });
  expect(res.isError).toBe(true);
  expect(state.changes).toEqual([]);
});

test("finish_review refuses twice while files are uncovered, then lists them as not checked", async () => {
  const state = reviewWith([
    "src/TypeCollector.cs",
    "Directory.Packages.props",
  ]);
  const { run } = harness(state);
  await run("describe_change", change);
  for (let i = 0; i < 2; i++) {
    const res = await run("finish_review", finish());
    expect(res.isError).toBe(true);
    expect(res.output[0].text).toContain("Directory.Packages.props");
    expect(state.verdict).toBeNull();
  }
  await run("finish_review", finish({ not_checked: ["other"] }));
  expect(state.verdict?.notChecked).toEqual([
    "No CI or team standard evidence snapshot was captured for this review.",
    "These changed files are not part of any described change: Directory.Packages.props.",
    "other",
  ]);
});

test("reviews stored before changes existed finish without the gate", async () => {
  const state: ReviewState = {
    ...reviewWith([]),
    files: undefined,
    changes: undefined,
  };
  await harness(state).run("finish_review", finish());
  expect(state.verdict?.notChecked).toEqual([
    "No CI or team standard evidence snapshot was captured for this review.",
  ]);
});

test("missing receipts never bypass the gate after repeated completion attempts", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  state.verifications = [];
  const { run } = harness(state);
  await run("describe_change", change);
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await run("finish_review", finish());
    expect(result.isError).toBe(true);
    expect(state.verdict).toBeNull();
  }
});

test("explicit unrun and counterexample receipts persist without becoming passes", async () => {
  for (const outcome of ["not_run", "counterexample"] as const) {
    const state = reviewWith(["src/TypeCollector.cs"]);
    const seed = state.verifications![0];
    state.verifications = [];
    const { run } = harness(state);
    await run("describe_change", change);
    const result =
      outcome === "not_run"
        ? "Not run: the verifier setup failed because the toolchain is unavailable."
        : "Counterexample trace: the second generic argument indexes beyond the bound.";
    const { id: _id, brokenVariant: _broken, ...fields } = seed;
    const recorded = await run("record_verification", {
      ...fields,
      outcome,
      result,
    });
    expect(recorded.isError).toBeUndefined();
    expect(state.verifications?.[0].outcome).toBe(outcome);
    expect(state.verifications?.[0].result).toBe(result);
    expect(state.verifications?.[0].brokenVariant).toBeNull();
    await run("finish_review", finish());
    expect(state.verdict).not.toBeNull();
  }
});

const findingInput = {
  path: "src/TypeCollector.cs",
  line: 12,
  severity: "high",
  class: "correctness",
  confidence: "verified",
  title: "Closed generic arguments index outside the parameter list",
  body: "The second argument indexes a one-element parameter list.",
  reason: "A valid closed generic type crashes source generation.",
  evidence: {
    kind: "code",
    detail:
      "Lines 10-12 index arguments using an unchecked caller-supplied arity.",
  },
  fix: "Check the argument arity before indexing and resolve through the constructed type.",
};

test("finding evidence boundaries require reason evidence and fix without recording invalid claims", async () => {
  for (const field of ["reason", "evidence", "fix"] as const) {
    for (const value of ["", "   ", "x".repeat(901), undefined]) {
      const state = reviewWith([findingInput.path]);
      const input =
        field === "evidence"
          ? { ...findingInput, evidence: { kind: "code", detail: value } }
          : { ...findingInput, [field]: value };
      const result = await harness(state).run("report_finding", input);
      expect(result.isError).toBe(true);
      expect(state.findings).toHaveLength(0);
      expect(result.output[0].text).toContain(field);
    }
  }
});

test("findings accept code docs tests scanners and several supporting reasons", async () => {
  for (const kind of ["code", "docs", "test", "scanner"]) {
    const state = reviewWith([findingInput.path]);
    const { run } = harness(state);
    const result = await run("report_finding", {
      ...findingInput,
      evidence: {
        kind,
        detail:
          "Pinned source lines 10-12 and the relevant existing output establish the failure.",
        supporting: [
          "The arity test fails on the pinned head with IndexOutOfRange.",
          "Pinned contract reference identifies the accepted input.",
        ],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(state.findings[0].reason).toBe(findingInput.reason);
    expect(state.findings[0].evidence?.kind).toBe(kind);
    expect(state.findings[0].evidence?.supporting).toHaveLength(2);
    await run("describe_change", change);
    await run("finish_review", finish());
    expect(state.verdict?.decision).toBe("changes_requested");
  }
});

test("receipt links reject dangling cross-finding and wrong-path references", async () => {
  const state = reviewWith([findingInput.path]);
  const { run } = harness(state);
  const linked = {
    ...findingInput,
    evidence: { ...findingInput.evidence, verification_id: "seed" },
  };
  expect(
    (
      await run("report_finding", {
        ...linked,
        evidence: { ...linked.evidence, verification_id: "missing" },
      })
    ).isError,
  ).toBe(true);
  expect(
    (await run("report_finding", { ...linked, path: "other.cs" })).isError,
  ).toBe(true);
  expect(state.findings).toHaveLength(0);
  expect((await run("report_finding", linked)).isError).toBeUndefined();
  expect((await run("report_finding", linked)).isError).toBe(true);
  expect(state.findings).toHaveLength(1);
  expect(state.findings[0].evidence?.verificationId).toBe("seed");
});

test("unrun or passing receipts cannot promote execution claims to verified findings", async () => {
  for (const outcome of ["not_run", "passed", "counterexample"] as const) {
    const state = reviewWith([findingInput.path]);
    state.verifications![0].outcome = outcome;
    const { run } = harness(state);
    const result = await run("report_finding", {
      ...findingInput,
      evidence: {
        kind: "execution",
        detail: "The targeted arity reproducer fails on the pinned head.",
        verification_id: "seed",
      },
    });
    expect(result.isError === true).toBe(outcome !== "counterexample");
    expect(state.findings).toHaveLength(outcome === "counterexample" ? 1 : 0);
  }
  const state = reviewWith([findingInput.path]);
  state.verifications![0].outcome = "not_run";
  const { run } = harness(state);
  const result = await run("report_finding", {
    ...findingInput,
    evidence: { ...findingInput.evidence, verification_id: "seed" },
  });
  expect(result.isError).toBe(true);
  expect(state.findings).toHaveLength(0);
});

test("hypotheses stay possible and cannot become verified by linking a receipt", async () => {
  const state = reviewWith([findingInput.path]);
  const { run } = harness(state);
  for (const confidence of ["verified", "likely", "possible"]) {
    const result = await run("report_finding", {
      ...findingInput,
      confidence,
      evidence: {
        kind: "hypothesis",
        detail: "Runtime input limits remain unknown.",
        verification_id: "seed",
      },
    });
    expect(result.isError === true).toBe(confidence !== "possible");
  }
  expect(state.findings).toHaveLength(1);
  await run("describe_change", change);
  await run("finish_review", finish());
  expect(state.verdict?.decision).toBe("no_blockers_found");
});

test("recorded evidence stays immutable when another check has the same target", async () => {
  const state = reviewWith([findingInput.path]);
  const { run } = harness(state);
  const { id: _id, brokenVariant, ...input } = state.verifications![0];
  await run("report_finding", {
    ...findingInput,
    evidence: { ...findingInput.evidence, verification_id: "seed" },
  });
  const result = await run("record_verification", {
    ...input,
    broken_variant: brokenVariant,
  });
  expect(result.isError).toBeUndefined();
  expect(state.verifications).toHaveLength(2);
  expect(state.verifications![0].id).toBe("seed");
  expect(state.findings[0].evidence?.verificationId).toBe("seed");
});

test("zero findings still require file dispositions and can finish with explicit unrun coverage", async () => {
  const state = reviewWith([findingInput.path]);
  state.verifications = [];
  const { run } = harness(state);
  await run("describe_change", change);
  expect((await run("finish_review", finish())).isError).toBe(true);
  const seed = reviewWith([findingInput.path]).verifications![0];
  const { id: _id, brokenVariant: _broken, ...input } = seed;
  expect(
    (
      await run("record_verification", {
        ...input,
        outcome: "not_run",
        result:
          "Not run: this documentation-only path has no runtime behavior.",
      })
    ).isError,
  ).toBeUndefined();
  expect((await run("finish_review", finish())).isError).toBeUndefined();
  expect(state.findings).toHaveLength(0);
  expect(state.verdict?.decision).toBe("no_blockers_found");
  expect(state.verifications![0].outcome).toBe("not_run");
});

test("execution without a record and blank supporting evidence are refused", async () => {
  for (const evidence of [
    { kind: "execution", detail: "Failed at arity 2." },
    { kind: "code", detail: "Indexing is unguarded.", supporting: [" "] },
  ]) {
    const state = reviewWith([findingInput.path]);
    const result = await harness(state).run("report_finding", {
      ...findingInput,
      evidence,
    });
    expect(result.isError).toBe(true);
    expect(state.findings).toHaveLength(0);
  }
});

test("fix outcomes persist through record_verification and remain separate from the original failure", async () => {
  for (const outcome of ["passed", "failed"] as const) {
    const state = reviewWith([findingInput.path]);
    const { run } = harness(state);
    const {
      id: _id,
      brokenVariant: _broken,
      ...seed
    } = state.verifications![0];
    const input = {
      ...seed,
      outcome: "counterexample",
      result: "Failed at arity 2 on the reviewed head.",
      fix_check: {
        command: "bun test arity-repro.ts",
        before: "Failed at arity 2.",
        after:
          outcome === "passed"
            ? "Passed with the proposed guard."
            : "Failed with the proposed guard.",
        outcome,
      },
    };
    expect((await run("record_verification", input)).isError).toBeUndefined();
    const receipt = state.verifications!.at(-1)!;
    expect(receipt.outcome).toBe("counterexample");
    expect(receipt.fixCheck?.outcome).toBe(outcome);
    expect(
      (
        await run("report_finding", {
          ...findingInput,
          evidence: {
            kind: "execution",
            detail: input.result,
            verification_id: receipt.id,
          },
        })
      ).isError,
    ).toBeUndefined();
    const invalid = await run("record_verification", {
      ...input,
      outcome: "not_run",
      result: "Not run: setup failed.",
    });
    expect(invalid.isError).toBe(true);
  }
});
