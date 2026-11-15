// The review page: a PR header, the AI's advice, the checks, and either a
// waiting state while the agent works or its findings once it returns.
// ?demo=1 renders the same layout from mock data; ?demo=1&state=verified
// renders a finished review with the verifier's checks, receipts and verdicts.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { blocks } from "../src/findings";
import type { CiItem, CiSource } from "../src/evidence";
import type { PrLive } from "../src/pr-live";
import type { ReviewView } from "../src/review";
import type { ScanResult } from "../src/scanners";
import { Findings } from "./findings";
import { SignOffSection } from "./signoff";
import type { SignOff } from "../src/signoff";
import { RiskBand } from "./risk";
import {
  BLOCKING_RULE,
  type ChangedFile,
  type LineUrl,
  plural,
} from "./shared";
import { FormalDemo } from "./formal";
import { ProofLoader } from "./proof-loader";
import { VERIFIED_DEMO } from "./demo";

export type PageConfig = {
  api: string;
  pollMs: number;
  prUrl: string;
  owner: string;
  repo: string;
  number: string;
  /** Null on public reviews, which have no owner to sign. */
  signOffApi: string | null;
};

export function App(config: PageConfig) {
  const params = new URLSearchParams(window.location.search);
  const formalDemo = params.get("formal-demo");
  if (formalDemo) return <FormalDemo scenario={formalDemo} />;
  if (params.get("demo") !== "1") return <LivePage {...config} />;
  if (params.get("state") === "verified")
    return (
      <>
        <PrHeader identity={DEMO_IDENTITY} href={config.prUrl} />
        <main class="page pr-body">
          <ReviewBody
            view={VERIFIED_DEMO}
            live={null}
            lineUrl={() => config.prUrl}
            signOffApi={null}
            signed={null}
            onSigned={() => {}}
          />
        </main>
      </>
    );
  const requestedCheck = params.get("check");
  if (requestedCheck !== null)
    return (
      <BotCheckPage
        check={BOT_CHECKS.find((check) => check.id === requestedCheck)}
      />
    );
  return (
    <>
      <PrHeader identity={DEMO_IDENTITY} href={config.prUrl} />
      <main class="page pr-body">
        <section class="title">
          <p class="summary">
            A new push should get a fresh review. Key cached results by pull
            request and commit so an earlier result cannot appear on new code.
          </p>
          <p class="muted">
            Synthetic PR for layout exploration. Checks have not been run.
          </p>
        </section>
        <CiChecks checks={demoChecks()} label="Mock results" />
        <AgentWait />
      </main>
    </>
  );
}

const sum = (files: readonly ChangedFile[], key: "additions" | "deletions") =>
  files.reduce((n, file) => n + file[key], 0);

const DEMO_IDENTITY: PrIdentity = {
  title: "Keep review results scoped to the commit",
  number: "42",
  author: "alex-chen",
  updated: "updated 2h ago",
  base: "main",
  head: "fix/commit-cache",
  files: 2,
  additions: 19,
  deletions: 4,
};

const LIVE = new Set<ReviewView["status"]>([
  "running",
  "scanning",
  "not_started",
]);

function useReview(api: string, pollMs: number) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(api, { cache: "no-store" });
        const body = (await res.json()) as ReviewView & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (stopped) return;
        setView(body);
        setError(null);
        if (LIVE.has(body.status)) timer = setTimeout(tick, pollMs);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, pollMs]);

  return { view, error };
}

const PR_LIVE_POLL_MS = 15_000;

/** Whether to read the PR again: after a failed read, while the review runs, or while CI is pending. */
export function keepPolling(
  result: PrLive | null,
  reviewActive: boolean,
): boolean {
  if (!result || reviewActive) return true;
  return [...result.checks.items, ...result.statuses.items].some(
    (i) => i.state === "pending",
  );
}

// The PR's title, author, branches and CI, read from GitHub. The page works
// without it, so failures only delay the next read.
function usePrLive(api: string, reviewActive: boolean) {
  const [live, setLive] = useState<PrLive | null>(null);
  // The review response normally changes this immediately after mount. Keep
  // the latest value for scheduling without restarting an in-flight GitHub
  // read (which otherwise creates two cold /pr requests).
  const reviewActiveRef = useRef(reviewActive);
  reviewActiveRef.current = reviewActive;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      let result: PrLive | null = null;
      try {
        const res = await fetch(`${api}/pr`, { cache: "no-store" });
        if (res.ok) result = (await res.json()) as PrLive;
      } catch {
        result = null;
      }
      if (stopped) return;
      if (result) setLive(result);
      if (keepPolling(result, reviewActiveRef.current))
        timer = setTimeout(tick, PR_LIVE_POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api]);
  return live;
}

function ago(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(iso)) / 60_000),
  );
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.round(hours / 24)}d ago`;
}

function LivePage({
  api,
  pollMs,
  prUrl,
  owner,
  repo,
  number,
  signOffApi,
}: PageConfig) {
  const { view, error } = useReview(api, pollMs);
  // The page stops polling once the review is done, so a fresh sign-off is held here.
  const [justSigned, setJustSigned] = useState<SignOff | null>(null);
  const signed = justSigned ?? view?.signOff ?? null;
  const live = usePrLive(api, !view || LIVE.has(view.status));
  const pr = live?.pr;
  const r = view?.review;
  const files = r?.files ?? [];
  const sha = r?.target?.headSha ?? null;
  const repoUrl = prUrl.replace(/\/pull\/\d+$/, "");
  // A removed file does not exist at the head, so it links to the PR's diff.
  const removed = new Set(
    files.filter((f) => f.status === "removed").map((f) => f.path),
  );
  const lineUrl: LineUrl = (path, line) =>
    !sha
      ? prUrl
      : removed.has(path)
        ? `${prUrl}/files`
        : `${repoUrl}/blob/${sha}/${path}${line ? `#L${line}` : ""}`;
  const identity: PrIdentity = {
    title: pr?.title ?? `${owner}/${repo}`,
    number,
    commit: sha?.slice(0, 7),
    ...(pr && {
      author: pr.author,
      avatarUrl: pr.avatarUrl ?? undefined,
      updated: ago(pr.updatedAt),
      base: pr.base,
      head: pr.head,
    }),
    ...(r?.files && {
      files: files.length,
      additions: sum(files, "additions"),
      deletions: sum(files, "deletions"),
    }),
  };

  return (
    <>
      <PrHeader identity={identity} href={prUrl} />
      <main class="page pr-body">
        {error && (
          <p class="pr-alert" role="alert">
            Could not load the review: {error}. Retrying every 5 seconds.
          </p>
        )}
        {!view ? (
          !error && <AgentWait />
        ) : (
          <ReviewBody
            view={view}
            live={live}
            lineUrl={lineUrl}
            signOffApi={signOffApi}
            signed={signed}
            onSigned={setJustSigned}
          />
        )}
      </main>
    </>
  );
}

function ReviewBody({
  view,
  live,
  lineUrl,
  signOffApi,
  signed,
  onSigned,
}: {
  view: ReviewView;
  live: PrLive | null;
  lineUrl: LineUrl;
  signOffApi: string | null;
  signed: SignOff | null;
  onSigned: (s: SignOff) => void;
}) {
  const reviewing = LIVE.has(view.status);
  const checks = [...ciChecks(live), ...liveChecks(view)];
  return (
    <>
      {reviewing ? <AgentWait /> : <Advice view={view} />}
      <CiChecks
        checks={checks}
        open={!reviewing}
        showFailuresWhenCollapsed={reviewing}
      />
      {view.failure && (
        <p class="pr-alert" role="alert">
          {view.failure}
        </p>
      )}
      <Findings
        findings={view.review.findings}
        verifications={view.review.verifications ?? []}
        verifier={view.review.verifier}
        empty={
          LIVE.has(view.status)
            ? null
            : view.status === "done"
              ? "The AI reported no findings."
              : "No findings were recorded before the review stopped."
        }
        lineUrl={lineUrl}
      />
      {!reviewing && (
        <>
          <RiskBand risk={view.review.risk} lineUrl={lineUrl} />
          <NotChecked view={view} />
          <SignOffSection
            view={view}
            api={signOffApi}
            signed={signed}
            onSigned={onSigned}
          />
        </>
      )}
    </>
  );
}

function AgentWait() {
  return (
    <section class="agent-wait" role="status" aria-live="polite">
      <ProofLoader />
      <p class="agent-wait-title">Verifying if your PR is any good</p>
      <p class="agent-wait-note">Findings will appear here</p>
    </section>
  );
}

// A count of the findings, not a verdict: it can never disagree with them, and
// it leaves the decision to the named human.
function Advice({ view }: { view: ReviewView }) {
  const v = view.review.verdict;
  const findings = view.review.findings;
  const blocking = findings.filter(blocks).length;
  const rest = findings.length - blocking;
  const finished = v !== null;

  let headline: ComponentChildren | null;
  if (findings.length === 0)
    headline = finished
      ? null
      : view.status === "failed"
        ? "The review stopped before it recorded any findings"
        : "No findings yet";
  else if (blocking > 0)
    headline = (
      <>
        <span class="alert">{plural(blocking, "blocking finding")}</span>
        {rest > 0 && `, ${rest} more not blocking`}
        {!finished && " so far"}
      </>
    );
  else
    headline = `${plural(findings.length, "finding")}, none blocking${finished ? "" : " so far"}`;

  return (
    <section class="title advice">
      {headline && (
        <p class="decision" title={BLOCKING_RULE}>
          {headline}
        </p>
      )}
      {view.heldBack > 0 && (
        <p class="note">
          {plural(view.heldBack, "critical or high finding")} the AI could not
          confirm {view.heldBack === 1 ? "is" : "are"} rated possible and{" "}
          {view.heldBack === 1 ? "doesn't" : "don't"} block. Check{" "}
          {view.heldBack === 1 ? "it" : "them"} yourself.
        </p>
      )}
      {finished && <p class="summary">{v.summary}</p>}
      <p class="muted">
        The AI advises. A named human decides whether to merge.
      </p>
    </section>
  );
}

function NotChecked({ view }: { view: ReviewView }) {
  const v = view.review.verdict;
  if (!v) return null;
  return (
    <section class="section" aria-labelledby="nc-h">
      <div class="section-head">
        <h2 id="nc-h">Not checked by the AI</h2>
      </div>
      {v.notChecked.length === 0 ? (
        <p class="empty">The AI listed nothing it left unchecked.</p>
      ) : (
        <ul class="notes">
          {v.notChecked.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

type PrIdentity = {
  title: string;
  number: string;
  author?: string;
  avatarUrl?: string;
  updated?: string;
  base?: string;
  head?: string;
  commit?: string;
  files?: number;
  additions?: number;
  deletions?: number;
};

function PrHeader({ identity, href }: { identity: PrIdentity; href: string }) {
  const { title, number, author, updated, base, head, commit, files } =
    identity;
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
              {identity.avatarUrl ? (
                <img
                  class="pr-avatar"
                  src={identity.avatarUrl}
                  alt=""
                  width="24"
                  height="24"
                />
              ) : (
                <span class="pr-avatar" aria-hidden="true">
                  {author.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span class="pr-author-name">{author}</span>
              {updated && <span class="pr-muted">· {updated}</span>}
            </p>
          )}
          <code class="pr-checkout">gh pr checkout {number}</code>
        </div>
        {((base && head) || commit || files !== undefined) && (
          <div class="pr-row">
            <p class="pr-branches">
              {base && head ? (
                <>
                  <span class="pr-base">{base}</span>
                  <span class="pr-muted" aria-label="from">
                    ←
                  </span>
                  <span class="pr-muted">{head}</span>
                </>
              ) : (
                commit && <span class="pr-muted">commit {commit}</span>
              )}
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

type CiState = "passed" | "failed" | "running" | "queued" | "skipped";
type CheckRow = {
  key: string;
  name: string;
  origin: string;
  state: CiState;
  status: string;
  href?: string;
  external?: boolean;
};
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
  failed: "Failed",
  running: "Running",
  queued: "Queued",
  skipped: "Skipped",
};

function demoChecks(): CheckRow[] {
  return CI_SOURCES.flatMap((source) =>
    source.checks.map((check) => {
      const href = new URL(window.location.href);
      if (check.kind === "builtin") href.searchParams.set("check", check.id);
      return {
        key: `${source.name}-${check.name}`,
        name: check.name,
        origin: source.name,
        state: check.state,
        status: CI_LABELS[check.state],
        href: check.kind === "github" ? check.href : href.toString(),
        external: check.kind === "github",
      };
    }),
  );
}

type Dismissal = NonNullable<
  ReviewView["review"]["verdict"]
>["dismissed"][number];

// Errors and warnings the agent did not dismiss; info never needs action.
const openDiagnostics = (result: ScanResult, dismissed: Dismissal[]) =>
  result.diagnostics.filter(
    (d) =>
      d.severity !== "info" &&
      !dismissed.some(
        (m) => m.tool === result.tool && m.rule === d.rule && m.path === d.path,
      ),
  ).length;

function scannerChecks(view: ReviewView): CheckRow[] {
  const scan = view.review.scan;
  const row = (name: string, state: CiState, status: string): CheckRow => ({
    key: `scan-${name}`,
    name,
    origin: "Scanner",
    state,
    status,
  });
  if (!scan) return [];
  if (scan.status === "pending")
    return [row("zizmor, ty, oxlint", "running", "Running")];
  if (scan.status === "skipped")
    return [row("Scanners", "skipped", "Nothing to scan")];
  if (scan.status === "failed")
    return [row("Scanners", "failed", "Did not run")];
  const dismissed = view.review.verdict?.dismissed ?? [];
  return scan.results.map((r) => {
    if (r.status === "error") return row(r.tool, "failed", "Failed");
    const open = openDiagnostics(r, dismissed);
    return open > 0
      ? row(r.tool, "failed", plural(open, "open diagnostic"))
      : row(r.tool, "passed", "Passed");
  });
}

function reviewCheck(view: ReviewView): CheckRow {
  const blocking = view.review.findings.filter(blocks).length;
  const [state, status]: [CiState, string] =
    view.status === "not_started"
      ? ["queued", "Queued"]
      : LIVE.has(view.status)
        ? ["running", "Reviewing"]
        : view.status === "failed"
          ? ["failed", "Stopped"]
          : blocking > 0
            ? ["failed", plural(blocking, "blocking finding")]
            : ["passed", "No blockers"];
  return {
    key: "review",
    name: "AI review",
    origin: "Bumble Bot",
    state,
    status,
  };
}

const capitalize = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

function ciRow(item: CiItem): CheckRow {
  const [state, status]: [CiState, string] =
    item.state === "success"
      ? ["passed", "Passed"]
      : item.state === "failed"
        ? ["failed", capitalize(item.detail)]
        : item.state === "pending"
          ? item.detail === "queued"
            ? ["queued", "Queued"]
            : ["running", "Running"]
          : ["skipped", capitalize(item.detail)];
  return {
    key: `ci-${item.source ?? ""}-${item.id}`,
    name: item.name,
    origin: item.source ?? "CI",
    state,
    status,
    ...(item.url && { href: item.url, external: true }),
  };
}

function ciChecks(live: PrLive | null): CheckRow[] {
  if (!live) return [];
  const rows = (source: CiSource, name: string) => [
    ...source.items.map(ciRow),
    ...(source.kind === "unavailable"
      ? [
          {
            key: `ci-unavailable-${name}`,
            name,
            origin: "GitHub",
            state: "skipped" as const,
            status: "Unavailable",
          },
        ]
      : []),
  ];
  return [
    ...rows(live.checks, "Check runs"),
    ...rows(live.statuses, "Commit statuses"),
  ];
}

const liveChecks = (view: ReviewView) => [
  ...scannerChecks(view),
  reviewCheck(view),
];

function CiIcon({ state }: { state: CiState }) {
  return (
    <svg
      class={`ci-icon ci-${state}`}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5" />
      {state === "failed" ? (
        <path
          d="m7.5 7.5 5 5m0-5-5 5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      ) : state === "skipped" ? (
        <path
          d="M6.5 10h7"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      ) : state === "passed" ? (
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

function CiChecks({
  checks,
  label,
  open = true,
  showFailuresWhenCollapsed = false,
}: {
  checks: CheckRow[];
  label?: string;
  open?: boolean;
  showFailuresWhenCollapsed?: boolean;
}) {
  if (checks.length === 0) return null;
  const failures = checks.filter((check) => check.state === "failed");
  return (
    <section class="ci-block">
      {showFailuresWhenCollapsed && <CiResults checks={failures} />}
      <details open={open}>
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
          {label && <span class="ci-demo-label">{label}</span>}
        </summary>
        <CiResults checks={checks} />
      </details>
    </section>
  );
}

function CiResults({ checks }: { checks: CheckRow[] }) {
  if (checks.length === 0) return null;
  return (
    <div class="ci-results">
      {checks.map((check) => {
        const body = (
          <>
            <CiIcon state={check.state} />
            <span class="ci-result-name">
              {check.name}
              <span class="ci-origin">{check.origin}</span>
            </span>
            <span class="ci-result-status">{check.status}</span>
          </>
        );
        return check.href ? (
          <a
            class="ci-result"
            key={check.key}
            href={check.href}
            target={check.external ? "_blank" : undefined}
            rel={check.external ? "noreferrer" : undefined}
          >
            {body}
          </a>
        ) : (
          <div class="ci-result" key={check.key}>
            {body}
          </div>
        );
      })}
    </div>
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
