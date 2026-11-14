import { gh, GitHubError } from "./github";

export type CiState = "success" | "failed" | "pending" | "none" | "unavailable";
export type CiItem = {
  id: number;
  name: string;
  state: Exclude<CiState, "none">;
  detail: string;
  url: string | null;
};
export type CiSource =
  | { kind: "available"; items: CiItem[] }
  | { kind: "unavailable"; items: CiItem[]; reason: string };
export type Base = { owner: string; repo: string; sha: string };
export type Standard =
  | {
      kind: "available";
      blobSha: string;
      sha256: string;
      text: string;
      url: string;
    }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };
export type Evidence = {
  headSha: string;
  base: Base | null;
  capturedAt: number;
  checks: CiSource;
  statuses: CiSource;
  standard: Standard;
};

const MAX_PAGES = 10;
export const MAX_STANDARD_BYTES = 32 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid GitHub string");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid GitHub integer");
  return value;
}

function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("Invalid GitHub SHA");
  return result;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function json(token: string, path: string): Promise<unknown> {
  const response = await gh(token, path, {
    signal: AbortSignal.timeout(10_000),
  });
  return response.json();
}

function reason(error: unknown): string {
  if (error instanceof GitHubError)
    return `GitHub returned HTTP ${error.status}`;
  return error instanceof Error
    ? error.message
    : "GitHub evidence could not be read";
}

type CiParser = (row: unknown) => { key: string; item: CiItem };

function parseCheckRun(row: unknown, headSha: string): ReturnType<CiParser> {
  if (!record(row)) throw new Error("Invalid GitHub check run");
  if (sha(row.head_sha) !== headSha)
    throw new Error("Check run belongs to another commit");
  const id = integer(row.id);
  const status = string(row.status);
  const detail = row.conclusion === null ? status : string(row.conclusion);
  const conclusions: Record<string, CiItem["state"]> = {
    success: "success",
    failure: "failed",
    cancelled: "failed",
    timed_out: "failed",
    action_required: "failed",
    startup_failure: "failed",
    stale: "failed",
  };
  const running: Record<string, CiItem["state"]> = {
    queued: "pending",
    in_progress: "pending",
    waiting: "pending",
    requested: "pending",
    pending: "pending",
  };
  const state =
    (status === "completed" ? conclusions[detail] : running[status]) ??
    "unavailable";
  return {
    key: String(id),
    item: {
      id,
      name: string(row.name),
      state,
      detail,
      url: safeUrl(row.details_url),
    },
  };
}

function parseStatus(row: unknown): ReturnType<CiParser> {
  if (!record(row)) throw new Error("Invalid GitHub commit status");
  const name = string(row.context);
  const detail = string(row.state);
  const states: Record<string, CiItem["state"]> = {
    success: "success",
    pending: "pending",
    failure: "failed",
    error: "failed",
  };
  return {
    key: name.toLowerCase(),
    item: {
      id: integer(row.id),
      name,
      state: states[detail] ?? "unavailable",
      detail,
      url: safeUrl(row.target_url),
    },
  };
}

async function ciSource(
  token: string,
  path: string,
  rows: (payload: unknown) => unknown,
  parse: CiParser,
): Promise<CiSource> {
  const items = new Map<string, CiItem>();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const payload = rows(
        await json(token, `${path}&per_page=100&page=${page}`),
      );
      if (!Array.isArray(payload))
        throw new Error("Invalid GitHub CI response");
      for (const row of payload) {
        const { key, item } = parse(row);
        // Statuses are returned newest first; an older result cannot erase a rerun.
        if (!items.has(key)) items.set(key, item);
      }
      if (payload.length < 100)
        return { kind: "available", items: [...items.values()] };
    }
    throw new Error("CI pagination limit reached; evidence is incomplete");
  } catch (error) {
    return {
      kind: "unavailable",
      items: [...items.values()],
      reason: reason(error),
    };
  }
}

async function standard(
  token: string,
  base: Base | undefined,
): Promise<Standard> {
  if (!base)
    return {
      kind: "unavailable",
      reason: "This review has no pinned base commit",
    };
  const root = `/repos/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.repo)}`;
  try {
    sha(base.sha);
    const commit = await json(token, `${root}/git/commits/${base.sha}`);
    if (!record(commit) || sha(commit.sha) !== base.sha)
      throw new Error("Base commit could not be verified");
    let content: unknown;
    try {
      content = await json(
        token,
        `${root}/contents/CODING_STANDARDS.md?ref=${base.sha}`,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404)
        return { kind: "absent" };
      throw error;
    }
    if (
      !record(content) ||
      content.type !== "file" ||
      content.encoding !== "base64"
    )
      throw new Error("CODING_STANDARDS.md is not an inline UTF-8 file");
    const size = integer(content.size);
    if (size > MAX_STANDARD_BYTES)
      throw new Error("CODING_STANDARDS.md exceeds the 32 KiB limit");
    const encoded = string(content.content);
    if (encoded.length > MAX_STANDARD_BYTES * 2)
      throw new Error("CODING_STANDARDS.md encoding exceeds its limit");
    const bytes = Uint8Array.from(atob(encoded.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.length !== size || bytes.length > MAX_STANDARD_BYTES)
      throw new Error(
        "CODING_STANDARDS.md is incomplete or exceeds the 32 KiB limit",
      );
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return {
      kind: "available",
      blobSha: sha(content.sha),
      sha256,
      text,
      url: `https://github.com/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.repo)}/blob/${base.sha}/CODING_STANDARDS.md`,
    };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

export async function collectEvidence(
  token: string,
  target: { owner: string; repo: string; headSha: string; base?: Base },
): Promise<Evidence> {
  const head = sha(target.headSha);
  const root = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${head}`;
  const [checks, statuses, policy] = await Promise.all([
    ciSource(
      token,
      `${root}/check-runs?filter=latest`,
      (payload) => (record(payload) ? payload.check_runs : undefined),
      (row) => parseCheckRun(row, head),
    ),
    ciSource(token, `${root}/statuses?`, (payload) => payload, parseStatus),
    standard(token, target.base),
  ]);
  return {
    headSha: head,
    base: target.base ?? null,
    capturedAt: Date.now(),
    checks,
    statuses,
    standard: policy,
  };
}

export function ciState(evidence: Evidence): CiState {
  const sources = [evidence.checks, evidence.statuses];
  const items = sources.flatMap((s) => s.items);
  if (items.some((i) => i.state === "failed")) return "failed";
  if (
    sources.some((s) => s.kind === "unavailable") ||
    items.some((i) => i.state === "unavailable")
  )
    return "unavailable";
  if (items.some((i) => i.state === "pending")) return "pending";
  return items.length ? "success" : "none";
}

export function evidenceAllowsApproval(
  evidence: Evidence | null | undefined,
): boolean {
  return (
    !!evidence &&
    ciState(evidence) === "success" &&
    evidence.standard.kind !== "unavailable"
  );
}

export function evidenceGaps(evidence: Evidence | null | undefined): string[] {
  if (!evidence)
    return [
      "No CI or team standard evidence snapshot was captured for this review.",
    ];
  const gaps: string[] = [];
  if (ciState(evidence) !== "success")
    gaps.push(
      `CI snapshot for ${evidence.headSha}: ${ciState(evidence)}. This is not proof that required checks passed.`,
    );
  for (const [name, source] of [
    ["Check runs", evidence.checks],
    ["Commit statuses", evidence.statuses],
  ] as const) {
    if (source.kind === "unavailable")
      gaps.push(`${name} unavailable: ${source.reason}.`);
  }
  if (evidence.standard.kind === "unavailable")
    gaps.push(`Team standard unavailable: ${evidence.standard.reason}.`);
  if (evidence.standard.kind === "absent")
    gaps.push(
      "No CODING_STANDARDS.md exists at the pinned base commit; only the review rubric applies.",
    );
  return gaps;
}

export function renderEvidence(evidence: Evidence | null | undefined): string {
  if (!evidence) return evidenceGaps(evidence).join("\n");
  const base = evidence.base;
  return [
    `CI snapshot at ${new Date(evidence.capturedAt).toISOString()} for head ${evidence.headSha}. Observed CI: ${ciState(evidence)}. This is not a live status or proof of required checks.`,
    ...[
      ["Check runs", evidence.checks],
      ["Commit statuses", evidence.statuses],
    ].map(([name, source]) => `${name}: ${JSON.stringify(source)}`),
    `Team standard at ${base ? `${base.owner}/${base.repo}@${base.sha}/CODING_STANDARDS.md` : "unknown base"}:`,
    JSON.stringify(evidence.standard),
    ...evidenceGaps(evidence),
  ].join("\n");
}

export function evidenceHtml(evidence: Evidence | null | undefined): string {
  const esc = (value: unknown) =>
    String(value).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  if (!evidence)
    return '<p class="empty">No evidence snapshot for this review.</p>';
  const sources = [
    ["Check runs", evidence.checks],
    ["Commit statuses", evidence.statuses],
  ] as const;
  const rows = sources
    .map(
      ([name, source]) =>
        `<div class="card"><strong>${name}</strong>${source.kind === "unavailable" ? `<p class="err">Unavailable: ${esc(source.reason)}</p>` : ""}${source.items.length ? `<ul>${source.items.map((item) => `<li>${safeUrl(item.url) ? `<a href="${esc(safeUrl(item.url))}" rel="noreferrer">${esc(item.name)}</a>` : esc(item.name)}: ${esc(item.state)} (${esc(item.detail)})</li>`).join("")}</ul>` : '<p class="empty">No results observed.</p>'}</div>`,
    )
    .join("");
  const policy = evidence.standard;
  const base = evidence.base;
  const provenance = base
    ? `${base.owner}/${base.repo}@${base.sha}/CODING_STANDARDS.md`
    : "Unknown base commit";
  const standardBody =
    policy.kind === "available"
      ? `<a href="${esc(safeUrl(policy.url) ?? "#")}">Base standard</a><p class="loc">blob ${esc(policy.blobSha)} · sha256 ${esc(policy.sha256)}</p><details><summary>Read team standard</summary><pre>${esc(policy.text)}</pre></details>`
      : `<p>${policy.kind === "absent" ? "Absent at the pinned base. The review rubric applies." : `Unavailable: ${esc(policy.reason)}`}</p>`;
  return `<p>Observed CI: <strong>${ciState(evidence)}</strong></p><p class="loc">Head ${esc(evidence.headSha)}<br>Captured ${esc(new Date(evidence.capturedAt).toISOString())}. Snapshot, not live CI or proof of required checks.</p>${rows}<div class="card"><strong>Team standard</strong><p class="loc">${esc(provenance)}</p>${standardBody}</div>`;
}
