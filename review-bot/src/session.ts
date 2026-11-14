// Signed, HttpOnly cookies: the signed-in GitHub identity, and the OAuth state
// that ties a callback to the login that started it.

import type { Env } from "./review";

export type Session = { login: string; id: number };

export const SESSION_COOKIE = "bb_session";
export const STATE_COOKIE = "bb_oauth";
export const SESSION_TTL_S = 8 * 60 * 60;
export const STATE_TTL_S = 10 * 60;

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array) =>
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

/**
 * What a sealed value is for. It is signed with the value, so a cookie sealed
 * for one purpose (say the OAuth state) is never accepted as another (a session).
 */
export type Purpose = "session" | "oauth";

export async function seal(
  secret: string,
  purpose: Purpose,
  value: unknown,
  ttlS: number,
) {
  const body = b64url(
    enc.encode(
      JSON.stringify({
        p: purpose,
        v: value,
        exp: Math.floor(Date.now() / 1000) + ttlS,
      }),
    ),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    enc.encode(body),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function unseal(
  secret: string,
  purpose: Purpose,
  token: string | undefined,
): Promise<unknown> {
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
    const { p, v, exp } = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return p === purpose && typeof exp === "number" && exp > Date.now() / 1000
      ? v
      : null;
  } catch {
    return null;
  }
}

export function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export const setCookie = (
  name: string,
  value: string,
  maxAge: number,
  path = "/",
) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

/** Whether GitHub sign-in can work on this deployment. */
export const configured = (env: Env) =>
  Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET,
  );

export const isSession = (v: unknown): v is Session =>
  typeof v === "object" &&
  v !== null &&
  "login" in v &&
  typeof v.login === "string" &&
  /^[A-Za-z0-9-]{1,39}$/.test(v.login) &&
  "id" in v &&
  typeof v.id === "number";

export async function readSession(
  request: Request,
  env: Env,
): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const v = await unseal(
    env.SESSION_SECRET,
    "session",
    cookie(request, SESSION_COOKIE),
  );
  return isSession(v) ? { login: v.login, id: v.id } : null;
}
