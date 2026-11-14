// The operations dashboard client. Polls /api/dashboard every 15 s while the
// tab is visible and renders the ledger: runs, model usage and prompt cache,
// Modal and MCP calls, recoveries and the event log.

import "@fontsource/hanken-grotesk/latin-400.css";
import "@fontsource/hanken-grotesk/latin-600.css";
import "@fontsource/hanken-grotesk/latin-700.css";
import "@fontsource/hanken-grotesk/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import "./dashboard.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  DashboardView,
  LogRow,
  RunRow,
  ShownStatus,
} from "../src/dashboard";
import type { FailureClass } from "../src/status";
import { plural } from "./shared";

const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

const WINDOWS = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};
type WindowKey = keyof typeof WINDOWS;

const STATUSES: ShownStatus[] = ["running", "done", "failed", "stale"];
const STATUS_LABEL: Record<ShownStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stale: "Stale",
};
const STATUS_MEANING: Record<ShownStatus, string> = {
  running:
    "Work is active and the object wrote to the ledger in the last 15 minutes.",
  done: "The agent committed a verdict.",
  failed: "The run ended without a verdict.",
  stale:
    "Last seen running more than 15 minutes ago. The outcome is unknown, not failed.",
};
const FAILURE_LABEL: Record<FailureClass, string> = {
  model_error: "model error",
  no_finish: "no finish_review",
  scanner: "scanner",
  github: "GitHub",
  aborted: "aborted",
  other: "other",
};
const DECISION_LABEL: Record<string, string> = {
  no_blockers_found: "no blockers",
  changes_requested: "changes requested",
};

type Filters = { window: WindowKey; status: ShownStatus | null; repo: string };

function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const w = p.get("window");
  const s = p.get("status");
  return {
    window: w && w in WINDOWS ? (w as WindowKey) : "24h",
    status: STATUSES.includes(s as ShownStatus) ? (s as ShownStatus) : null,
    repo: p.get("repo") ?? "",
  };
}

function writeFilters(f: Filters) {
  const p = new URLSearchParams();
  if (f.window !== "24h") p.set("window", f.window);
  if (f.status) p.set("status", f.status);
  if (f.repo) p.set("repo", f.repo);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function apiUrl(f: Filters, cursor: string | null) {
  const to = Date.now();
  const p = new URLSearchParams({
    from: String(to - WINDOWS[f.window]),
    to: String(to),
  });
  if (f.status) p.set("status", f.status);
  if (f.repo) p.set("repo", f.repo);
  if (cursor) p.set("cursor", cursor);
  return `/api/dashboard?${p}`;
}

async function fetchView(url: string): Promise<DashboardView> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as
    DashboardView | { error?: string };
  if (!res.ok || !("runs" in body))
    throw new ApiError(
      ("error" in body && body.error) || `HTTP ${res.status}`,
      res.status,
    );
  return body;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const num = new Intl.NumberFormat("en");
const fmtInt = (n: number) => num.format(n);
const fmtTokens = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e4
      ? `${(n / 1e3).toFixed(1)}k`
      : fmtInt(n);
const fmtUsd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const fmtMs = (ms: number | null) =>
  ms === null
    ? "–"
    : ms < 1000
      ? `${ms} ms`
      : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const fmtPct = (r: number | null) =>
  r === null ? "no data" : `${(r * 100).toFixed(1)}%`;
const fmtAbs = (t: number) =>
  new Date(t).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

function fmtAgo(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

type Load =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "ready"; view: DashboardView; at: number; error: string | null };

function Dashboard() {
  const [filters, setFilters] = useState(readFilters);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [older, setOlder] = useState<{
    rows: RunRow[];
    next: string | null;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [repoDraft, setRepoDraft] = useState(filters.repo);
  const now = useNow(1000);

  useEffect(() => {
    writeFilters(filters);
    setOlder(null);
    setLoad((l) => (l.kind === "ready" ? l : { kind: "loading" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = POLL_MS;
    const tick = async () => {
      timer = undefined;
      if (document.hidden) return;
      try {
        const view = await fetchView(apiUrl(filters, null));
        if (stopped) return;
        delay = POLL_MS;
        setLoad({ kind: "ready", view, at: Date.now(), error: null });
      } catch (error) {
        if (stopped) return;
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 429 || status === 503)
          delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        const message = error instanceof Error ? error.message : String(error);
        setLoad((l) =>
          l.kind === "ready"
            ? { ...l, error: message }
            : { kind: "failed", error: message },
        );
      }
      if (!stopped) timer = setTimeout(tick, delay);
    };
    const onVisible = () => {
      if (!document.hidden && timer === undefined) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [filters]);

  const set = (patch: Partial<Filters>) =>
    setFilters((f) => ({ ...f, ...patch }));
  const view = load.kind === "ready" ? load.view : null;
  const error = load.kind === "loading" ? null : load.error;

  const loadOlder = async (cursor: string) => {
    setLoadingOlder(true);
    try {
      const v = await fetchView(apiUrl(filters, cursor));
      setOlder((o) => ({
        rows: [...(o?.rows ?? []), ...v.runs.rows],
        next: v.runs.next,
      }));
    } catch {
      // The button stays; the next click retries.
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <>
      <header class="bar">
        <div class="grid bar-inner">
          <a class="brand" href="/" aria-label="Bumble Bot home">
            <img
              src="/favicon.svg?v=bumble-bot"
              alt=""
              width="32"
              height="32"
            />
            Bumble Bot
          </a>
          <Freshness load={load} now={now} />
        </div>
      </header>
      <main class="page dash">
        <section class="grid title">
          <div class="lede">
            <h1>Operations</h1>
            <p class="advice">
              Every review the bot ran, what it cost, and the calls it made.
              Collected from the review objects at a few boundaries.{" "}
              {view?.collectionStartedAt ? (
                <>
                  Runs before{" "}
                  <strong>{fmtAbs(view.collectionStartedAt)}</strong> were not
                  collected.
                </>
              ) : view ? (
                <>
                  The collection start is unknown, so earlier runs may be
                  missing.
                </>
              ) : null}
            </p>
          </div>
        </section>

        <Controls
          filters={filters}
          set={set}
          repoDraft={repoDraft}
          setRepoDraft={setRepoDraft}
          counts={view?.runs.counts ?? null}
        />

        {load.kind === "loading" && (
          <p class="dash-state">Loading the ledger…</p>
        )}
        {!view && error && (
          <p class="dash-state alert" role="alert">
            The dashboard could not load: {error}. It retries on its own.
          </p>
        )}

        {view && (
          <>
            <Strip view={view} />
            <Runs
              view={view}
              older={older}
              now={now}
              filtered={Boolean(filters.status || filters.repo)}
              loadingOlder={loadingOlder}
              onOlder={loadOlder}
            />
            <div class="dash-cols">
              <Models view={view} />
              <Calls view={view} />
            </div>
            <Recoveries view={view} />
            <Log rows={view.log} now={now} />
            <p class="dash-foot muted">
              Model cost is pi's estimate from list prices and token usage, not
              an invoice. Cloudflare, Modal and MCP billing are unavailable
              here. Call counts are best effort: events buffered in an object
              that is evicted are lost.
              {view.droppedEvents > 0 &&
                ` ${fmtInt(view.droppedEvents)} events were dropped from full buffers in this window.`}
            </p>
          </>
        )}
      </main>
    </>
  );
}

function Freshness({ load, now }: { load: Load; now: number }) {
  if (load.kind === "loading")
    return (
      <span class="status" role="status">
        <span class="pulse" aria-hidden="true" />
        Loading
      </span>
    );
  if (load.kind === "failed")
    return (
      <span class="status status-failed" role="status" title={load.error}>
        Unavailable
      </span>
    );
  if (load.error)
    return (
      <span class="status status-failed" role="status" title={load.error}>
        Stale, updated {fmtAgo(load.at, now)}
      </span>
    );
  return (
    <span
      class="status"
      role="status"
      title={`Polls every ${POLL_MS / 1000} s while visible`}
    >
      <span class="pulse" aria-hidden="true" />
      Updated {fmtAgo(load.at, now)}
    </span>
  );
}

function Controls({
  filters,
  set,
  repoDraft,
  setRepoDraft,
  counts,
}: {
  filters: Filters;
  set: (p: Partial<Filters>) => void;
  repoDraft: string;
  setRepoDraft: (s: string) => void;
  counts: Record<ShownStatus, number> | null;
}) {
  const repoValid = repoDraft === "" || /^[\w.-]+\/[\w.-]+$/.test(repoDraft);
  return (
    <section class="dash-controls" aria-label="Filters">
      <div class="filter" role="group" aria-label="Time window">
        {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
          <button
            type="button"
            aria-pressed={filters.window === w}
            onClick={() => set({ window: w })}
          >
            {w}
          </button>
        ))}
      </div>
      <div class="filter" role="group" aria-label="Status">
        <button
          type="button"
          aria-pressed={filters.status === null}
          onClick={() => set({ status: null })}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            type="button"
            aria-pressed={filters.status === s}
            title={STATUS_MEANING[s]}
            onClick={() => set({ status: filters.status === s ? null : s })}
          >
            {STATUS_LABEL[s]}
            {counts && <span>{counts[s]}</span>}
          </button>
        ))}
      </div>
      <form
        class="dash-repo"
        onSubmit={(e) => {
          e.preventDefault();
          if (repoValid) set({ repo: repoDraft.trim() });
        }}
      >
        <label for="repo">Repository</label>
        <input
          id="repo"
          type="search"
          placeholder="owner/name"
          value={repoDraft}
          aria-invalid={!repoValid}
          onInput={(e) => setRepoDraft(e.currentTarget.value.trim())}
          onSearch={(e) => {
            if (!e.currentTarget.value) set({ repo: "" });
          }}
        />
        <button type="submit" disabled={!repoValid}>
          Filter
        </button>
      </form>
    </section>
  );
}

function Strip({ view }: { view: DashboardView }) {
  const c = view.runs.counts;
  const cost = view.models.reduce((s, m) => s + m.costUsd, 0);
  const prompt = view.models.reduce(
    (s, m) => s + m.input + m.cacheRead + m.cacheWrite,
    0,
  );
  const read = view.models.reduce((s, m) => s + m.cacheRead, 0);
  const cells: [string, string, string?, boolean?][] = [
    ["Running", fmtInt(c.running), STATUS_MEANING.running],
    ["Done", fmtInt(c.done), STATUS_MEANING.done],
    ["Failed", fmtInt(c.failed), STATUS_MEANING.failed, c.failed > 0],
    ["Stale", fmtInt(c.stale), STATUS_MEANING.stale],
    ["Model cost, estimate", fmtUsd(cost), "pi usage at list prices"],
    [
      "Prompt cache reads",
      prompt ? fmtPct(read / prompt) : "no data",
      "cache read ÷ all prompt tokens",
    ],
  ];
  return (
    <dl class="dash-strip">
      {cells.map(([label, value, title, alert]) => (
        <div class={alert ? "alert" : undefined} title={title}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Runs({
  view,
  older,
  now,
  filtered,
  loadingOlder,
  onOlder,
}: {
  view: DashboardView;
  older: { rows: RunRow[]; next: string | null } | null;
  now: number;
  filtered: boolean;
  loadingOlder: boolean;
  onOlder: (cursor: string) => void;
}) {
  const rows = [...view.runs.rows, ...(older?.rows ?? [])];
  const next = older ? older.next : view.runs.next;
  return (
    <section class="section" aria-labelledby="runs-h">
      <div class="section-head">
        <h2 id="runs-h">Reviews</h2>
        <span class="counts">{rows.length} shown, newest first</span>
      </div>
      {rows.length === 0 ? (
        <p class="empty">
          {filtered
            ? "No reviews match these filters in this window."
            : view.collectionStartedAt
              ? `No reviews since ${fmtAbs(Math.max(view.window.from, view.collectionStartedAt))}.`
              : "No reviews in this window."}
        </p>
      ) : (
        <div class="dash-scroll">
          <table class="diags dash-table dash-runs">
            <thead>
              <tr>
                <th>Started</th>
                <th>Pull request</th>
                <th>Commit</th>
                <th>Status</th>
                <th>Outcome</th>
                <th class="num">Duration</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RunTr r={r} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button
          type="button"
          class="toggle dash-more"
          disabled={loadingOlder}
          onClick={() => onOlder(next)}
        >
          {loadingOlder ? "Loading…" : "Load older reviews"}
        </button>
      )}
    </section>
  );
}

function RunTr({ r, now }: { r: RunRow; now: number }) {
  const end = r.endedAt ?? (r.status === "running" ? now : r.lastSeenAt);
  const outcome =
    r.status === "done"
      ? `${DECISION_LABEL[r.decision ?? ""] ?? r.decision ?? "–"} · ${r.findings ?? 0} findings`
      : r.status === "failed"
        ? (FAILURE_LABEL[r.failure ?? "other"] ?? "unknown")
        : r.status === "stale"
          ? `last seen ${fmtAgo(r.lastSeenAt, now)}`
          : "in progress";
  return (
    <tr class={`run-${r.status}`}>
      <td title={fmtAbs(r.startedAt)}>{fmtAgo(r.startedAt, now)}</td>
      <td>
        <a href={r.link}>
          {r.owner}/{r.repo}#{r.number}
        </a>
        {r.mode === "manual" && <span class="tag dash-mode">manual</span>}
      </td>
      <td class="loc" title={r.headSha}>
        {r.headSha.slice(0, 7)}
      </td>
      <td class="dash-status" title={STATUS_MEANING[r.status]}>
        {r.status === "running" && <span class="pulse" aria-hidden="true" />}
        {STATUS_LABEL[r.status]}
      </td>
      <td class={r.decision === "changes_requested" ? "alert" : undefined}>
        {outcome}
      </td>
      <td class="num" title={r.endedAt ? undefined : "still open"}>
        {fmtDuration(end - r.startedAt)}
      </td>
      <td class="num">{r.costUsd > 0 ? fmtUsd(r.costUsd) : "–"}</td>
    </tr>
  );
}

function Models({ view }: { view: DashboardView }) {
  return (
    <section class="section" aria-labelledby="models-h">
      <div class="section-head">
        <h2 id="models-h">Models and prompt cache</h2>
      </div>
      {view.models.length === 0 ? (
        <p class="empty">No model usage recorded in this window.</p>
      ) : (
        <div class="dash-scroll">
          <table class="diags dash-table">
            <thead>
              <tr>
                <th>Model</th>
                <th class="num">Runs</th>
                <th class="num">Input</th>
                <th class="num">Cache read</th>
                <th class="num">Cache write</th>
                <th class="num">Output</th>
                <th
                  class="num"
                  title="cache read ÷ (input + cache read + cache write)"
                >
                  Cache share
                </th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {view.models.map((m) => (
                <tr>
                  <td class="loc">{m.model}</td>
                  <td class="num">{fmtInt(m.runs)}</td>
                  <td class="num">{fmtTokens(m.input)}</td>
                  <td class="num">{fmtTokens(m.cacheRead)}</td>
                  <td class="num">{fmtTokens(m.cacheWrite)}</td>
                  <td class="num">{fmtTokens(m.output)}</td>
                  <td class="num">{fmtPct(m.promptCacheHitRatio)}</td>
                  <td class="num">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="dash-note muted">
        Cache share is cache-read tokens over all prompt tokens. Cost is an
        estimate.
      </p>
    </section>
  );
}

function Calls({ view }: { view: DashboardView }) {
  const { modal, connections: c } = view;
  return (
    <section class="section" aria-labelledby="calls-h">
      <div class="section-head">
        <h2 id="calls-h">Modal and MCP calls</h2>
      </div>
      <dl class="facts dash-facts">
        <div class={modal.failed ? "alert" : undefined}>
          <dt>Modal scans</dt>
          <dd>
            {modal.calls === 0
              ? "none in this window"
              : `${fmtInt(modal.calls)} calls, ${fmtInt(modal.failed)} failed · p50 ${fmtMs(modal.p50Ms)} · p95 ${fmtMs(modal.p95Ms)}`}
          </dd>
        </div>
        <div>
          <dt>Modal cost</dt>
          <dd class="muted">unavailable</dd>
        </div>
        <div class={c.mcpConnectFailures ? "alert" : undefined}>
          <dt>MCP connects</dt>
          <dd>
            {fmtInt(c.mcpConnects)}
            {c.mcpConnectFailures > 0 &&
              `, ${fmtInt(c.mcpConnectFailures)} failed`}{" "}
            for {fmtInt(c.mcpCalls)} calls
          </dd>
        </div>
        <div>
          <dt>GitHub token cache</dt>
          <dd>
            {plural(c.tokenCacheHits, "hit")},{" "}
            {plural(c.tokenCacheMisses, "miss", "misses")}
          </dd>
        </div>
      </dl>
      {view.mcp.length === 0 ? (
        <p class="empty dash-note">No MCP tool calls in this window.</p>
      ) : (
        <div class="dash-scroll">
          <table class="diags dash-table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Tool</th>
                <th class="num">Calls</th>
                <th class="num">Errors</th>
                <th class="num">p50</th>
              </tr>
            </thead>
            <tbody>
              {view.mcp.map((m) => (
                <tr>
                  <td>{m.server}</td>
                  <td class="loc">{m.tool}</td>
                  <td class="num">{fmtInt(m.calls)}</td>
                  <td class={`num${m.errors ? " alert" : ""}`}>
                    {fmtInt(m.errors)}
                  </td>
                  <td class="num">{fmtMs(m.p50Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Recoveries({ view }: { view: DashboardView }) {
  const r = view.recoveries;
  return (
    <section class="section dash-recovery" aria-labelledby="rec-h">
      <div class="section-head">
        <h2 id="rec-h">Recoveries</h2>
      </div>
      <p>
        {r.detected === 0 ? (
          <span class="muted">
            No boot found interrupted tasks in this window. Plain restarts and
            alarms do not count.
          </span>
        ) : (
          <>
            {fmtInt(r.detected)} interrupted boots:{" "}
            <strong>{fmtInt(r.recovered)} recovered</strong>,{" "}
            <span class={r.failed ? "alert" : undefined}>
              {fmtInt(r.failed)} failed
            </span>
            , {fmtInt(r.unverified)} unverified, {fmtInt(r.superseded)}{" "}
            superseded, {fmtInt(r.open)} open.
          </>
        )}
      </p>
      <p class="dash-note muted">
        Recovered means every interrupted task ended done and the review reached
        a verdict. Unverified means the scan was capped or some task end was not
        observed.
      </p>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  modal: "modal",
  mcp: "mcp",
  mcp_connect: "connect",
  github_token: "token",
  lifecycle: "review",
};

function Log({ rows, now }: { rows: LogRow[]; now: number }) {
  return (
    <section class="section" aria-labelledby="log-h">
      <div class="section-head">
        <h2 id="log-h">Event log</h2>
        <span class="counts">newest {rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p class="empty">No events in this window.</p>
      ) : (
        <ol class="dash-log">
          {rows.map((e) => (
            <li class={e.ok ? undefined : "err"}>
              <time title={fmtAbs(e.at)}>{fmtAgo(e.at, now)}</time>
              <span class="kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span class="loc">{e.name}</span>
              <span class="muted">
                {[
                  e.ok ? null : "failed",
                  e.ms === null ? null : fmtMs(e.ms),
                  ...Object.entries(e.detail ?? {}).map(
                    ([k, v]) => `${k} ${v}`,
                  ),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span class="loc muted dash-run" title={e.runKey ?? undefined}>
                {e.runKey?.replace(/@([0-9a-f]{7})[0-9a-f]+$/, "@$1") ?? ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const root = document.getElementById("app");
if (root) render(<Dashboard />, root);
