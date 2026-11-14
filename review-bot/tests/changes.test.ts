import { expect, test } from "bun:test";
import {
  capturedFiles,
  changeProblems,
  EMPTY_REVIEW,
  type ReviewState,
  reviewerExtension,
  uncoveredFiles,
} from "../src/reviewer";

const file = (filename: string, patch?: string) => ({
  filename,
  status: "modified",
  additions: 3,
  deletions: 1,
  patch,
});

const star = {
  title: "Guard type-argument lookup",
  tags: ["bug fix", "Source Generator"],
  situation: "The generator threw on closed generic structs.",
  task: "Stop indexing past the type's own parameters.",
  action: "Resolve arguments through the constructed type.",
  result: "Six new tests pass; NativeAOT is unverified.",
  files: ["src/TypeCollector.cs"],
};

function harness(state: ReviewState) {
  const { extension } = reviewerExtension({
    token: async () => "token",
    publish: async () => {},
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

test("change problems flag long STAR parts, tag limits and unknown files", () => {
  expect(changeProblems(star, ["src/TypeCollector.cs"])).toEqual([]);
  const problems = changeProblems(
    {
      ...star,
      task: "x".repeat(300),
      tags: ["a", "b", "c", "d"],
      files: ["nope.cs"],
    },
    ["src/TypeCollector.cs"],
  );
  expect(problems.join(" ")).toContain("task is 300 characters");
  expect(problems.join(" ")).toContain("Give 1 to 3 tags");
  expect(problems.join(" ")).toContain(
    "Not changed in this pull request: nope.cs",
  );
});

test("describe_change records a change, lowercases tags and replaces by title", async () => {
  const state = reviewWith(["src/TypeCollector.cs", "tests/T.cs"]);
  const { run } = harness(state);
  expect((await run("describe_change", star)).isError).toBeUndefined();
  await run("describe_change", {
    ...star,
    files: ["src/TypeCollector.cs", "tests/T.cs"],
  });
  expect(state.changes).toHaveLength(1);
  expect(state.changes?.[0].tags).toEqual(["bug fix", "source generator"]);
  expect(state.changes?.[0].files).toEqual([
    "src/TypeCollector.cs",
    "tests/T.cs",
  ]);
  expect(uncoveredFiles(state)).toEqual([]);
});

test("describe_change refuses invalid input without recording it", async () => {
  const state = reviewWith(["src/TypeCollector.cs"]);
  const res = await harness(state).run("describe_change", {
    ...star,
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
  await run("describe_change", star);
  for (let i = 0; i < 2; i++) {
    const res = await run("finish_review", { summary: "s", not_checked: [] });
    expect(res.isError).toBe(true);
    expect(res.output[0].text).toContain("Directory.Packages.props");
    expect(state.verdict).toBeNull();
  }
  await run("finish_review", { summary: "s", not_checked: ["other"] });
  expect(state.verdict?.notChecked).toEqual([
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
  await harness(state).run("finish_review", { summary: "s", not_checked: [] });
  expect(state.verdict?.notChecked).toEqual([]);
});
