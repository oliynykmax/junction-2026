import { expect, test } from "bun:test";
import {
  compileReadingPlan,
  isElision,
  keptLine,
  numberedPatch,
  type ReadingPlan,
  type ReadingRow,
} from "../src/reading";

// Line numbers in the patch (1-based) are noted on the right.
const PATCH = [
  "@@ -1,3 +1,4 @@", //                                  1
  " using System;", //                                   2
  "-using System.Linq;", //                              3
  "+using System.Collections.Generic;", //               4
  "+using Json = System.Text.Json;", //                  5
  " namespace MessagePack;", //                          6
  "@@ -20,6 +21,9 @@ public class Formatter", //        7
  "     public void Write(Writer writer, Value v)", //   8
  "     {", //                                           9
  "-        writer.Write(v.Id);", //                      10
  '+        if (v is null) throw new ArgumentNullException(nameof(v), "value must not be null");', // 11
  "+        writer.WriteHeader(v.Kind);", //               12
  "+        writer.Write(v.Id);", //                       13
  "+        writer.Write(v.Name);", //                     14
  "+        writer.Write(v.Size);", //                     15
  "     }", //                                           16
].join("\n");

const plan = (p: Partial<ReadingPlan>): ReadingPlan => ({
  remove: [],
  fold: [],
  replace: [],
  ...p,
});
const compile = (p: Partial<ReadingPlan>, protectedLines: number[] = []) =>
  compileReadingPlan(PATCH, plan(p), {
    path: "src/Formatter.cs",
    protectedLines,
  });

function rows(
  p: Partial<ReadingPlan>,
  protectedLines: number[] = [],
): ReadingRow[] {
  const result = compile(p, protectedLines);
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.rows;
}

const problems = (p: Partial<ReadingPlan>, protectedLines: number[] = []) => {
  const result = compile(p, protectedLines);
  return result.ok ? [] : result.problems;
};

test("numbers the patch for the agent", () => {
  expect(numberedPatch("@@ -1 +1 @@\n-a\n+b\n")).toBe(
    "1|@@ -1 +1 @@\n2|-a\n3|+b",
  );
});

test("an empty plan hides only using directives", () => {
  const result = compile({});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.rows.slice(0, 3)).toEqual([
    { kind: "hunk", line: 1, text: "@@ -1,3 +1,4 @@" },
    { kind: "gap", reason: "using", start_line: 2, end_line: 5 },
    {
      kind: "ctx",
      line: 6,
      text: "namespace MessagePack;",
      old: 3,
      new: 4,
      elided: false,
    },
  ]);
  expect(result.stats).toMatchObject({
    changed: 9,
    visibleChanged: 6,
    usingChanged: 3,
  });
});

test("a hunk of only using directives disappears with its header", () => {
  const usingOnly =
    "@@ -1,2 +1,2 @@\n using System;\n-using A;\n+using B;\n@@ -9 +9 @@\n-x();\n+y();";
  const result = compileReadingPlan(usingOnly, undefined, { path: "a.cs" });
  expect(result.ok && result.rows[0]).toEqual({
    kind: "gap",
    reason: "using",
    start_line: 1,
    end_line: 4,
  });
});

test("using statements and declarations are not directives", () => {
  const body =
    "@@ -1,2 +1,2 @@\n+using var stream = Open();\n+using (var s = Open()) { }";
  const result = compileReadingPlan(body, undefined, { path: "a.cs" });
  expect(result.ok && result.stats.visibleChanged).toBe(2);
});

test("using lines in non-C# files stay visible", () => {
  const result = compileReadingPlan("@@ -1 +1 @@\n+using System;", undefined, {
    path: "notes.md",
  });
  expect(result.ok && result.stats.visibleChanged).toBe(1);
});

test("folds a run of same-kind lines into one indented ... row", () => {
  const out = rows({ fold: [{ start_line: 13, end_line: 15 }] });
  expect(out).toContainEqual({
    kind: "fold",
    sign: "add",
    indent: "        ",
    start_line: 13,
    end_line: 15,
  });
  expect(out.some((r) => r.kind === "add" && r.line === 14)).toBe(false);
});

test("removed lines come back as a gap the viewer can expand", () => {
  const out = rows({ remove: [{ start_line: 8, end_line: 9 }] });
  expect(out).toContainEqual({
    kind: "gap",
    reason: "removed",
    start_line: 8,
    end_line: 9,
  });
});

test("elides part of a line, keeping everything else verbatim", () => {
  const out = rows({
    replace: [
      { line: 11, old: 'nameof(v), "value must not be null"', new: "..." },
    ],
  });
  expect(out).toContainEqual({
    kind: "add",
    line: 11,
    text: "        if (v is null) throw new ArgumentNullException(...);",
    old: null,
    new: 21 + 2,
    elided: true,
  });
});

test("an elision cannot drop characters without a visible ...", () => {
  expect(isElision("!allowed", "allowed")).toBe(false);
  expect(isElision("!allowed", "...allowed")).toBe(true);
  expect(isElision("a(b, c)", "a(...)")).toBe(true);
  expect(isElision("a(b, c)", "a(x...)")).toBe(false);
  expect(isElision("a(b)", "a(b)...")).toBe(false); // ... must stand for something
  expect(isElision("abc", "a......c")).toBe(false);
  expect(isElision("abc", "a...…c")).toBe(false);
});

test("refuses an elision that invents text", () => {
  expect(
    problems({ replace: [{ line: 13, old: "v.Id", new: "v.Key..." }] })[0],
  ).toMatch(/keep every character/);
});

test("a line cited by a finding cannot be removed, folded or elided", () => {
  // Line 13 is new-side line 25.
  expect(
    problems({ remove: [{ start_line: 12, end_line: 14 }] }, [25])[0],
  ).toMatch(/cited by a finding/);
  expect(
    problems({ fold: [{ start_line: 13, end_line: 15 }] }, [25])[0],
  ).toMatch(/cited by a finding/);
  expect(
    problems({ replace: [{ line: 13, old: "v.Id", new: "..." }] }, [25])[0],
  ).toMatch(/cited by a finding/);
});

test("a cited using directive stays visible", () => {
  // Line 4 is new-side line 2.
  const out = rows({}, [2]);
  expect(out).toContainEqual({
    kind: "add",
    line: 4,
    text: "using System.Collections.Generic;",
    old: null,
    new: 2,
    elided: false,
  });
});

test("a fold covers one kind of line", () => {
  expect(problems({ fold: [{ start_line: 9, end_line: 11 }] })[0]).toMatch(
    /not a ctx line/,
  );
  expect(problems({ fold: [{ start_line: 12, end_line: 12 }] })[0]).toMatch(
    /at least two lines/,
  );
  expect(problems({ fold: [{ start_line: 3, end_line: 6 }] })[0]).toMatch(
    /not a del line/,
  );
  expect(problems({ fold: [{ start_line: 4, end_line: 5 }] })).toEqual([]); // all using: moot
});

test("a hunk header stays while its hunk shows, and goes with the whole hunk", () => {
  // A range spanning one hunk's trailing context and the next header, as
  // agents write them: the header stays because line 10 onward still shows.
  const spanning = rows({ remove: [{ start_line: 6, end_line: 9 }] });
  expect(spanning).toContainEqual({
    kind: "hunk",
    line: 7,
    text: "@@ -20,6 +21,9 @@ public class Formatter",
  });
  expect(spanning).toContainEqual({
    kind: "gap",
    reason: "removed",
    start_line: 8,
    end_line: 9,
  });
  const out = rows({ remove: [{ start_line: 7, end_line: 16 }] });
  expect(out.at(-1)).toEqual({
    kind: "gap",
    reason: "removed",
    start_line: 7,
    end_line: 16,
  });
});

test("refuses overlaps and out-of-range lines, listing every problem", () => {
  const listed = problems({
    remove: [
      { start_line: 12, end_line: 13 },
      { start_line: 13, end_line: 14 },
      { start_line: 3, end_line: 99 },
    ],
    replace: [{ line: 12, old: "v.Kind", new: "..." }],
  });
  expect(listed).toHaveLength(3);
  expect(listed.join("\n")).toMatch(/overlaps an earlier remove/);
  expect(listed.join("\n")).toMatch(/past the end/);
  expect(listed.join("\n")).toMatch(/also removed/);
});

test("old must occur exactly once on the line", () => {
  expect(
    problems({ replace: [{ line: 11, old: "v", new: "..." }] })[0],
  ).toMatch(/exactly once/);
});

test("a no-newline marker follows the line it belongs to", () => {
  const body = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b";
  const result = compileReadingPlan(
    body,
    plan({ remove: [{ start_line: 2, end_line: 2 }] }),
    { path: "a.txt" },
  );
  expect(result.ok && result.rows).toEqual([
    { kind: "hunk", line: 1, text: "@@ -1 +1 @@" },
    { kind: "gap", reason: "removed", start_line: 2, end_line: 3 },
    { kind: "add", line: 4, text: "b", old: null, new: 1, elided: false },
  ]);
});

test("reports how much is still shown", () => {
  const result = compile({ fold: [{ start_line: 13, end_line: 15 }] });
  expect(result.ok && keptLine(result.stats)).toBe("kept 3/9 changed lines");
  expect(
    keptLine({
      changed: 4,
      visibleChanged: 0,
      removedChanged: 4,
      foldedChanged: 0,
      usingChanged: 0,
      folds: 0,
    }),
  ).toBe("hid all 4 changed lines");
});
