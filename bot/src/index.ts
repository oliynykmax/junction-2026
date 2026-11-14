// GitHub App webhook receiver. On pull request events it posts (or updates)
// one comment on the PR linking to the review session for that PR.

export interface Env {
  APP_ID: string;
  PRIVATE_KEY: string; // PKCS#8 PEM
  WEBHOOK_SECRET: string;
  REVIEW_BASE_URL: string; // e.g. https://review.oliinyk.dev
}

const MARKER = "<!-- earned-trust-review-link -->";
const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    const m = url.pathname.match(/^\/r\/([\w.-]+)\/([\w.-]+)\/(\d+)\/?$/);
    if (request.method === "GET" && m) {
      return placeholderPage(m[1], m[2], Number(m[3]), url.searchParams.get("sha"));
    }

    if (url.pathname === "/") return new Response("review bot ok\n");
    return new Response("not found\n", { status: 404 });
  },
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!(await validSignature(env.WEBHOOK_SECRET, body, signature))) {
    return new Response("bad signature\n", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") return new Response("pong\n");
  if (event !== "pull_request") return new Response("ignored\n");

  const payload = JSON.parse(body);
  if (!PR_ACTIONS.has(payload.action)) return new Response("ignored\n");

  const owner: string = payload.repository.owner.login;
  const repo: string = payload.repository.name;
  const pr = payload.pull_request;
  const token = await installationToken(env, payload.installation.id);

  const link = `${env.REVIEW_BASE_URL}/r/${owner}/${repo}/${pr.number}?sha=${pr.head.sha}`;
  const comment =
    `${MARKER}\n` +
    `**Review session:** ${link}\n\n` +
    `<sub>For commit \`${pr.head.sha.slice(0, 7)}\`. The review is advice; merging needs a named human's sign-off on that page.</sub>`;

  await upsertComment(token, owner, repo, pr.number, comment);
  return new Response("commented\n");
}

async function upsertComment(token: string, owner: string, repo: string, number: number, body: string) {
  const base = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const comments = (await gh(token, `${base}/${number}/comments?per_page=100`)) as { id: number; body: string }[];
  const existing = comments.find((c) => c.body.startsWith(MARKER));
  if (existing) {
    await gh(token, `${base}/comments/${existing.id}`, "PATCH", { body });
  } else {
    await gh(token, `${base}/${number}/comments`, "POST", { body });
  }
}

async function gh(token: string, url: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "earned-trust-review-bot",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function installationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await appJwt(env.APP_ID, env.PRIVATE_KEY);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "earned-trust-review-bot",
    },
  });
  if (!res.ok) throw new Error(`installation token -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function appJwt(appId: string, pem: string): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function validSignature(secret: string, body: string, header: string): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

// Stand-in until the real review view is built.
function placeholderPage(owner: string, repo: string, number: number, sha: string | null): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const prUrl = `https://github.com/${owner}/${repo}/pull/${number}`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Review session</title>
<style>body{font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 16px}code{font-size:.9em}</style>
<h1>Review session</h1>
<p>Pull request: <a href="${esc(prUrl)}">${esc(owner)}/${esc(repo)}#${number}</a></p>
<p>Commit: <code>${esc(sha ?? "unknown")}</code></p>
<p>The review view for this PR is not built yet.</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
