import { expect, test } from "bun:test";

import { planChecks, renderScan } from "../src/scanners";

test("plans CI and formatting evidence for every changed supported language", () => {
  const checks = planChecks([
    { filename: "src/review.ts", status: "modified" },
    { filename: "scanner/app.py", status: "modified" },
    { filename: "src/MessagePack/Formatter.cs", status: "modified" },
  ]);

  expect(checks).toEqual([
    { tool: "ty", paths: ["scanner/app.py"] },
    { tool: "oxlint", paths: ["src/review.ts"] },
    { tool: "ruff-format", paths: ["scanner/app.py"] },
    { tool: "oxfmt", paths: ["src/review.ts"] },
    {
      tool: "dotnet-ci",
      paths: ["src/MessagePack/Formatter.cs"],
    },
    {
      tool: "dotnet-format",
      paths: ["src/MessagePack/Formatter.cs"],
    },
  ]);
});

test("plans .NET checks for build configuration changes and source deletions", () => {
  const checks = planChecks([
    { filename: "Directory.Build.props", status: "modified" },
    { filename: "src/Removed.cs", status: "removed" },
    { filename: "global.json", status: "modified" },
  ]);

  expect(checks).toEqual([
    {
      tool: "dotnet-ci",
      paths: ["Directory.Build.props", "src/Removed.cs", "global.json"],
    },
    {
      tool: "dotnet-format",
      paths: ["Directory.Build.props", "src/Removed.cs", "global.json"],
    },
  ]);
});

test("makes a successful CI or formatter run explicit in review evidence", () => {
  expect(
    renderScan({
      status: "done",
      error: null,
      results: [
        {
          tool: "dotnet-format",
          version: "8.0.402",
          status: "ok",
          durationMs: 21913,
          paths: [
            "src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs",
          ],
          diagnostics: [],
          error: null,
        },
      ],
    }),
  ).toContain("completed successfully with no diagnostics");
});

for (const error of [
  ".NET runner failed: function timed out",
  "SDK not available (installed 8.0.402): requested 10.0.100",
  "Offline .NET preparation failed: package missing; networking blocked",
]) {
  test(`preserves static evidence alongside unavailable .NET checks: ${error}`, () => {
    const rendered = renderScan({
      status: "done",
      error: null,
      results: [
        {
          tool: "ty",
          version: "0.0.104",
          status: "ok",
          durationMs: 1,
          paths: ["app.py"],
          diagnostics: [],
          error: null,
        },
        ...(["dotnet-ci", "dotnet-format"] as const).map((tool) => ({
          tool,
          version: "8.0.402",
          status: "error" as const,
          durationMs: 0,
          paths: ["global.json"],
          diagnostics: [],
          error,
        })),
      ],
    });
    expect(rendered).toContain("completed successfully with no diagnostics");
    expect(rendered).toContain(
      `dotnet-ci 8.0.402 on global.json\nfailed: ${error}`,
    );
    expect(rendered).toContain(
      `dotnet-format 8.0.402 on global.json\nfailed: ${error}`,
    );
    expect(rendered).toContain("List this under not_checked.");
  });
}

test("plans repository checks for root and nested EditorConfig-only changes", () => {
  for (const filename of [".editorconfig", "src/.editorconfig"]) {
    expect(planChecks([{ filename, status: "modified" }])).toEqual([
      { tool: "dotnet-ci", paths: [filename] },
      { tool: "dotnet-format", paths: [filename] },
    ]);
  }
});
