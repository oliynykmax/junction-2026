// The review page: status and the AI's advice, the scanner band, the PR's
// changes told as Situation/Task/Action/Result with their findings and diffs,
// what the AI did not check, docs it consulted and the agent's activity. It
// polls the review's JSON view while the review runs.

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Activity, ReviewView } from "../src/review";
import type { Diagnostic, ScanResult, ScanState } from "../src/scanners";
import { Changes, findingsByChange } from "./changes";
import { FileDiffs } from "./diff";
import { EvidencePanel } from "./evidence";
import { Findings } from "./findings";
import { BLOCKING_RULE, type Focus, plural } from "./shared";
import { blocks } from "../src/findings";
import { RiskBand } from "./risk";

export type PageConfig = {
  api: string;
  pollMs: number;
  prUrl: string;
  owner: string;
  repo: string;
  number: string;
};

type Dismissal = NonNullable<
  ReviewView["review"]["verdict"]
>["dismissed"][number];

const LIVE = new Set<ReviewView["status"]>([
  "running",
  "scanning",
  "not_started",
]);

const STATUS_LABEL: Record<ReviewView["status"], string> = {
  not_started: "Not started",
  scanning: "Scanning",
  running: "Reviewing",
  done: "Review finished",
  failed: "Review failed",
};

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

export function App({ api, pollMs, prUrl, owner, repo, number }: PageConfig) {
  const { view, error } = useReview(api, pollMs);
  const repoUrl = prUrl.replace(/\/pull\/\d+$/, "");
  const sha = view?.review.target?.headSha ?? null;
  // A removed file does not exist at the head, so it links to the PR's diff.
  const removed = new Set(
    (view?.review.files ?? [])
      .filter((f) => f.status === "removed")
      .map((f) => f.path),
  );
  const lineUrl = (path: string, line: number | null) =>
    !sha
      ? prUrl
      : removed.has(path)
        ? `${prUrl}/files`
        : `${repoUrl}/blob/${sha}/${path}${line ? `#L${line}` : ""}`;
  const [tab, setTab] = useState<"changes" | "diff">("changes");
  const [focus, setFocus] = useState<Focus>(null);
  const r = view?.review;
  // Reviews stored before changes existed have no files and keep the old layout.
  const storied = r?.files !== undefined;
  const files = r?.files ?? [];
  const changes = r?.changes ?? [];
  const split = useMemo(
    () => findingsByChange(changes, r?.findings ?? []),
    [changes, r?.findings],
  );
  const live = view ? LIVE.has(view.status) : true;

  return (
    <>
      <header class="bar">
        <div class="grid bar-inner">
          <a class="brand" href="/" aria-label="Bumble Bot home">
            {/* Same versioned URL as the landing page, so a cached old logo is never shown. */}
            <img
              src="/favicon.svg?v=bumble-bot"
              alt=""
              width="32"
              height="32"
            />
            Bumble Bot
          </a>
          {storied && files.length > 0 && (
            <nav class="tabs" aria-label="Review views">
              <button
                type="button"
                aria-current={tab === "changes" ? "page" : undefined}
                onClick={() => setTab("changes")}
              >
                Changes
              </button>
              <button
                type="button"
                aria-current={tab === "diff" ? "page" : undefined}
                onClick={() => setTab("diff")}
              >
                Full diff
              </button>
            </nav>
          )}
          {view && <Status status={view.status} />}
        </div>
      </header>
      <main class="page">
        <section class="grid title">
          <div class="lede">
            <h1>
              <a href={prUrl}>
                {repo} <span class="num">#{number}</span>
              </a>
            </h1>
            {view ? (
              <Advice view={view} />
            ) : (
              <p class="muted">{error ? null : "Loading the review…"}</p>
            )}
          </div>
          <Facts view={view} owner={owner} error={error} />
        </section>
        {view && <EvidencePanel html={view.evidenceHtml} />}
        {view && tab === "diff" && (
          <section class="section" aria-labelledby="diff-h">
            <div class="section-head">
              <h2 id="diff-h">Full diff</h2>
              <p class="counts">
                <span>{plural(files.length, "file")}</span>
              </p>
            </div>
            <FileDiffs
              files={files}
              findings={view.review.findings}
              focus={focus}
              onFocus={setFocus}
              lineUrl={lineUrl}
            />
          </section>
        )}
        {view && tab === "changes" && (
          <>
            <RiskBand risk={view.review.risk} lineUrl={lineUrl} />
            <Scanners
              scan={view.review.scan}
              dismissed={view.review.verdict?.dismissed ?? []}
              lineUrl={lineUrl}
            />
            {storied && (
              <Changes
                changes={changes}
                files={files}
                owned={split.owned}
                running={live}
                lineUrl={lineUrl}
              />
            )}
            <Findings
              findings={
                storied && changes.length ? split.other : view.review.findings
              }
              heading={
                storied && changes.length
                  ? "Findings outside the changes"
                  : "Findings"
              }
              empty={
                storied && changes.length
                  ? null
                  : view.status === "done"
                    ? "The AI reported no findings."
                    : view.status === "failed"
                      ? "No findings were recorded before the review stopped."
                      : "None yet. Findings appear here as the agent confirms them."
              }
              lineUrl={lineUrl}
            />
            <NotChecked view={view} />
            <Docs view={view} />
            <ActivityFeed
              activity={view.activity}
              live={LIVE.has(view.status)}
            />
          </>
        )}
      </main>
    </>
  );
}

function Status({ status }: { status: ReviewView["status"] }) {
  return (
    <span class={`status status-${status}`} role="status">
      {LIVE.has(status) && <span class="pulse" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
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

  let headline: ComponentChildren;
  if (findings.length === 0)
    headline = finished
      ? "No findings"
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
    <div class="advice">
      <p class="decision" title={BLOCKING_RULE}>
        {headline}
      </p>
      {view.heldBack > 0 && (
        <p class="note">
          {plural(view.heldBack, "critical or high finding")} the AI could not
          confirm {view.heldBack === 1 ? "is" : "are"} rated possible and{" "}
          {view.heldBack === 1 ? "doesn't" : "don't"} block. Check{" "}
          {view.heldBack === 1 ? "it" : "them"} yourself.
        </p>
      )}
      {finished ? (
        <>
          <h2 class="summary-h">What the AI read and concluded</h2>
          <p class="summary">{v.summary}</p>
        </>
      ) : (
        <p class="muted advice-wait">
          {view.status === "failed"
            ? "The review stopped before the AI wrote its summary."
            : "The AI's summary appears here when the review finishes."}
        </p>
      )}
      <p class="muted">
        The AI advises. A named human decides whether to merge.
      </p>
    </div>
  );
}

function Facts({
  view,
  owner,
  error,
}: {
  view: ReviewView | null;
  owner: string;
  error: string | null;
}) {
  const r = view?.review;
  return (
    <dl class="facts">
      <div>
        <dt>Repository owner</dt>
        <dd>{owner}</dd>
      </div>
      {r?.target && (
        <div>
          <dt>Commit</dt>
          <dd>
            <code>{r.target.headSha.slice(0, 7)}</code>
          </dd>
        </div>
      )}
      {r?.model && (
        <div>
          <dt>Model</dt>
          <dd>
            <code>{r.model}</code>
          </dd>
        </div>
      )}
      {r?.prompt && (
        <div>
          <dt>Rubric</dt>
          <dd>
            <a href={r.prompt.url}>prompt</a>{" "}
            <code>sha256:{r.prompt.sha256.slice(0, 12)}</code>
          </dd>
        </div>
      )}
      {view && view.costUsd > 0 && (
        <div>
          <dt>Cost</dt>
          <dd>
            <code>${view.costUsd.toFixed(4)}</code>
          </dd>
        </div>
      )}
      {(error || view?.failure) && (
        <div class="alert">
          <dt>{error ? "Could not load" : "Failure"}</dt>
          <dd>
            {error ? `${error}. Retrying every 5 seconds.` : view?.failure}
          </dd>
        </div>
      )}
    </dl>
  );
}

// Scanners

type Flagged = { diag: Diagnostic; dismissal: Dismissal | undefined };

function flag(result: ScanResult, dismissed: Dismissal[]): Flagged[] {
  return result.diagnostics.map((diag) => ({
    diag,
    dismissal: dismissed.find(
      (m) =>
        m.tool === result.tool && m.rule === diag.rule && m.path === diag.path,
    ),
  }));
}

// A scanner needs attention when it failed to run, or reported an error or
// warning the agent did not dismiss.
const needsAttention = (result: ScanResult, flagged: Flagged[]) =>
  result.status === "error" ||
  flagged.some((f) => !f.dismissal && f.diag.severity !== "info");

function Scanners({
  scan,
  dismissed,
  lineUrl,
}: {
  scan: ScanState | null;
  dismissed: Dismissal[];
  lineUrl: (path: string, line: number | null) => string;
}) {
  const [open, setOpen] = useState(false);
  let summary: string;
  let body: ComponentChildren = null;

  if (!scan) summary = "No scan for this review";
  else if (scan.status === "pending")
    summary = "Running zizmor, ty and oxlint on the changed files…";
  else if (scan.status === "skipped")
    summary = "No scanner applies to the changed files";
  else if (scan.status === "failed") {
    summary = "Did not run";
    body = (
      <div class="flag">
        <p class="flag-title">The scanners did not run</p>
        <p>{scan.error}</p>
      </div>
    );
  } else {
    const rows = scan.results.map((r) => ({ r, flagged: flag(r, dismissed) }));
    const bad = rows.filter(({ r, flagged }) => needsAttention(r, flagged));
    const clean = rows.filter((x) => !bad.includes(x));
    const total = rows.reduce((n, x) => n + x.flagged.length, 0);
    summary = bad.length
      ? `${bad.length} of ${rows.length} need attention`
      : `${plural(rows.length, "scanner")}, nothing to act on`;
    body = (
      <>
        <div class="flags">
          {bad.map(({ r, flagged }) => (
            <div class="flag" key={r.tool}>
              <p class="flag-title">
                {r.status === "error"
                  ? `${r.tool} failed`
                  : `${r.tool}: ${plural(
                      flagged.filter(
                        (f) => !f.dismissal && f.diag.severity !== "info",
                      ).length,
                      "open diagnostic",
                    )}`}
              </p>
              {r.status === "error" ? <p>{r.error}</p> : <ToolMeta r={r} />}
            </div>
          ))}
        </div>
        {clean.length > 0 && (
          <ul class="clean">
            {clean.map(({ r, flagged }) => (
              <li key={r.tool}>
                <strong>{r.tool}</strong>{" "}
                {flagged.length
                  ? `${plural(flagged.length, "diagnostic")}, all dismissed or informational`
                  : "clean"}
                <ToolMeta r={r} />
              </li>
            ))}
          </ul>
        )}
        {total > 0 && (
          <>
            <button
              type="button"
              class="toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Hide" : "Show"} {plural(total, "diagnostic")}
            </button>
            {open && (
              <table class="diags">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Rule</th>
                    <th scope="col">Location</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.flatMap(({ flagged }) =>
                    flagged.map(({ diag: d, dismissal }) => (
                      <tr
                        key={`${d.tool}${d.rule}${d.path}${d.line}`}
                        class={
                          !dismissal && d.severity !== "info"
                            ? "open"
                            : "settled"
                        }
                      >
                        <td class="sev">{d.severity}</td>
                        <td>
                          <span class="tool">{d.tool}</span>{" "}
                          {d.url ? (
                            <a href={d.url}>
                              <code>{d.rule}</code>
                            </a>
                          ) : (
                            <code>{d.rule}</code>
                          )}
                        </td>
                        <td>
                          <a class="loc" href={lineUrl(d.path, d.line)}>
                            {d.path}
                            {d.line ? `:${d.line}` : ""}
                          </a>
                        </td>
                        <td>
                          {d.message}
                          {dismissal && (
                            <span class="dismissed">
                              Dismissed by the agent: {dismissal.reason}
                            </span>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <section class="grid band" aria-labelledby="scanners-h">
      <div class="band-label">
        <h2 id="scanners-h">Scanners</h2>
        <p>{summary}</p>
      </div>
      <div class="band-body">{body}</div>
    </section>
  );
}

function ToolMeta({ r }: { r: ScanResult }) {
  return (
    <span class="meta">
      {r.version} · {plural(r.paths.length, "file")} · {r.durationMs} ms
    </span>
  );
}

// What the AI did not check

function NotChecked({ view }: { view: ReviewView }) {
  const v = view.review.verdict;
  return (
    <section class="section" aria-labelledby="nc-h">
      <div class="section-head">
        <h2 id="nc-h">Not checked by the AI</h2>
      </div>
      {!v ? (
        <p class="empty">Listed when the review finishes.</p>
      ) : v.notChecked.length === 0 ? (
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

function Docs({ view }: { view: ReviewView }) {
  const ls = view.review.lookups ?? [];
  return (
    <section class="section" aria-labelledby="docs-h">
      <div class="section-head">
        <h2 id="docs-h">Docs consulted</h2>
        {ls.length > 0 && <p class="counts">{plural(ls.length, "lookup")}</p>}
      </div>
      {ls.length === 0 ? (
        <p class="empty">
          {view.review.verdict
            ? "None. The agent's library and platform claims come from memory."
            : "No documentation looked up yet."}
        </p>
      ) : (
        <ul class="lookups">
          {ls.map((l) => (
            <li key={`${l.at}${l.args}`}>
              <code class="tool">
                {l.tool.replace(/^mcp__/, "").replace("__", " ")}
              </code>
              <code>{l.args}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityFeed({
  activity,
  live,
}: {
  activity: Activity[];
  live: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? live;
  return (
    <section class="section" aria-labelledby="act-h">
      <div class="section-head">
        <h2 id="act-h">Agent activity</h2>
        {activity.length > 0 && (
          <button
            type="button"
            class="toggle"
            aria-expanded={shown}
            onClick={() => setOpen(!shown)}
          >
            {shown ? "Hide" : "Show"} {plural(activity.length, "step")}
          </button>
        )}
      </div>
      {activity.length === 0 ? (
        <p class="empty">No activity yet.</p>
      ) : (
        shown && (
          <ol class="feed">
            {activity.map((a, i) => (
              <li
                key={i}
                class={a.kind === "result" && a.isError ? "err" : undefined}
              >
                <span class="kind">
                  {a.kind === "say"
                    ? "agent"
                    : a.kind === "call"
                      ? "call"
                      : a.isError
                        ? "error"
                        : "result"}
                </span>
                <div>
                  {a.kind === "say" && <p>{a.text}</p>}
                  {a.kind === "call" && (
                    <p>
                      <code>{a.name}</code>{" "}
                      <code class="args">{JSON.stringify(a.args)}</code>
                    </p>
                  )}
                  {a.kind === "result" && (
                    <>
                      <code>{a.name}</code>
                      <pre>{a.text}</pre>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  );
}
