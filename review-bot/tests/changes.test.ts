import { expect, test } from "bun:test";
import {
  capturedFiles,
  changeProblems,
  EMPTY_REVIEW,
  type ReviewState,
  reviewerExtension,
  starProblems,
  uncoveredFiles,
} from "../src/reviewer";
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

test("change problems flag the summary, tag limits and unknown files", () => {
  expect(changeProblems(change, ["src/TypeCollector.cs"])).toEqual([]);
  const problems = changeProblems(
    {
      ...change,
      tags: ["a", "b", "c", "d"],
      summary: "I added a guard.",
      files: ["nope.cs"],
    },
    ["src/TypeCollector.cs"],
  );
  expect(problems.join(" ")).toContain("summary speaks in the first person");
  expect(
    changeProblems({ ...change, summary: " " }, ["src/TypeCollector.cs"]),
  ).toEqual(["Write the summary sentence."]);
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
