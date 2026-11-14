import type { Target } from "./reviewer";

// GitHub App auth and the REST calls the bot and the reviewer make.

import { fromStored, SEVERITIES, type Severity } from "./findings";

export interface AppSecrets {
  APP_ID: string;
  PRIVATE_KEY: string; // PKCS#8 PEM
}

const API = "https://api.github.com";
const HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "bumble-bot",
  "x-github-api-version": "2022-11-28",
};

export async function gh(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const res = await fetch(path.startsWith("https://") ? path : API + path, {
    method,
    headers: {
      ...HEADERS,
      ...(init.accept ? { accept: init.accept } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok)
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

export async function ghJson<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  return (await gh(token, path, init)).json() as Promise<T>;
}

export async function upsertComment(
  token: string,
  owner: string,
  repo: string,
  number: number,
  marker: string,
  body: string,
) {
  const base = `/repos/${owner}/${repo}/issues`;
  const comments = await ghJson<{ id: number; body: string }[]>(
    token,
    `${base}/${number}/comments?per_page=100`,
  );
  const existing = comments.find((c) => c.body.startsWith(marker));
  if (existing) {
    await gh(token, `${base}/comments/${existing.id}`, {
      method: "PATCH",
      body: { body },
    });
  } else {
    await gh(token, `${base}/${number}/comments`, {
      method: "POST",
      body: { body },
    });
  }
}

const REVIEW_MARKER = "<!-- earned-trust-review-approval -->";

type PrReview = {
  id: number;
  state: string;
  commit_id: string;
  body: string | null;
};

type Pr = { owner: string; repo: string; number: number };

function botReviews(token: string, pr: Pr) {
  return ghJson<PrReview[]>(
    token,
    `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews?per_page=100`,
  ).then((all) => all.filter((r) => r.body?.startsWith(REVIEW_MARKER)));
}

/** Publishes a compact result only while the reviewed commit is still the head. */
export async function publishReview(
  token: string,
  pr: Pr & { headSha: string },
  findings: readonly { severity: Severity }[],
  reportUrl: string,
) {
  const base = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  const current = await ghJson<{ head: { sha: string } }>(token, base);
  if (current.head.sha !== pr.headSha) return;
  const reviews = await botReviews(token, pr);
  if (
    reviews.some(
      (r) =>
        r.commit_id === pr.headSha &&
        (r.state === "APPROVED" || r.state === "COMMENTED"),
    )
  )
    return;
  const severities = findings.map((f) => fromStored(f).severity);
  const summary = [
    `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`,
    ...SEVERITIES.flatMap((severity) => {
      const count = severities.filter((s) => s === severity).length;
      return count ? [`${count} ${severity}`] : [];
    }),
  ].join(" · ");
  await gh(token, `${base}/reviews`, {
    method: "POST",
    body: {
      commit_id: pr.headSha,
      event: findings.length === 0 ? "APPROVE" : "COMMENT",
      body: `${REVIEW_MARKER}\n${summary}\n\n[Full report](${reportUrl})`,
    },
  });
}

/** Withdraws the bot's approvals of any commit other than `headSha`. */
export async function dismissStaleApprovals(
  token: string,
  pr: Pr & { headSha: string },
) {
  const base = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`;
  for (const r of await botReviews(token, pr)) {
    if (r.state !== "APPROVED" || r.commit_id === pr.headSha) continue;
    await gh(token, `${base}/reviews/${r.id}/dismissals`, {
      method: "PUT",
      body: {
        message: `New commit \`${pr.headSha.slice(0, 7)}\` pushed. The approval returns if its review has no findings.`,
        event: "DISMISS",
      },
    });
  }
}

export async function installationToken(
  app: AppSecrets,
  installationId: number,
): Promise<{ token: string; expiresAt: number }> {
  const jwt = await appJwt(app.APP_ID, app.PRIVATE_KEY);
  const res = await fetch(
    `${API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${jwt}` },
    },
  );
  if (!res.ok)
    throw new Error(`installation token -> ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

async function appJwt(appId: string, pem: string): Promise<string> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----|\s/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function validSignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

export type PrFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export async function prFiles(token: string, pr: Target): Promise<PrFile[]> {
  if (pr.mode === "manual") {
    const comparison = await ghJson<{ files: PrFile[] }>(
      token,
      `/repos/${pr.owner}/${pr.repo}/compare/${pr.baseSha}...${pr.headSha}`,
    );
    return comparison.files;
  }
  const files: PrFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await ghJson<PrFile[]>(
      token,
      `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`,
    );
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}
