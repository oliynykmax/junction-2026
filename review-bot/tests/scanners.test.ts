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

test("plans .NET checks for build configuration changes and ignores removed files", () => {
  const checks = planChecks([
    { filename: "Directory.Build.props", status: "modified" },
    { filename: "src/Removed.cs", status: "removed" },
    { filename: "global.json", status: "modified" },
  ]);

  expect(checks).toEqual([
    { tool: "dotnet-ci", paths: ["Directory.Build.props", "global.json"] },
    {
      tool: "dotnet-format",
      paths: ["Directory.Build.props", "global.json"],
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
