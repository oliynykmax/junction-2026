import { expect, test } from "bun:test";
import {
  assessRisk,
  isTestPath,
  renderRisk,
  testAttention,
  testChange,
} from "../src/signals";

const file = (path: string, patch: string | null, status = "modified") => ({
  path,
  status,
  additions: patch?.split("\n").filter((l) => l.startsWith("+")).length ?? 0,
  deletions: patch?.split("\n").filter((l) => l.startsWith("-")).length ?? 0,
  patch,
});

test("recognises test paths across languages", () => {
  for (const p of [
    "tests/MessagePack.Tests/FooTests.cs",
    "src/Foo.Tests/Bar.cs",
    "web/app.test.tsx",
    "pkg/x_test.go",
    "test_api.py",
  ])
    expect(isTestPath(p)).toBe(true);
  for (const p of ["src/MessagePack/Formatters/Foo.cs", "src/Contest.cs"])
    expect(isTestPath(p)).toBe(false);
});

test("a skip attribute swapped in for [Fact] weakens the test", () => {
  const t = testChange(
    file(
      "tests/FooTests.cs",
      `@@ -1,4 +1,4 @@\n-    [Fact]\n+    [Fact(Skip = "flaky")]\n     public void RoundTrips()`,
    ),
  );
  expect(t.weakened).toEqual(["1 skip marker added."]);
});

test("removed tests and assertions are counted net of additions", () => {
  const t = testChange(
    file(
      "tests/FooTests.cs",
      [
        "@@",
        "-    [Fact]",
        "-    public void Old() { Assert.Equal(1, x); Assert.True(y); }",
        "+    Assert.Equal(2, x);",
      ].join("\n"),
    ),
  );
  expect(t.weakened).toEqual([
    "1 test removed.",
    "1 assertion fewer than before.",
  ]);
});

test("a changed assertion is not a weakened test", () => {
  const t = testChange(
    file("tests/FooTests.cs", "@@\n-Assert.Equal(1, x);\n+Assert.Equal(2, x);"),
  );
  expect(t.weakened).toEqual([]);
});

test("a deleted test file is high risk and must be read", () => {
  const risk = assessRisk([
    file("tests/FooTests.cs", null, "removed"),
    file("src/MessagePack/Foo.cs", "@@\n+var x = 1;"),
  ]);
  expect(risk.tier).toBe("high");
  expect(risk.reasons[0].rule).toBe("tests-weakened");
  expect(risk.mustRead).toEqual(["tests/FooTests.cs"]);
});

test("formatter changes and unsafe code are high risk", () => {
  const risk = assessRisk([
    file("src/MessagePack/Formatters/DateTimeFormatter.cs", "@@\n+var a = 1;"),
    file(
      "src/MessagePack/Internal/Buf.cs",
      "@@\n+Span<byte> s = stackalloc byte[8];",
    ),
    file(
      "tests/DateTimeTests.cs",
      "@@\n+[Fact]\n+public void T() { Assert.True(true); }",
    ),
  ]);
  expect(risk.tier).toBe("high");
  expect(risk.reasons.map((r) => r.rule)).toEqual([
    "serializer-core",
    "unsafe-memory",
  ]);
  expect(risk.mustRead).toEqual([
    "src/MessagePack/Formatters/DateTimeFormatter.cs",
    "src/MessagePack/Internal/Buf.cs",
  ]);
});

test("code without tests and a public API change are medium", () => {
  const risk = assessRisk([
    file("src/MessagePack/Foo.cs", "@@\n+public int X;"),
    file("src/MessagePack/PublicAPI.Unshipped.txt", "@@\n+MessagePack.Foo.X"),
  ]);
  expect(risk.tier).toBe("medium");
  expect(risk.reasons.map((r) => r.rule)).toEqual(["public-api", "untested"]);
  expect(risk.mustRead).toEqual([
    "src/MessagePack/Foo.cs",
    "src/MessagePack/PublicAPI.Unshipped.txt",
  ]);
});

test("docs only is low, and the agent sees the tier as fixed", () => {
  const risk = assessRisk([file("docs/usage.md", "@@\n+Hello")]);
  expect(risk.tier).toBe("low");
  expect(risk.reasons[0].rule).toBe("docs-only");
  expect(renderRisk(risk)).toContain(
    "Risk tier: low (set by these rules, not by you)",
  );
});

test("files without a diff are reported, not silently passed", () => {
  const risk = assessRisk([
    file("src/MessagePack/Big.cs", null),
    file("tests/BigTests.cs", null),
  ]);
  expect(risk.reasons.map((r) => r.rule)).toContain("no-patch");
  expect(risk.tests[0].patchMissing).toBe(true);
});

test("source generator changes are medium even with tests", () => {
  const risk = assessRisk([
    file(
      "src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs",
      "@@\n+var a = 1;",
    ),
    file(
      "tests/MessagePack.SourceGenerator.Tests/GenericsFormatterTests.cs",
      "@@\n+[Fact]\n+public void T() { Assert.True(true); }",
    ),
  ]);
  expect(risk.tier).toBe("medium");
  expect(risk.mustRead).toEqual([
    "src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs",
  ]);
});

test("security paths need the keyword as a whole segment or stem", () => {
  for (const p of [
    "AUTHORS.md",
    "src/author.cs",
    "docs/securityGuide.md",
    "src/Authority/X.cs",
  ])
    expect(
      assessRisk([file(p, "@@\n+x")]).reasons.map((r) => r.rule),
    ).not.toContain("security-surface");
  for (const p of [
    "src/auth/login.ts",
    "src/Security.cs",
    ".github/workflows/ci.yml",
    "src/secrets/store.py",
  ])
    expect(
      assessRisk([file(p, "@@\n+x")]).reasons.map((r) => r.rule),
    ).toContain("security-surface");
});

test("every Go skip form marks the test weakened", () => {
  for (const call of ['t.Skip("x")', "t.SkipNow()", 't.Skipf("x %d", 1)'])
    expect(
      testChange(file("pkg/x_test.go", `@@\n+\t${call}`)).weakened,
    ).toEqual(["1 skip marker added."]);
});

test("deleting production code with no test change is medium, not low", () => {
  const risk = assessRisk([file("src/MessagePack/Old.cs", null, "removed")]);
  expect(risk.tier).toBe("medium");
  expect(risk.reasons.map((r) => r.rule)).toEqual(["untested"]);
  expect(risk.mustRead).toEqual(["src/MessagePack/Old.cs"]);
});

test("test attention lists weakened and uninspected test files together", () => {
  const risk = assessRisk([
    file("tests/GoneTests.cs", null, "removed"),
    file("tests/HugeTests.cs", null),
    file("tests/FineTests.cs", "@@\n+Assert.True(x);"),
  ]);
  expect(testAttention(risk.tests)).toEqual([
    {
      path: "tests/GoneTests.cs",
      removed: true,
      notes: ["The test file was deleted."],
    },
    {
      path: "tests/HugeTests.cs",
      removed: false,
      notes: ["No diff to inspect, so this lane could not check it."],
    },
  ]);
});
