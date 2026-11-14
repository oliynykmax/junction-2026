import { afterEach, expect, test } from "bun:test";
import {
  capturedFiles,
  EMPTY_REVIEW,
  type Finding,
  type ReviewState,
  reviewerExtension,
} from "../src/reviewer";

const PATCH = [
  "@@ -1,3 +1,6 @@", //                1
  " using System;", //                 2
  "+using System.Text;", //            3
  " public void Write(Value v)", //    4
  "+    writer.Write(v.Id);", //        5
  "+    writer.Write(v.Name);", //      6
  "+    writer.Write(v.Size);", //      7
].join("\n");

function reviewWith(files: Record<string, string | undefined>): ReviewState {
  return {
    ...structuredClone(EMPTY_REVIEW),
    target: {
      owner: "o",
      repo: "r",
      number: 1,
      headSha: "a".repeat(40),
      installationId: 1,
    },
    files: capturedFiles(
      Object.entries(files).map(([filename, patch]) => ({
        filename,
        status: "modified",
        additions: 4,
        deletions: 0,
        patch,
      })),
    ),
  };
}

function harness(state: ReviewState) {
  const { extension } = reviewerExtension({
    token: async () => "token",
    publish: async () => {},
    finished: () => {},
    scan: async () => [],
  });
  const api = () => ({
    conversationId: "root",
    callId: "call",
    snapshot: async () => state,
    commit: async (cb: (tx: unknown) => unknown) =>
      cb({ doc: async () => state }),
  });
  return async (name: string, args: unknown) => {
    const tool = extension.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const res = await (tool.execute as any)(args, api(), {});
    return {
      isError: res.isError === true,
      text: res.output[0].text as string,
    };
  };
}

const plan = (rest: object = {}) => ({
  path: "src/W.cs",
  remove: [],
  fold: [],
  replace: [],
  ...rest,
});

const finding = (line: number): Finding => ({
  id: "f1",
  path: "src/W.cs",
  line,
  severity: "medium",
  class: "correctness",
  confidence: "likely",
  title: "t",
  body: "b",
  source: "agent",
  suggestedPatch: null,
});

test("abridge_file records the plan and shows the agent its reading view", async () => {
  const state = reviewWith({ "src/W.cs": PATCH });
  const run = harness(state);
  const res = await run(
    "abridge_file",
    plan({ fold: [{ start_line: 6, end_line: 7 }] }),
  );
  expect(res.isError).toBe(false);
  expect(res.text).toBe(
    [
      "recorded: kept 1/4 changed lines",
      "",
      "@@ -1,3 +1,6 @@",
      "[2 using lines: 2-3]",
      " public void Write(Value v)",
      "+    writer.Write(v.Id);",
      "+    ...",
    ].join("\n"),
  );
  expect(state.readings?.["src/W.cs"]?.fold).toEqual([
    { start_line: 6, end_line: 7 },
  ]);
});

test("calling abridge_file again replaces the file's plan", async () => {
  const state = reviewWith({ "src/W.cs": PATCH });
  const run = harness(state);
  await run("abridge_file", plan({ fold: [{ start_line: 6, end_line: 7 }] }));
  await run("abridge_file", plan({ remove: [{ start_line: 7, end_line: 7 }] }));
  expect(state.readings?.["src/W.cs"]).toEqual({
    remove: [{ start_line: 7, end_line: 7 }],
    fold: [],
    replace: [],
  });
});

test("abridge_file refuses to hide a line a finding cites; the second refusal is final", async () => {
  const state = reviewWith({ "src/W.cs": PATCH });
  // Patch line 6 is new-side line 5.
  state.findings = [finding(5)];
  const run = harness(state);
  const hiding = plan({ fold: [{ start_line: 6, end_line: 7 }] });
  const first = await run("abridge_file", hiding);
  expect(first.isError).toBe(true);
  expect(first.text).toMatch(/Fix every problem[\s\S]*cited by a finding/);
  const second = await run("abridge_file", hiding);
  expect(second.isError).toBe(true);
  expect(second.text).toMatch(
    /no more attempts for src\/W\.cs; the owner sees its full diff[\s\S]*cited by a finding/,
  );
  // Past the limit even a valid plan is not taken, and nothing is compiled.
  const valid = await run(
    "abridge_file",
    plan({ remove: [{ start_line: 7, end_line: 7 }] }),
  );
  expect(valid.isError).toBe(true);
  expect(valid.text).toMatch(/no more attempts for src\/W\.cs/);
  expect(state.readings).toEqual({});
  expect(state.readingRefusals).toEqual({ "src/W.cs": 2 });
});

test("after the limit, an earlier accepted plan stays and the agent is told so", async () => {
  const state = reviewWith({ "src/W.cs": PATCH });
  state.findings = [finding(5)];
  const run = harness(state);
  const accepted = plan({ remove: [{ start_line: 7, end_line: 7 }] });
  expect((await run("abridge_file", accepted)).isError).toBe(false);
  const hiding = plan({ fold: [{ start_line: 6, end_line: 7 }] });
  await run("abridge_file", hiding);
  const final = await run("abridge_file", hiding);
  expect(final.text).toMatch(
    /the owner sees the last plan you recorded for it/,
  );
  expect(state.readings?.["src/W.cs"]?.remove).toEqual([
    { start_line: 7, end_line: 7 },
  ]);
});

test("abridge_file refuses unknown files and files without a stored diff", async () => {
  const state = reviewWith({ "src/W.cs": PATCH, "logo.png": undefined });
  const run = harness(state);
  const unknown = await run("abridge_file", plan({ path: "other.cs" }));
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toMatch(/not a changed file/);
  const binary = await run("abridge_file", plan({ path: "logo.png" }));
  expect(binary.isError).toBe(true);
  expect(binary.text).toMatch(/no stored diff/);
  expect(state.readings).toEqual({});
  expect(state.readingRefusals).toEqual({});
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("read_patch numbers patch lines only when asked", async () => {
  globalThis.fetch = (async () =>
    Response.json([
      {
        filename: "src/W.cs",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
    ])) as unknown as typeof fetch;
  const run = harness(reviewWith({ "src/W.cs": PATCH }));
  expect((await run("read_patch", { path: "src/W.cs" })).text).toBe(
    "@@ -1 +1 @@\n-a\n+b",
  );
  expect(
    (await run("read_patch", { path: "src/W.cs", numbered: true })).text,
  ).toBe("1|@@ -1 +1 @@\n2|-a\n3|+b");
});
