// Deterministic signals computed from the pull request's patches before the
// agent starts: a test-change lane that catches weakened tests, and a risk
// tier from plain rules that sets how deeply the human owner must read. No
// model is involved, so prompt text in the PR cannot argue with the result.

export const RISK_TIERS = ["low", "medium", "high"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** One rule that fired, with the tier it asks for and the files it is about. */
export type RiskReason = {
  rule: string;
  tier: RiskTier;
  text: string;
  paths: string[];
};

/** What one changed test file did to the tests it holds. */
export type TestChange = {
  path: string;
  status: string;
  testsAdded: number;
  testsRemoved: number;
  assertionsAdded: number;
  assertionsRemoved: number;
  skipsAdded: number;
  /** Plain-language ways this file weakened the tests. Empty when it did not. */
  weakened: string[];
  /** GitHub sent no patch (too large or binary), so the file was not inspected. */
  patchMissing: boolean;
};

export type Risk = {
  tier: RiskTier;
  reasons: RiskReason[];
  tests: TestChange[];
  /** Files the owner reads in full: those named by rules at the overall tier. */
  mustRead: string[];
};

/** How much of the change the named owner reads at each tier. */
export const DEPTH: Record<RiskTier, string> = {
  low: "Read the AI's summary and evidence; a full read of the diff is optional.",
  medium:
    "Read the flagged files in full and spot-check at least one other change.",
  high: "Read the flagged files in full before accepting. The AI's review does not replace that read.",
};

export const riskLine = (tier: RiskTier) =>
  `Risk tier: **${tier}**. ${DEPTH[tier]}`;

type File = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
};

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?)\/|\.Tests?\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i;
const DOC_PATH = /\.(md|mdx|rst|adoc)$|(^|\/)docs?\/|(^|\/)(LICENSE|NOTICE)/i;
const CODE_PATH =
  /\.(cs|fs|vb|[cm]?[jt]sx?|py|go|java|kt|rs|c|cc|cpp|h|hpp|swift|rb|php)$/i;

const TEST_DECL =
  /\[(Fact|Theory|Test|TestMethod|TestCase)\b|^\s*(it|test)\s*\(|\bdef test_\w*|\bfunc Test\w*/g;
const ASSERTION =
  /\bAssert\.\w+|\.Should\(\)|\bexpect\(|\bassert\b|\bself\.assert\w+|\bt\.(Error|Fatal)f?\(/g;
const SKIP =
  /\bSkip\s*=|\[Ignore\b|\.skip\(|\bx(it|describe|test)\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(Now|f)?\(|#if\s+false/g;
const UNSAFE =
  /\bunsafe\b|\bstackalloc\b|\bUnsafe\.\w+|\bMemoryMarshal\.\w+|\bMarshal\.\w+|\bfixed\s*\(/;

// .NET names test classes FooTests.cs; case-sensitive so Contest.cs is code.
const CS_TEST_FILE = /[^/]Tests?\.cs$/;

export const isTestPath = (p: string) =>
  TEST_PATH.test(p) || CS_TEST_FILE.test(p);

/** Added and removed lines of a unified diff, without the +/- prefix. */
function patchLines(patch: string) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

const count = (lines: readonly string[], re: RegExp) =>
  lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function testChange(file: File): TestChange {
  const base = {
    path: file.path,
    status: file.status,
    testsAdded: 0,
    testsRemoved: 0,
    assertionsAdded: 0,
    assertionsRemoved: 0,
    skipsAdded: 0,
    weakened: [] as string[],
    patchMissing: file.patch === null && file.status !== "removed",
  };
  if (file.status === "removed")
    return { ...base, weakened: ["The test file was deleted."] };
  if (file.patch === null) return base;
  const { added, removed } = patchLines(file.patch);
  const t = {
    ...base,
    testsAdded: count(added, TEST_DECL),
    testsRemoved: count(removed, TEST_DECL),
    assertionsAdded: count(added, ASSERTION),
    assertionsRemoved: count(removed, ASSERTION),
    skipsAdded: Math.max(0, count(added, SKIP) - count(removed, SKIP)),
  };
  const lostTests = t.testsRemoved - t.testsAdded;
  const lostAsserts = t.assertionsRemoved - t.assertionsAdded;
  if (lostTests > 0) t.weakened.push(`${plural(lostTests, "test")} removed.`);
  if (lostAsserts > 0)
    t.weakened.push(`${plural(lostAsserts, "assertion")} fewer than before.`);
  if (t.skipsAdded > 0)
    t.weakened.push(`${plural(t.skipsAdded, "skip marker")} added.`);
  return t;
}

/** What every rule may consult besides the file it is matching. */
type Ctx = {
  weak: ReadonlySet<string>;
  hasTests: boolean;
  files: number;
  lines: number;
};

/**
 * One rule. It fires when `when` holds (default: always) and, if it has a
 * `match`, at least one changed file matches; the matching files become its
 * paths. Order is display order. The path rules below are tuned for this repo
 * and MessagePack-CSharp; this table is where to retune them.
 */
type Rule = {
  rule: string;
  tier: RiskTier;
  text: string | ((ctx: Ctx) => string);
  match?: (f: File, ctx: Ctx) => boolean;
  when?: (ctx: Ctx) => boolean;
};

const isCode = (f: File) =>
  CODE_PATH.test(f.path) && !isTestPath(f.path) && !DOC_PATH.test(f.path);
const BUILD_FILE =
  /\.(cs|fs|vb)proj$|(^|\/)Directory\.(Build|Packages)\.(props|targets)$|(^|\/)(global\.json|nuget\.config|package\.json|package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/i;

const RULES: Rule[] = [
  {
    rule: "tests-weakened",
    tier: "high",
    text: "Tests were deleted, skipped or lost assertions. Coding agents most often cheat by editing tests, so a human checks each of these against the requirement.",
    match: (f, ctx) => ctx.weak.has(f.path),
  },
  {
    rule: "serializer-core",
    tier: "high",
    text: "Serializer formatters or resolvers changed. They define the wire format, so a mistake corrupts data other systems read.",
    match: (f) =>
      !isTestPath(f.path) &&
      (/(^|\/)(Formatters?|Resolvers?)\//i.test(f.path) ||
        /(Formatter|Resolver)[^/]*\.(cs|tt)$/i.test(f.path)),
  },
  {
    rule: "unsafe-memory",
    tier: "high",
    text: "Added lines use unsafe code, stackalloc, pointer pinning or raw memory APIs, where a bug corrupts memory instead of throwing.",
    match: (f) =>
      !isTestPath(f.path) &&
      f.patch !== null &&
      patchLines(f.patch).added.some((l) => UNSAFE.test(l)),
  },
  {
    rule: "security-surface",
    tier: "high",
    text: "CI workflows or security-related code changed, where a mistake can leak secrets or let untrusted code run.",
    // The keyword must be a whole path segment or file stem, so AUTHORS.md
    // and author.cs do not count.
    match: (f) =>
      f.path.startsWith(".github/workflows/") ||
      (!DOC_PATH.test(f.path) &&
        /(^|\/)(auth|authentication|authorization|crypto|security|secrets?)(\/|\.\w+$)/i.test(
          f.path,
        )),
  },
  {
    rule: "code-generator",
    tier: "medium",
    text: "A source generator or analyzer changed. It emits code or diagnostics into every consumer's build, so a mistake spreads beyond this repository.",
    match: (f) =>
      !isTestPath(f.path) &&
      /(^|\/)[^/]*(SourceGenerator|Analyzers?)[^/]*\//.test(f.path),
  },
  {
    rule: "public-api",
    tier: "medium",
    text: "The declared public API changed, so callers outside this repository may break.",
    match: (f) => /(^|\/)PublicAPI\.\w+\.txt$/.test(f.path),
  },
  {
    rule: "build-deps",
    tier: "medium",
    text: "Build settings or dependencies changed. Check that every new package exists, is the intended one and is not brand new.",
    match: (f) => BUILD_FILE.test(f.path),
  },
  {
    rule: "untested",
    tier: "medium",
    text: "Production code changed and no test file did, so nothing in this PR shows the new behaviour works.",
    when: (ctx) => !ctx.hasTests,
    match: (f) => isCode(f) && f.status !== "removed",
  },
  {
    rule: "large",
    tier: "medium",
    text: (ctx) =>
      `Large change: ${plural(ctx.files, "file")}, ${plural(ctx.lines, "changed line")}.`,
    when: (ctx) => ctx.lines > 500 || ctx.files > 25,
  },
  {
    rule: "no-patch",
    tier: "medium",
    text: "GitHub sent no diff for these files (too large or binary), so these checks could not inspect them.",
    match: (f) => f.patch === null && f.status !== "removed",
  },
];

export function assessRisk(files: readonly File[]): Risk {
  const tests = files.filter((f) => isTestPath(f.path)).map(testChange);
  const ctx: Ctx = {
    weak: new Set(tests.filter((t) => t.weakened.length).map((t) => t.path)),
    hasTests: tests.length > 0,
    files: files.length,
    lines: files.reduce((n, f) => n + f.additions + f.deletions, 0),
  };
  const reasons: RiskReason[] = RULES.flatMap(
    ({ rule, tier, text, match, when }) => {
      if (when && !when(ctx)) return [];
      const paths = match
        ? files.filter((f) => match(f, ctx)).map((f) => f.path)
        : [];
      if (match && !paths.length) return [];
      return [
        {
          rule,
          tier,
          text: typeof text === "string" ? text : text(ctx),
          paths,
        },
      ];
    },
  );
  if (!reasons.length) {
    const docsOnly = files.every((f) => DOC_PATH.test(f.path));
    reasons.push({
      rule: docsOnly ? "docs-only" : "none",
      tier: "low",
      text: docsOnly
        ? "Only documentation changed."
        : "No risk rule matched these files.",
      paths: [],
    });
  }
  const tier = reasons.reduce<RiskTier>(
    (t, r) => (RISK_TIERS.indexOf(r.tier) > RISK_TIERS.indexOf(t) ? r.tier : t),
    "low",
  );
  const mustRead = [
    ...new Set(reasons.filter((r) => r.tier === tier).flatMap((r) => r.paths)),
  ].sort();
  return { tier, reasons, tests, mustRead };
}

/** The signals as the agent sees them, or undefined before they exist. */
export function renderRisk(risk: Risk | null | undefined): string | undefined {
  if (!risk) return undefined;
  const reasons = risk.reasons
    .map(
      (r) =>
        `- [${r.tier}] ${r.rule}: ${r.text}${r.paths.length ? ` Files: ${r.paths.join(", ")}` : ""}`,
    )
    .join("\n");
  const weak = risk.tests.filter((t) => t.weakened.length);
  const tests = weak.length
    ? weak.map((t) => `- ${t.path}: ${t.weakened.join(" ")}`).join("\n")
    : "No test file was weakened.";
  return `Risk tier: ${risk.tier} (set by these rules, not by you)\n${reasons}\n\nWeakened tests:\n${tests}`;
}
