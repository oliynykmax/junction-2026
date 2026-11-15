// The operations dashboard client. Polls /api/dashboard every 15 s while the
// tab is visible and charts the ledger: review volume and outcomes, model
// cost, the review pipeline, time to verdict, and tool calls and latency.

import "@fontsource/hanken-grotesk/latin-400.css";
import "@fontsource/hanken-grotesk/latin-600.css";
import "@fontsource/hanken-grotesk/latin-700.css";
import "@fontsource/hanken-grotesk/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import "./dashboard.css";
import { type ComponentChildren, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type Bucket,
  CALL_KINDS,
  type CallKind,
  type DashboardView,
  type FunnelStep,
  type Kpis,
  type RunRow,
} from "../src/dashboard";
import type { FailureClass } from "../src/status";
import {
  HBars,
  Legend,
  SegmentBar,
  type Series,
  Sparkline,
  TimeBars,
  TimeLines,
  useNow,
} from "./charts";
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

// Categorical slots in fixed order; status colours are reserved for outcomes.
const SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
const GOOD = "var(--good)";
const SERIOUS = "var(--serious)";
const CRITICAL = "var(--critical)";
const MUTED = "var(--muted)";

const KIND_SERIES: Series[] = [
  { key: "shell", label: "Shell", color: SLOTS[0] },
  { key: "mcp", label: "MCP", color: SLOTS[1] },
  { key: "modal", label: "Modal scan", color: SLOTS[2] },
];
const KIND_LABEL: Record<CallKind, string> = {
  shell: "shell",
  mcp: "mcp",
  modal: "modal",
};
const OUTCOME_SERIES: Series[] = [
  { key: "done", label: "Verdict", color: GOOD },
  { key: "failed", label: "Failed", color: CRITICAL },
  { key: "open", label: "Running or stale", color: MUTED },
];
const FUNNEL_LABEL: Record<FunnelStep, string> = {
  started: "Started",
  scanned: "Scanned",
  checked_out: "Checked out",
  verdict: "Verdict",
  no_blockers: "No blockers",
};
const FAILURE_LABEL: Record<FailureClass, string> = {
  model_error: "Model error",
  no_finish: "No finish",
  scanner: "Scanner",
  github: "GitHub",
  aborted: "Aborted",
  other: "Other",
};

type Filters = { window: WindowKey; repo: string };

function readFilters(): Filters {
  const p = new URLSearchParams(location.search);
  const w = p.get("window");
  return {
    window: w && w in WINDOWS ? (w as WindowKey) : "24h",
    repo: p.get("repo") ?? "",
  };
}

function writeFilters(f: Filters) {
  const p = new URLSearchParams();
  if (f.window !== "24h") p.set("window", f.window);
  if (f.repo) p.set("repo", f.repo);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function apiUrl(f: Filters) {
  const to = Date.now();
  const p = new URLSearchParams({
    from: String(to - WINDOWS[f.window]),
    to: String(to),
  });
  if (f.repo) p.set("repo", f.repo);
  return `/api/dashboard?${p}`;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchView(url: string): Promise<DashboardView> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res
    .json()
    .catch(() => ({}))) as Partial<DashboardView> & {
    error?: string;
  };
  if (!res.ok || !body.kpis)
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  return body as DashboardView;
}

const num = new Intl.NumberFormat("en");
const fmtInt = (n: number) => num.format(Math.round(n));
const fmtCompact = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
      : fmtInt(n);
const fmtUsd = (n: number) =>
  `$${n === 0 ? "0" : n < 1 ? n.toFixed(2) : n < 100 ? n.toFixed(2) : fmtInt(n)}`;
const fmtMs = (ms: number | null) =>
  ms === null
    ? "–"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
        : `${(ms / 60_000).toFixed(1)} min`;
const fmtPct = (r: number | null) =>
  r === null ? "–" : `${Math.round(r * 100)}%`;
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

/** Tick and tooltip formats that match the bucket size. */
function timeFormats(bucketMs: number) {
  const day = bucketMs >= 86_400_000;
  const tick = (t: number) =>
    new Date(t).toLocaleString(
      "en-GB",
      day
        ? { day: "numeric", month: "short" }
        : bucketMs >= 3 * 3_600_000
          ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
          : { hour: "2-digit", minute: "2-digit" },
    );
  const full = (t: number) =>
    new Date(t).toLocaleString(
      "en-GB",
      day
        ? { weekday: "short", day: "numeric", month: "short" }
        : {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          },
    );
  return { tick, full };
}

type Load =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "ready"; view: DashboardView; at: number; error: string | null };

function Dashboard() {
  const [filters, setFilters] = useState(readFilters);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [repoDraft, setRepoDraft] = useState(filters.repo);
  const now = useNow(1000);

  useEffect(() => {
    writeFilters(filters);
    setLoad((l) => (l.kind === "ready" ? l : { kind: "loading" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = POLL_MS;
    const tick = async () => {
      timer = undefined;
      if (document.hidden) return;
      try {
        const view = await fetchView(apiUrl(filters));
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
  const repoValid = repoDraft === "" || /^[\w.-]+\/[\w.-]+$/.test(repoDraft);

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
        <section class="dash-head">
          <div>
            <h1>Operations</h1>
            <p class="muted">
              Every review the bot ran, what it cost and the calls it made.
              {view?.collectionStartedAt
                ? ` Collected since ${fmtAbs(view.collectionStartedAt)}.`
                : ""}
            </p>
          </div>
          <div class="dash-controls">
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
            <form
              class="dash-repo"
              onSubmit={(e) => {
                e.preventDefault();
                if (repoValid) set({ repo: repoDraft.trim() });
              }}
            >
              <input
                aria-label="Repository"
                type="search"
                placeholder="All repositories (owner/name)"
                value={repoDraft}
                aria-invalid={!repoValid}
                onInput={(e) => setRepoDraft(e.currentTarget.value.trim())}
                onSearch={(e) => {
                  if (!e.currentTarget.value) set({ repo: "" });
                }}
              />
            </form>
          </div>
        </section>

        {load.kind === "loading" && (
          <p class="dash-state">Loading the ledger…</p>
        )}
        {!view && error && (
          <p class="dash-state alert" role="alert">
            The dashboard could not load: {error}. It retries on its own.
          </p>
        )}
        {view && <Board view={view} now={now} />}
      </main>
    </>
  );
}

function Board({ view, now }: { view: DashboardView; now: number }) {
  const fmt = timeFormats(view.window.bucketMs);
  const time = {
    points: view.series,
    t: (b: Bucket) => b.t,
    fmtT: fmt.full,
    fmtTick: fmt.tick,
  };
  const models = view.models.map((m) => m.model).sort();
  const modelSeries: Series[] = models.map((m, i) => ({
    key: m,
    label: shortModel(m),
    color: SLOTS[i % SLOTS.length],
  }));
  const k = view.kpis;
  const p = view.previous;
  const verdictRate = (x: Kpis) =>
    x.done + x.failed > 0 ? x.done / (x.done + x.failed) : null;
  const cost = (x: Kpis) => (x.reviews ? x.costUsd / x.reviews : null);
  const perReview = (x: Kpis) => (x.done ? x.findings / x.done : null);
  const prompt = view.models.reduce(
    (s, m) => s + m.input + m.cacheRead + m.cacheWrite,
    0,
  );
  const cacheRead = view.models.reduce((s, m) => s + m.cacheRead, 0);
  const calls = view.series.reduce(
    (n, b) => n + CALL_KINDS.reduce((m, kind) => m + b.calls[kind].n, 0),
    0,
  );

  return (
    <>
      <section class="dash-kpis" aria-label="Key figures">
        <Kpi
          label="Reviews"
          value={fmtInt(k.reviews)}
          now={k.reviews}
          before={p?.reviews}
          spark={view.series.map((b) => b.done + b.failed + b.open)}
        />
        <Kpi
          label="Verdict rate"
          value={fmtPct(verdictRate(k))}
          sub="of ended reviews"
          now={verdictRate(k)}
          before={p ? verdictRate(p) : undefined}
          spark={view.series.map((b) =>
            b.done + b.failed ? b.done / (b.done + b.failed) : 0,
          )}
          points
        />
        <Kpi
          label="Median time to verdict"
          value={fmtMs(k.medianMs)}
          now={k.medianMs}
          before={p?.medianMs}
          lowerIsBetter
        />
        <Kpi
          label="Model cost"
          value={fmtUsd(k.costUsd)}
          sub={cost(k) === null ? undefined : `${fmtUsd(cost(k)!)} per review`}
          now={k.costUsd}
          before={p?.costUsd}
          spark={view.series.map((b) =>
            Object.values(b.cost).reduce((a, c) => a + c, 0),
          )}
          lowerIsBetter
        />
        <Kpi
          label="Findings per verdict"
          value={perReview(k) === null ? "–" : perReview(k)!.toFixed(1)}
          now={perReview(k)}
          before={p ? perReview(p) : undefined}
          neutral
          spark={view.series.map((b) => b.findings)}
        />
      </section>

      <div class="dash-grid">
        <Card
          wide
          title="Reviews"
          sub={`Started per ${bucketName(view.window.bucketMs)}, by how they ended`}
          legend={OUTCOME_SERIES}
        >
          <TimeBars
            {...time}
            series={OUTCOME_SERIES}
            value={(b, key) => b[key as "done" | "failed" | "open"]}
            fmtV={fmtInt}
            label="Reviews started per time bucket, stacked by outcome"
          />
        </Card>

        <Card
          title="Review pipeline"
          sub="Runs in this window that reached each step"
        >
          <HBars
            color="var(--s1)"
            fmt={fmtInt}
            label="Review pipeline funnel"
            bars={view.funnel.map((f) => ({
              label: FUNNEL_LABEL[f.step],
              value: f.n,
              note: k.reviews ? fmtPct(f.n / k.reviews) : undefined,
            }))}
          />
        </Card>

        <Card
          title="Model cost"
          sub="Estimated from token usage at list prices"
          legend={modelSeries}
        >
          <TimeBars
            {...time}
            series={modelSeries}
            value={(b, key) => b.cost[key] ?? 0}
            fmtV={fmtUsd}
            height={180}
            label="Estimated model cost per time bucket, stacked by model"
          />
        </Card>

        <Card
          title="Time to verdict"
          sub={`Done reviews by duration in minutes · median ${fmtMs(k.medianMs)}`}
        >
          <Histogram bins={view.durations} />
        </Card>

        <Card
          title="Outcomes"
          sub="What the finished reviews decided, and why the rest failed"
        >
          <SegmentBar
            fmt={fmtInt}
            label="Review outcomes"
            segments={[
              {
                label: "No blockers",
                value: view.outcomes.noBlockers,
                color: GOOD,
              },
              {
                label: "Changes requested",
                value: view.outcomes.changesRequested,
                color: SERIOUS,
              },
              ...Object.entries(view.outcomes.failed).map(([f, n]) => ({
                label: `Failed: ${FAILURE_LABEL[f as FailureClass] ?? f}`,
                value: n ?? 0,
                color: CRITICAL,
              })),
              {
                label: "Running or stale",
                value: view.outcomes.open,
                color: MUTED,
              },
            ]}
          />
          <h3 class="dash-sub">Verification receipts</h3>
          {view.verification.runs === 0 ? (
            <p class="muted dash-note">
              No finished review in this window logged its receipts yet.
            </p>
          ) : (
            <SegmentBar
              fmt={fmtInt}
              label="Verification receipts by outcome"
              segments={[
                {
                  label: "Passed",
                  value: view.verification.passed,
                  color: SLOTS[0],
                },
                {
                  label: "Counterexample",
                  value: view.verification.counterexample,
                  color: SLOTS[1],
                },
                {
                  label: "Not run",
                  value: view.verification.not_run,
                  color: MUTED,
                },
              ]}
            />
          )}
        </Card>

        <Card
          title="Tool latency"
          sub="p95 per bucket, from sampled calls"
          legend={KIND_SERIES}
        >
          <TimeLines
            {...time}
            series={KIND_SERIES}
            value={(b, key) => b.p95[key as CallKind]}
            fmtV={(v) => fmtMs(v)}
            height={180}
            label="p95 latency per time bucket for shell, MCP and Modal calls"
          />
        </Card>

        <Card
          title="Tool calls"
          sub={`${fmtCompact(calls)} calls · errors in red · p50 latency`}
        >
          {view.tools.length === 0 ? (
            <p class="muted dash-note">No tool calls in this window.</p>
          ) : (
            <HBars
              color="var(--s1)"
              partColor={CRITICAL}
              fmt={fmtCompact}
              label="Busiest tools by call count"
              bars={view.tools.map((t) => ({
                label: `${KIND_LABEL[t.kind]} · ${t.name}`,
                value: t.calls,
                part: t.errors,
                note: fmtMs(t.p50Ms),
                title: `${t.errors} errors · p50 ${fmtMs(t.p50Ms)} · p95 ${fmtMs(t.p95Ms)}`,
              }))}
            />
          )}
        </Card>

        <Card
          title="Calls over time"
          sub={`Per ${bucketName(view.window.bucketMs)}, by kind`}
          legend={KIND_SERIES}
        >
          <TimeBars
            {...time}
            series={KIND_SERIES}
            value={(b, key) => b.calls[key as CallKind].n}
            fmtV={fmtCompact}
            height={180}
            label="Tool calls per time bucket, stacked by kind"
          />
        </Card>

        <Card title="Prompt tokens" sub="Where each model's prompt came from">
          {view.models.length === 0 ? (
            <p class="muted dash-note">No model usage in this window.</p>
          ) : (
            view.models.map((m) => (
              <div class="dash-model">
                <h3 class="dash-sub">
                  {shortModel(m.model)}
                  <span class="muted">
                    {fmtInt(m.runs)} runs · {fmtUsd(m.costUsd)}
                  </span>
                </h3>
                <SegmentBar
                  fmt={fmtCompact}
                  label={`Prompt token sources for ${m.model}`}
                  segments={[
                    {
                      label: "Cache read",
                      value: m.cacheRead,
                      color: SLOTS[0],
                    },
                    {
                      label: "Cache write",
                      value: m.cacheWrite,
                      color: SLOTS[2],
                    },
                    { label: "Uncached", value: m.input, color: SLOTS[1] },
                  ]}
                />
              </div>
            ))
          )}
        </Card>

        <Card title="Health" sub="Connections, caches and crash recovery">
          <dl class="dash-health">
            <Stat
              label="Prompt cache share"
              value={prompt ? fmtPct(cacheRead / prompt) : "–"}
            />
            <Stat
              label="GitHub token cache hits"
              value={fmtPct(
                rate(
                  view.connections.tokenCacheHits,
                  view.connections.tokenCacheMisses,
                ),
              )}
            />
            <Stat
              label="MCP connect failures"
              value={`${fmtInt(view.connections.mcpConnectFailures)} of ${fmtInt(view.connections.mcpConnects)}`}
              alert={view.connections.mcpConnectFailures > 0}
            />
            <Stat
              label="Interrupted boots recovered"
              value={
                view.recoveries.detected
                  ? `${fmtInt(view.recoveries.recovered)} of ${fmtInt(view.recoveries.detected)}`
                  : "none needed"
              }
              alert={view.recoveries.failed > 0}
            />
          </dl>
        </Card>

        <Card title="Latest reviews" sub="Newest first">
          <Recent rows={view.recent} now={now} />
        </Card>
      </div>

      <p class="dash-foot muted">
        Cost is pi's estimate from list prices and token usage, not an invoice.
        Call counts are best effort: events buffered in an evicted object are
        lost. Shell calls and verification receipts are recorded only by reviews
        that ran after they were added.
        {view.truncated &&
          ` This window holds more reviews than the dashboard reads, so the figures cover only the newest ${fmtInt(view.truncated)} runs across it and the previous window.`}
        {view.droppedEvents > 0 &&
          ` ${fmtInt(view.droppedEvents)} events were dropped from full buffers in this window.`}
      </p>
    </>
  );
}

function rate(hit: number, miss: number) {
  return hit + miss > 0 ? hit / (hit + miss) : null;
}

function shortModel(m: string) {
  return m.replace(/^[^/]+\//, "");
}

function bucketName(ms: number) {
  if (ms >= 86_400_000) return "day";
  if (ms >= 3_600_000)
    return ms === 3_600_000 ? "hour" : `${ms / 3_600_000} hours`;
  return `${ms / 60_000} minutes`;
}

function Card({
  title,
  sub,
  legend,
  wide,
  children,
}: {
  title: string;
  sub?: string;
  legend?: Series[];
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class={`dash-card${wide ? " wide" : ""}`}>
      <header>
        <div>
          <h2>{title}</h2>
          {sub && <p class="muted">{sub}</p>}
        </div>
        {legend && legend.length > 1 && <Legend series={legend} />}
      </header>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  sub,
  now,
  before,
  spark,
  lowerIsBetter,
  neutral,
  points,
}: {
  label: string;
  value: string;
  sub?: string;
  now: number | null;
  before?: number | null;
  spark?: number[];
  lowerIsBetter?: boolean;
  neutral?: boolean;
  /** The figure is a ratio, so compare in points, not percent. */
  points?: boolean;
}) {
  let delta: { text: string; tone: string } | null = null;
  if (now !== null && before !== undefined && before !== null) {
    const diff = points
      ? (now - before) * 100
      : before
        ? ((now - before) / before) * 100
        : null;
    if (diff !== null && Number.isFinite(diff)) {
      const up = diff > 0;
      const good = lowerIsBetter ? !up : up;
      delta = {
        text: `${up ? "▲" : diff < 0 ? "▼" : ""} ${Math.abs(Math.round(diff))}${points ? " pts" : "%"}`,
        tone:
          Math.round(diff) === 0 || neutral ? "flat" : good ? "good" : "bad",
      };
    }
  }
  return (
    <div class="dash-kpi">
      <span class="dash-kpi-label">{label}</span>
      <span class="dash-kpi-value">{value}</span>
      <span class="dash-kpi-meta">
        {delta ? (
          <span
            class={`delta ${delta.tone}`}
            title="Against the previous window"
          >
            {delta.text}
          </span>
        ) : (
          <span class="muted">no earlier window</span>
        )}
        {sub && <span class="muted">{sub}</span>}
      </span>
      {spark && <Sparkline values={spark} />}
    </div>
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div class={alert ? "alert" : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Histogram({ bins }: { bins: DashboardView["durations"] }) {
  const max = Math.max(1, ...bins.map((b) => b.n));
  let from = 0;
  return (
    <div class="viz-hist" role="img" aria-label="Histogram of time to verdict">
      {bins.map((b) => {
        const range =
          b.toMs === null
            ? `${from / 60_000}+`
            : `${from / 60_000}–${b.toMs / 60_000}`;
        const label = b.toMs === null ? range : String(from / 60_000);
        const title = `${range} min: ${plural(b.n, "review")}`;
        from = b.toMs ?? from;
        return (
          <div class="viz-hist-col" title={title}>
            <span class="viz-hist-n">{b.n || ""}</span>
            <span
              class="viz-hist-bar"
              style={{ height: `${(b.n / max) * 100}%` }}
            />
            <span class="viz-hist-x">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Recent({ rows, now }: { rows: RunRow[]; now: number }) {
  if (!rows.length)
    return <p class="muted dash-note">No reviews in this window.</p>;
  return (
    <ul class="dash-recent">
      {rows.map((r) => {
        const tone =
          r.status === "failed"
            ? CRITICAL
            : r.status === "done"
              ? r.decision === "changes_requested"
                ? SERIOUS
                : GOOD
              : MUTED;
        const outcome =
          r.status === "done"
            ? r.decision === "changes_requested"
              ? `changes requested · ${plural(r.findings ?? 0, "finding")}`
              : `no blockers · ${plural(r.findings ?? 0, "finding")}`
            : r.status === "failed"
              ? `failed: ${FAILURE_LABEL[r.failure ?? "other"]}`
              : r.status;
        return (
          <li>
            <i style={{ background: tone }} aria-hidden="true" />
            <a href={r.link}>
              {r.repo}#{r.number}
            </a>
            <span class="loc muted">{r.headSha.slice(0, 7)}</span>
            <span>{outcome}</span>
            <span class="muted">
              {r.endedAt ? fmtMs(r.endedAt - r.startedAt) : ""}
            </span>
            <span class="muted">{r.costUsd > 0 ? fmtUsd(r.costUsd) : ""}</span>
            <time class="muted" title={fmtAbs(r.startedAt)}>
              {fmtAgo(r.startedAt, now)}
            </time>
          </li>
        );
      })}
    </ul>
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

const root = document.getElementById("app");
if (root) render(<Dashboard />, root);
