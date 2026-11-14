// A named human's sign-off on one reviewed commit.
//
// The signer logs in with GitHub (auth.ts), so the page knows who they are,
// and must have write access to the repository. They
// state what they checked, what was not checked, the residual risk they accept,
// and a decision with a reason on every blocking finding. The sign-off is
// stored with the review of that exact commit, then echoed to the PR as a
// comment and an "owner sign-off" commit status. The AI review stays advice:
// only this record says a person owns the change.

import { blocks, type Confidence, type Severity } from "./findings";
import { gh, ghJson, installationToken } from "./github";
import type { Env, ReviewView } from "./review";
import { reviewKey, reviewLink } from "./review-key";
import type { Target } from "./reviewer";
import { readSession, type Session } from "./session";

export const STATUS_CONTEXT = "bumble-bot/owner-sign-off";
const COMMENT_MARKER = "<!-- bumble-bot-owner-sign-off -->";
const MAX_TEXT = 4000;
const WRITE = new Set(["admin", "write"]);

export type Disposition = {
  findingId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** Accept: a real risk the owner takes on. Dismiss: not a real problem. */
  decision: "accept" | "dismiss";
  reason: string;
};

export type Echo = { ok: true } | { ok: false; error: string };

export type SignOff = {
  signer: { login: string; id: number };
  /** The signer's repository permission when they signed. */
  permission: string;
  headSha: string;
  at: number;
  /** What the owner checked themselves. */
  checked: string;
  /** The AI's own "not checked" list, as it stood when the owner signed. */
  aiNotChecked: string[];
  /** What else the owner did not check, and why. */
  notChecked: string;
  risk: string;
  findings: { total: number; blocking: number };
  dispositions: Disposition[];
  /** Whether the PR comment and commit status were written. Null until tried. */
  echo: { comment: Echo; status: Echo } | null;
};

export class SignOffError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

// The sign-off itself

const text = (value: unknown, field: string, required: boolean) => {
  if (value !== undefined && typeof value !== "string")
    throw new SignOffError(`${field} must be text.`);
  const s = (value ?? "").trim();
  if (required && !s) throw new SignOffError(`${field} is required.`);
  if (s.length > MAX_TEXT)
    throw new SignOffError(`${field} is longer than ${MAX_TEXT} characters.`);
  return s;
};

/**
 * Checks the owner's input against the finished review and builds the record.
 * Every blocking finding needs a decision and a reason: the owner cannot sign
 * past a blocker without saying why.
 */
export function buildSignOff(
  input: unknown,
  view: ReviewView,
  signer: Session,
  permission: string,
  now = Date.now(),
): SignOff {
  if (view.status !== "done" || !view.review.verdict || !view.review.target)
    throw new SignOffError("The review has not finished yet.", 409);
  if (typeof input !== "object" || input === null)
    throw new SignOffError("Send the sign-off as a JSON object.");
  const body = input as Record<string, unknown>;
  if (body.confirm !== true)
    throw new SignOffError("Confirm that you own this change.");

  const given = Array.isArray(body.dispositions) ? body.dispositions : [];
  const blocking = view.review.findings.filter(blocks);
  const missing: string[] = [];
  const dispositions: Disposition[] = blocking.flatMap((f) => {
    const d = given.find(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && x.findingId === f.id,
    );
    if (
      !d ||
      (d.decision !== "accept" && d.decision !== "dismiss") ||
      typeof d.reason !== "string" ||
      !d.reason.trim()
    ) {
      missing.push(f.title);
      return [];
    }
    return [
      {
        findingId: f.id,
        title: f.title,
        severity: f.severity,
        confidence: f.confidence ?? "verified",
        decision: d.decision,
        reason: text(d.reason, "A finding's reason", true),
      },
    ];
  });
  if (missing.length)
    throw new SignOffError(
      `Accept or dismiss, with a reason, each blocking finding: ${missing.join("; ")}`,
      422,
    );

  return {
    signer,
    permission,
    headSha: view.review.target.headSha,
    at: now,
    checked: text(body.checked, "What you checked", true),
    aiNotChecked: view.review.verdict.notChecked,
    notChecked: text(body.notChecked, "What you did not check", false),
    risk: text(body.risk, "The residual risk you accept", true),
    findings: { total: view.review.findings.length, blocking: blocking.length },
    dispositions,
    echo: null,
  };
}

export async function signOff(
  request: Request,
  env: Env,
  pr: { owner: string; repo: string; number: number; headSha: string },
): Promise<Response> {
  try {
    // Same-origin only. SameSite=Lax already keeps the cookie off cross-site
    // POSTs; this also refuses requests from other pages on other origins.
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw new SignOffError("Sign off from the review page.", 403);
    const session = await readSession(request, env);
    if (!session) throw new SignOffError("Sign in with GitHub first.", 401);
    const input = await request.json().catch(() => {
      throw new SignOffError("Send the sign-off as JSON.");
    });

    const stub = env.REVIEWS.getByName(reviewKey(pr));
    // Typed as manual.ts does: the RPC stub's inferred type collapses here.
    const view: ReviewView = await stub.view();
    if (view.signOff)
      throw new SignOffError(
        `@${view.signOff.signer.login} already signed off on this commit.`,
        409,
      );
    const target = view.review.target;
    if (!target || target.mode === "manual")
      throw new SignOffError(
        "Only reviews of installed repositories can be signed.",
        409,
      );

    const { token, permission } = await authorize(env, target, session);
    const record = buildSignOff(input, view, session, permission);
    const earlier = await stub.storeSignOff(record);
    if (earlier)
      throw new SignOffError(
        `@${earlier.signer.login} already signed off on this commit.`,
        409,
      );

    // Stored: from here the sign-off stands, whatever else fails. Errors are
    // reported with it rather than as a failed save.
    record.echo = await echo(env, token, target, record);
    try {
      await stub.recordEcho(record.echo);
    } catch (e) {
      console.error("sign-off echo not recorded", e);
    }
    return json(record);
  } catch (e) {
    if (e instanceof SignOffError) return json({ error: e.message }, e.status);
    console.error("sign-off failed", e);
    return json({ error: "The sign-off could not be saved. Try again." }, 500);
  }
}

/**
 * Whether this person may sign this commit now: it must still be the PR head,
 * and they need write access. Checked with the App's installation token, never
 * with anything the browser sends.
 */
async function authorize(
  env: Env,
  target: Target & { mode?: "webhook"; installationId: number },
  session: Session,
): Promise<{ token: string; permission: string }> {
  const { token } = await installationToken(env, target.installationId);
  const base = `/repos/${target.owner}/${target.repo}`;
  const head = await ghJson<{ head: { sha: string } }>(
    token,
    `${base}/pulls/${target.number}`,
  );
  if (head.head.sha !== target.headSha)
    throw new SignOffError(
      `This commit is no longer the head of the PR. Sign the review of ${head.head.sha.slice(0, 7)} instead.`,
      409,
    );
  const permission = await ghJson<{ permission: string }>(
    token,
    `${base}/collaborators/${encodeURIComponent(session.login)}/permission`,
  ).then(
    (p) => p.permission,
    () => "none",
  );
  if (!WRITE.has(permission))
    throw new SignOffError(
      `@${session.login} has ${permission} access to ${target.owner}/${target.repo}. Signing needs write access.`,
      403,
    );
  return { token, permission };
}

// Echo to GitHub

const settle = (p: Promise<unknown>): Promise<Echo> =>
  p.then(
    () => ({ ok: true }) as const,
    (e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    }),
  );

async function echo(
  env: Env,
  token: string,
  t: Target,
  s: SignOff,
): Promise<{ comment: Echo; status: Echo }> {
  const link = reviewLink(env, t);
  const [comment, status] = await Promise.all([
    settle(
      gh(token, `/repos/${t.owner}/${t.repo}/issues/${t.number}/comments`, {
        method: "POST",
        body: { body: signOffComment(s, link) },
      }),
    ),
    settle(
      setOwnerStatus(
        token,
        t,
        "success",
        `Signed off by @${s.signer.login}`,
        link,
      ),
    ),
  ]);
  return { comment, status };
}

/** Marks a commit as waiting for, or holding, a named owner's sign-off. */
export function setOwnerStatus(
  token: string,
  t: Pick<Target, "owner" | "repo" | "headSha">,
  state: "pending" | "success",
  description: string,
  targetUrl: string,
) {
  return gh(token, `/repos/${t.owner}/${t.repo}/statuses/${t.headSha}`, {
    method: "POST",
    body: {
      state,
      context: STATUS_CONTEXT,
      description: description.slice(0, 140),
      target_url: targetUrl,
    },
  });
}

// Text from the owner or the AI must not ping people: a zero-width space after
// "@" keeps it readable but stops GitHub treating it as a mention.
const unmention = (s: string) => s.replace(/@(?=[\w-])/g, "@\u200b");

/** Multi-line text as a block quote, optionally indented into a list item. */
const quote = (s: string, indent = "") =>
  unmention(s)
    .split("\n")
    .map((l) => `${indent}> ${l}`)
    .join("\n");

const line = (s: string) => unmention(s.replace(/\s+/g, " ").trim());

export function signOffComment(s: SignOff, link: string): string {
  const short = s.headSha.slice(0, 7);
  const notChecked = [
    ...s.aiNotChecked.map((x) => `- ${line(x)} _(listed by the AI)_`),
    ...(s.notChecked ? [quote(s.notChecked)] : []),
  ];
  return [
    COMMENT_MARKER,
    `### ✍️ @${s.signer.login} signed off on \`${short}\``,
    `They own this change. Bumble Bot's [review of \`${short}\`](${link}) is the evidence they read, not the approval.`,
    "",
    "**Checked by the owner**",
    quote(s.checked),
    "",
    `**Checked by Bumble Bot:** an AI review with ${s.findings.total} ${s.findings.total === 1 ? "finding" : "findings"}, ${s.findings.blocking} blocking.`,
    ...(s.dispositions.length
      ? [
          "",
          "**Blocking findings**",
          ...s.dispositions.map(
            (d) =>
              `- **${d.decision === "accept" ? "Risk accepted" : "Dismissed"}:** ${line(d.title)}\n${quote(d.reason, "  ")}`,
          ),
        ]
      : []),
    "",
    "**Not checked**",
    ...(notChecked.length ? notChecked : ["- Nothing listed."]),
    "",
    "**Residual risk accepted**",
    quote(s.risk),
  ].join("\n");
}
