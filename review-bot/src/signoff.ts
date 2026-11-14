// A named human's sign-off on one reviewed commit.
//
// The signer logs in with GitHub through the App's user authorization, so the
// page knows who they are, and must have write access to the repository. They
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

export const STATUS_CONTEXT = "bumble-bot/owner-sign-off";
const COMMENT_MARKER = "<!-- bumble-bot-owner-sign-off -->";
const SESSION_COOKIE = "bb_session";
const STATE_COOKIE = "bb_oauth";
const SESSION_TTL_S = 8 * 60 * 60;
const STATE_TTL_S = 10 * 60;
const MAX_TEXT = 4000;
const WRITE = new Set(["admin", "write"]);
const RETURN_PATH = /^\/r\/[\w.-]+\/[\w.-]+\/\d+\?sha=[0-9a-f]{40}(#[\w-]*)?$/;

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

export type Session = { login: string; id: number };

export class SignOffError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

// Signed cookies

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function seal(secret: string, value: unknown, ttlS: number) {
  const body = b64url(
    enc.encode(
      JSON.stringify({ v: value, exp: Math.floor(Date.now() / 1000) + ttlS }),
    ),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    enc.encode(body),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function unseal<T>(
  secret: string,
  token: string | undefined,
): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      unb64url(sig),
      enc.encode(body),
    );
    if (!ok) return null;
    const { v, exp } = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return typeof exp === "number" && exp > Date.now() / 1000 ? (v as T) : null;
  } catch {
    return null;
  }
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge: number, path = "/") =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const configured = (env: Env) =>
  Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET,
  );

export function readSession(request: Request, env: Env) {
  if (!env.SESSION_SECRET) return Promise.resolve(null);
  return unseal<Session>(env.SESSION_SECRET, cookie(request, SESSION_COOKIE));
}

// GitHub login

export async function login(request: Request, env: Env): Promise<Response> {
  if (!configured(env))
    return new Response("GitHub sign-in is not configured here.\n", {
      status: 503,
    });
  const back = new URL(request.url).searchParams.get("return") ?? "";
  if (!RETURN_PATH.test(back))
    return new Response("return must be a review page path\n", { status: 400 });
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", callbackUrl(request));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": setCookie(
        STATE_COOKIE,
        await seal(env.SESSION_SECRET!, { state, back }, STATE_TTL_S),
        STATE_TTL_S,
        "/auth",
      ),
    },
  });
}

const callbackUrl = (request: Request) =>
  `${new URL(request.url).origin}/auth/callback`;

export async function callback(request: Request, env: Env): Promise<Response> {
  if (!configured(env))
    return new Response("GitHub sign-in is not configured here.\n", {
      status: 503,
    });
  const url = new URL(request.url);
  const saved = await unseal<{ state: string; back: string }>(
    env.SESSION_SECRET!,
    cookie(request, STATE_COOKIE),
  );
  const code = url.searchParams.get("code");
  if (!saved || !code || url.searchParams.get("state") !== saved.state)
    return new Response(
      "Sign-in expired or did not start here. Go back to the review and try again.\n",
      { status: 400 },
    );

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "bumble-bot",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request),
    }),
  });
  const grant = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!grant.access_token)
    return new Response(
      `GitHub sign-in failed: ${grant.error_description ?? res.status}\n`,
      { status: 502 },
    );
  // Only the identity is kept. The user token is not stored or used again.
  const user = await ghJson<{ login: string; id: number }>(
    grant.access_token,
    "/user",
  );
  const headers = new Headers({ location: saved.back });
  headers.append(
    "set-cookie",
    setCookie(
      SESSION_COOKIE,
      await seal(
        env.SESSION_SECRET!,
        { login: user.login, id: user.id } satisfies Session,
        SESSION_TTL_S,
      ),
      SESSION_TTL_S,
    ),
  );
  headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0, "/auth"));
  return new Response(null, { status: 302, headers });
}

export function logout(request: Request): Response {
  const back = new URL(request.url).searchParams.get("return") ?? "";
  return new Response(null, {
    status: 302,
    headers: {
      location: RETURN_PATH.test(back) ? back : "/",
      "set-cookie": setCookie(SESSION_COOKIE, "", 0),
    },
  });
}

export async function me(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  return json({ configured: configured(env), login: session?.login ?? null });
}

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
    const reason = d && typeof d.reason === "string" ? d.reason.trim() : "";
    if (
      !d ||
      (d.decision !== "accept" && d.decision !== "dismiss") ||
      !reason
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
        reason: text(reason, "A finding's reason", true),
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

    const record = buildSignOff(input, view, session, permission);
    const earlier = await stub.storeSignOff(record);
    if (earlier)
      throw new SignOffError(
        `@${earlier.signer.login} already signed off on this commit.`,
        409,
      );

    record.echo = await echo(env, token, target, record);
    await stub.recordEcho(record.echo);
    return json(record);
  } catch (e) {
    if (e instanceof SignOffError) return json({ error: e.message }, e.status);
    console.error("sign-off failed", e);
    return json({ error: "The sign-off could not be saved. Try again." }, 500);
  }
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

const quote = (s: string) =>
  s
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

export function signOffComment(s: SignOff, link: string): string {
  const short = s.headSha.slice(0, 7);
  const notChecked = [
    ...s.aiNotChecked.map((x) => `- ${x} _(listed by the AI)_`),
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
              `- ${d.decision === "accept" ? "Risk accepted" : "Dismissed"}: ${d.title}. _${d.reason}_`,
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
