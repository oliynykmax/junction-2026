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
import { unabridgedFiles } from "../src/reading-gate";
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
    // Every file already shortened, so tests of other gates reach them.
    readings: Object.fromEntries(
      paths.map((p) => [p, { remove: [], fold: [], replace: [] }]),
    ),
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

test("finish_review refuses once while files have no reading plan, then finishes", async () => {
  const state = reviewWith(["src/TypeCollector.cs", "tests/T.cs"]);
  state.readings = {};
  const { run } = harness(state);
  await run("describe_change", {
    ...change,
    files: ["src/TypeCollector.cs", "tests/T.cs"],
  });
  const refused = await run("finish_review", finish());
  expect(refused.isError).toBe(true);
  expect(refused.output[0].text).toContain(
    "no reading view for the owner: src/TypeCollector.cs, tests/T.cs",
  );
  expect(state.verdict).toBeNull();
  // The second call finishes; a missing reading view is not a review gap.
  await run("finish_review", finish());
  expect(state.verdict?.notChecked).toEqual([
    "No CI or team standard evidence snapshot was captured for this review.",
  ]);
});

test("the reading gate skips files without a diff and files out of attempts", () => {
  const state = reviewWith(["a.cs", "b.cs", "c.cs", "d.cs"]);
  state.files = capturedFiles([
    file("a.cs", "@@ -1 +1 @@\n-a\n+b"),
    file("b.cs", undefined),
    file("c.cs", "@@ -1 +1 @@\n-a\n+b"),
    file("d.cs", "@@ -1 +1 @@\n-a\n+b"),
  ]);
  state.readings = { "d.cs": { remove: [], fold: [], replace: [] } };
  state.readingRefusals = { "c.cs": 2 };
  // b.cs has no diff, c.cs used its two attempts, d.cs has a plan.
  expect(unabridgedFiles(state)).toEqual(["a.cs"]);
});

test("a file named like an Object.prototype member still needs its own plan", () => {
  const state = reviewWith(["constructor", "toString"]);
  state.readings = {};
  state.readingRefusals = {};
  expect(unabridgedFiles(state)).toEqual(["constructor", "toString"]);
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
