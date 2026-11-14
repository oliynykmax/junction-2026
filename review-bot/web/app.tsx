import type { ChangedFile } from "./shared";

const MOCK_FILES = [
  {
    path: "src/reviews/cache.ts",
    status: "modified",
    additions: 5,
    deletions: 4,
    patch: `@@ -1,7 +1,8 @@
 const reviews = new Map<string, Review>();
${" "}
-export function getReview(pr: number) {
-  return reviews.get(String(pr));
+export function getReview(pr: number, headSha: string) {
+  const key = [pr, headSha].join(":");
+  return reviews.get(key);
 }
${" "}
-export function saveReview(pr: number, review: Review) {
+export function saveReview(pr: number, headSha: string, review: Review) {
@@ -8,2 +9,2 @@
-  reviews.set(String(pr), review);
+  reviews.set([pr, headSha].join(":"), review);
 }`,
  },
  {
    path: "tests/reviews/cache.test.ts",
    status: "added",
    additions: 14,
    deletions: 0,
    patch: `@@ -0,0 +1,14 @@
+import { expect, test } from "bun:test";
+import { getReview, saveReview } from "../../src/reviews/cache";
+
+test("a new commit does not reuse the previous review", () => {
+  const review = { summary: "First commit reviewed" };
+  saveReview(42, "abc1234", review);
+
+  expect(getReview(42, "abc1234")).toEqual(review);
+  expect(getReview(42, "def5678")).toBeUndefined();
+});
+
+test("an unknown pull request has no cached review", () => {
+  expect(getReview(99, "abc1234")).toBeUndefined();
+});`,
  },
] satisfies ChangedFile[];

export type PageConfig = {
  api: string;
  pollMs: number;
  prUrl: string;
  owner: string;
  repo: string;
  number: string;
};

export function App({ prUrl, owner, repo, number }: PageConfig) {
  const demo = new URLSearchParams(window.location.search).get("demo") === "1";

  const identity: PrIdentity = demo
    ? {
        title: "Keep review results scoped to the commit",
        number: "42",
        author: "alex-chen",
        updated: "updated 2h ago",
        base: "main",
        head: "fix/commit-cache",
        files: MOCK_FILES.length,
        additions: MOCK_FILES.reduce((sum, file) => sum + file.additions, 0),
        deletions: MOCK_FILES.reduce((sum, file) => sum + file.deletions, 0),
      }
    : { title: `${owner}/${repo}`, number };

  const requestedCheck = new URLSearchParams(window.location.search).get(
    "check",
  );
  if (demo && requestedCheck !== null) {
    return (
      <BotCheckPage
        check={BOT_CHECKS.find((check) => check.id === requestedCheck)}
      />
    );
  }

  return (
    <>
      <PrHeader identity={identity} href={prUrl} />
      {demo && (
        <main class="page pr-body">
          <section class="title">
            <div>
              <p class="summary">
                A new push should get a fresh review. Key cached results by pull
                request and commit so an earlier result cannot appear on new
                code.
              </p>
              <p class="muted">
                Synthetic PR for layout exploration. Checks have not been run.
              </p>
            </div>
          </section>
          <CiChecks />
        </main>
      )}
    </>
  );
}

type PrIdentity = {
  title: string;
  number: string;
  author?: string;
  updated?: string;
  base?: string;
  head?: string;
  files?: number;
  additions?: number;
  deletions?: number;
};

function PrHeader({ identity, href }: { identity: PrIdentity; href: string }) {
  const { title, number, author, updated, base, head, files } = identity;
  return (
    <header class="pr-header">
      <div class="pr-header-inner">
        <div class="pr-title-row">
          <h1 class="pr-title">
            {title} <span class="pr-number">#{number}</span>
          </h1>
          <a
            class="pr-github"
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label="Open pull request on GitHub"
            title="Open pull request on GitHub"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M14 3h7v7M21 3l-10 10" />
              <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
            </svg>
          </a>
        </div>
        <div class="pr-row">
          {author && (
            <p class="pr-author">
              <span class="pr-avatar" aria-hidden="true">
                {author.slice(0, 1).toUpperCase()}
              </span>
              <span class="pr-author-name">{author}</span>
              {updated && <span class="pr-muted">· {updated}</span>}
            </p>
          )}
          <code class="pr-checkout">gh pr checkout {number}</code>
        </div>
        {base && head && (
          <div class="pr-row">
            <p class="pr-branches">
              <span class="pr-base">{base}</span>
              <span class="pr-muted" aria-label="from">
                ←
              </span>
              <span class="pr-muted">{head}</span>
            </p>
            {files !== undefined && (
              <p class="pr-stats">
                <span class="pr-muted">
                  {files} {files === 1 ? "file" : "files"}
                </span>
                <span class="pr-add">+{identity.additions}</span>
                <span class="pr-del">−{identity.deletions}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

type CiState = "passed" | "running" | "queued";
type CheckBase = { name: string; state: CiState; duration: string };
type BotCheck = CheckBase & {
  kind: "builtin";
  id: string;
  summary: string;
  command: string;
  output: string;
};
type CiCheck = BotCheck | (CheckBase & { kind: "github"; href: string });

const BOT_CHECKS: BotCheck[] = [
  {
    kind: "builtin",
    id: "static-analysis",
    name: "Static analysis",
    state: "passed",
    duration: "8s",
    summary: "No diagnostics in the two changed files.",
    command: "bunx oxlint src/reviews/cache.ts tests/reviews/cache.test.ts",
    output:
      "[sample output]\nChecking 2 changed files…\n0 errors, 0 warnings\nCompleted in 8s.",
  },
  {
    kind: "builtin",
    id: "commit-isolation",
    name: "Commit isolation",
    state: "running",
    duration: "24s elapsed",
    summary:
      "Checking that a new commit cannot reuse a cached review from an earlier commit.",
    command: "bun test tests/reviews/cache.test.ts",
    output:
      "[sample output]\nPASS  A known commit retrieves its stored review\nRUN   A new commit does not reuse the previous review\nWaiting for the current check to finish…",
  },
  {
    kind: "builtin",
    id: "broken-variants",
    name: "Broken variants",
    state: "queued",
    duration: "Not started",
    summary:
      "Waiting for commit isolation. The check will remove the commit from the cache key and confirm the isolation check catches it.",
    command: "Not started",
    output: "No output yet. This mock check is queued.",
  },
];

const CI_SOURCES: { name: string; checks: CiCheck[] }[] = [
  {
    name: "GitHub Actions",
    checks: [
      {
        kind: "github",
        name: "Install",
        state: "passed",
        duration: "12s",
        href: "https://github.com/oliynykmax/junction-2026/actions/runs/43613592339/job/132503728867#step:5:1",
      },
      {
        kind: "github",
        name: "Build",
        state: "passed",
        duration: "28s",
        href: "https://github.com/oliynykmax/junction-2026/actions/runs/43613592339/job/132503728867#step:13:1",
      },
      {
        kind: "github",
        name: "Tests",
        state: "passed",
        duration: "44s",
        href: "https://github.com/oliynykmax/junction-2026/actions/runs/43613592339/job/132503728867#step:9:1",
      },
    ],
  },
  { name: "Bumble Bot", checks: BOT_CHECKS },
];
const CI_LABELS: Record<CiState, string> = {
  passed: "Passed",
  running: "Running",
  queued: "Queued",
};

function CiIcon({ state }: { state: CiState }) {
  return (
    <svg
      class={`ci-icon ci-${state}`}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5" />
      {state === "passed" ? (
        <path
          d="m6.5 10 2.3 2.3 4.7-4.7"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      ) : (
        <circle
          cx="10"
          cy="10"
          r={state === "running" ? "3" : "1.5"}
          fill="currentColor"
        />
      )}
    </svg>
  );
}

function CiChecks() {
  return (
    <details class="ci-block" open>
      <summary class="ci-heading">
        <span>
          Checks{" "}
          <svg
            class="ci-chevron"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m4 6 4 4 4-4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="ci-demo-label">Mock results</span>
      </summary>
      <div class="ci-results">
        {CI_SOURCES.flatMap((source) =>
          source.checks.map((check) => {
            const resultUrl = new URL(window.location.href);
            if (check.kind === "builtin")
              resultUrl.searchParams.set("check", check.id);
            return (
              <a
                class="ci-result"
                key={`${source.name}-${check.name}`}
                href={
                  check.kind === "github" ? check.href : resultUrl.toString()
                }
                target={check.kind === "github" ? "_blank" : undefined}
                rel={check.kind === "github" ? "noreferrer" : undefined}
              >
                <CiIcon state={check.state} />
                <span class="ci-result-name">
                  {check.name}
                  <span class="ci-origin">{source.name}</span>
                </span>
                <span class="ci-result-status">{CI_LABELS[check.state]}</span>
              </a>
            );
          }),
        )}
      </div>
    </details>
  );
}

function BotCheckPage({ check }: { check: BotCheck | undefined }) {
  const back = new URL(window.location.href);
  back.searchParams.delete("check");
  return (
    <main class="bot-check-page ci-block">
      <a class="bot-check-back" href={back.toString()}>
        ← Pull request checks
      </a>
      <p class="bot-check-source">
        Bumble Bot · mock result · commit <code>abc1234</code>
      </p>
      {!check ? (
        <h1>Check not found</h1>
      ) : (
        <>
          <div class="bot-check-title">
            <CiIcon state={check.state} />
            <h1>{check.name}</h1>
          </div>
          <div class="bot-check-meta">
            <span class={`ci-${check.state}`}>{CI_LABELS[check.state]}</span>
            <span>{check.duration}</span>
          </div>
          <p class="bot-check-summary">{check.summary}</p>
          <section class="bot-check-output" aria-labelledby="output-heading">
            <h2 id="output-heading">Output</h2>
            <pre>
              <code>
                {check.command}
                {"\n\n"}
                {check.output}
              </code>
            </pre>
          </section>
          <p class="bot-check-disclaimer">
            Preview data only. No checks are executing and this output is
            illustrative.
          </p>
        </>
      )}
    </main>
  );
}
