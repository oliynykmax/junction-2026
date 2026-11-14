import { expect, test } from "bun:test";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { FileDiffs } from "../web/diff";
import type { ChangedFile, Finding } from "../web/shared";

const PATCH = [
  "@@ -1,2 +1,6 @@", //                 1
  " using System;", //                  2
  " public void Write(Value v)", //     3
  "+    writer.Write(v.Id);", //         4  new 3
  "+    writer.Write(v.Name);", //       5  new 4
  "+    writer.Write(v.Size);", //       6  new 5
  "+    writer.Flush();", //             7  new 6
].join("\n");

const file: ChangedFile = {
  path: "src/W.cs",
  status: "modified",
  additions: 4,
  deletions: 0,
  patch: PATCH,
};

const finding = (line: number) =>
  ({
    id: "f1",
    path: "src/W.cs",
    line,
    severity: "medium",
    class: "correctness",
    confidence: "likely",
    title: "Flush before dispose",
    body: "b",
    source: "agent",
    suggestedPatch: null,
  }) as unknown as Finding;

const render = (readings?: object, findings: Finding[] = []) =>
  renderToString(
    h(FileDiffs, {
      files: [file],
      findings,
      focus: null,
      onFocus: () => {},
      lineUrl: () => "#",
      readings: readings as never,
    }),
  );

const plan = { remove: [], fold: [{ start_line: 5, end_line: 6 }], replace: [] };

test("without a plan the file shows in full, using directives included", () => {
  const html = render();
  expect(html).toContain("using System;");
  expect(html).toContain("writer.Write(v.Size);");
  expect(html).not.toContain("reading-bar");
});

test("a plan opens the reading view with the kept count and a full-diff toggle", () => {
  const html = render({ "src/W.cs": plan });
  expect(html).toContain("Reading view: kept 2/4 changed lines.");
  expect(html).toContain("Show full diff");
  expect(html).toContain("1 using directive hidden automatically. Show");
  expect(html).toContain('aria-label="Show 2 folded lines"');
  expect(html).not.toContain("writer.Write(v.Name);");
  expect(html).not.toContain("writer.Write(v.Size);");
  expect(html).toContain("writer.Flush();");
});

test("hidden changed lines say who hid them; hidden context is a thin marker", () => {
  const changed = render({
    "src/W.cs": { remove: [{ start_line: 4, end_line: 4 }], fold: [], replace: [] },
  });
  expect(changed).toContain("1 changed line hidden by the AI. Show");
  const context = render({
    "src/W.cs": { remove: [{ start_line: 3, end_line: 3 }], fold: [], replace: [] },
  });
  expect(context).toContain('aria-label="Show 1 unchanged or blank line"');
  expect(context).not.toContain("hidden by the AI");
});

test("a plan that would hide a cited line falls back to the full diff", () => {
  // Patch line 5 is new-side line 4, inside the fold.
  const html = render({ "src/W.cs": plan }, [finding(4)]);
  expect(html).toContain("no longer fits its findings, so the full diff is shown");
  expect(html).toContain("writer.Write(v.Name);");
  expect(html).toContain("using System;");
  expect(html).not.toContain("Show full diff");
});

test("a cited line outside the plan's hidden lines keeps the reading view", () => {
  const html = render({ "src/W.cs": plan }, [finding(6)]);
  expect(html).toContain("Reading view: kept 2/4 changed lines.");
  expect(html).toContain("Flush before dispose");
});
