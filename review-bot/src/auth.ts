// "Sign in with GitHub" through the App's user authorization. Only the login
// and id are kept, in a signed session cookie. The user token is used once to
// read /user and then dropped.

import { ghJson } from "./github";
import type { Env } from "./review";
import {
  b64url,
  configured,
  cookie,
  isSession,
  readSession,
  seal,
  type Session,
  SESSION_COOKIE,
  SESSION_TTL_S,
  setCookie,
  STATE_COOKIE,
  STATE_TTL_S,
  unseal,
} from "./session";

/** Sign-in only ever returns to a review page on this site. */
const RETURN_PATH = /^\/r\/[\w.-]+\/[\w.-]+\/\d+\?sha=[0-9a-f]{40}(#[\w-]*)?$/;

const plain = (body: string, status: number) =>
  new Response(`${body}\n`, { status });

const NOT_CONFIGURED = "GitHub sign-in is not configured here.";

const callbackUrl = (request: Request) =>
  `${new URL(request.url).origin}/auth/callback`;

export async function login(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return plain(NOT_CONFIGURED, 503);
  const back = new URL(request.url).searchParams.get("return") ?? "";
  if (!RETURN_PATH.test(back))
    return plain("return must be a review page path", 400);
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
        await seal(env.SESSION_SECRET!, "oauth", { state, back }, STATE_TTL_S),
        STATE_TTL_S,
        "/auth",
      ),
    },
  });
}

export async function callback(request: Request, env: Env): Promise<Response> {
  if (!configured(env)) return plain(NOT_CONFIGURED, 503);
  const url = new URL(request.url);
  const saved = (await unseal(
    env.SESSION_SECRET!,
    "oauth",
    cookie(request, STATE_COOKIE),
  )) as { state?: unknown; back?: unknown } | null;
  const code = url.searchParams.get("code");
  if (
    !saved ||
    !code ||
    typeof saved.state !== "string" ||
    url.searchParams.get("state") !== saved.state ||
    typeof saved.back !== "string" ||
    !RETURN_PATH.test(saved.back)
  )
    return plain(
      "Sign-in expired or did not start here. Go back to the review and try again.",
      400,
    );

  let user: Session;
  try {
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
      return plain(
        `GitHub sign-in failed: ${grant.error_description ?? `HTTP ${res.status}`}. Go back to the review and try again.`,
        502,
      );
    const me: unknown = await ghJson(grant.access_token, "/user");
    if (!isSession(me)) throw new Error("GitHub /user returned no login");
    user = { login: me.login, id: me.id };
  } catch (e) {
    console.error("GitHub sign-in", e);
    return plain(
      "GitHub did not answer the sign-in. Go back to the review and try again.",
      502,
    );
  }

  const headers = new Headers({ location: saved.back });
  headers.append(
    "set-cookie",
    setCookie(
      SESSION_COOKIE,
      await seal(env.SESSION_SECRET!, "session", user, SESSION_TTL_S),
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
  return Response.json(
    { configured: configured(env), login: session?.login ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
