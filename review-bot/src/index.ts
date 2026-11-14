// GitHub App webhook receiver and review pages. On pull request events it
// starts a review of the head commit and posts (or updates) one comment on the
// PR linking to that review's page.

import faviconSvg from "../assets/logo.svg";
import faviconIco from "../assets/favicon.ico";
import appleTouchIcon from "../assets/apple-touch-icon.png";
import {
  dismissBotApprovals,
  installationToken,
  upsertComment,
  validSignature,
} from "./github";
import { dashboardApi, dashboardPage, pruneLedger } from "./dashboard";
import { manualView, startManual } from "./manual";
import { type PrLive, prLive } from "./pr-live";
import { reviewPage } from "./page";
import { type Env, reviewLink } from "./review";
import { reviewKey } from "./review-key";
import type { Target } from "./reviewer";
import { callback, login, logout, me } from "./auth";
import { signOff, syncOwnerStatus } from "./signoff";

export { ManualGate } from "./manual-gate";
export { Review } from "./review";

const ICONS: Record<string, [BodyInit, string]> = {
  "/favicon.svg": [faviconSvg, "image/svg+xml"],
  "/favicon.ico": [faviconIco, "image/x-icon"],
  "/apple-touch-icon.png": [appleTouchIcon, "image/png"],
};

const MARKER = "<!-- earned-trust-review-link -->";
const PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);
const NAME = "[\\w.-]+";
const PAGE = new RegExp(`^/(r|m)/(${NAME})/(${NAME})/(\\d+)/?$`);
const LIVE_PR = new RegExp(
  `^/api/(?:r|m)/(${NAME})/(${NAME})/(\\d+)/([0-9a-f]{40})/pr$`,
);
const VIEW = new RegExp(
  `^/api/(r|m)/(${NAME})/(${NAME})/(\\d+)/([0-9a-f]{40})$`,
);
const SIGN = new RegExp(
  `^/api/r/(${NAME})/(${NAME})/(\\d+)/([0-9a-f]{40})/signoff$`,
);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/reviews")
      return startManual(request, env);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    const sign = request.method === "POST" && url.pathname.match(SIGN);
    if (sign) {
      const [, owner, repo, number, headSha] = sign;
      return signOff(request, env, {
        owner,
        repo,
        number: Number(number),
        headSha,
      });
    }
    if (request.method !== "GET")
      return new Response("not found\n", { status: 404 });

    if (url.pathname === "/auth/login") return login(request, env);
    if (url.pathname === "/auth/callback") return callback(request, env);
    if (url.pathname === "/auth/logout") return logout(request);
    if (url.pathname === "/api/me") return me(request, env);

    const icon = ICONS[url.pathname];
    if (icon) {
      return new Response(icon[0], {
        headers: {
          "content-type": icon[1],
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/dashbaord" || url.pathname === "/dashboard/")
      return Response.redirect(new URL("/dashboard" + url.search, url), 301);
    if (url.pathname === "/dashboard") return dashboardPage();
    if (url.pathname === "/api/dashboard") return dashboardApi(env.LEDGER, url);

    let m = url.pathname.match(PAGE);
    if (m) {
      const sha = url.searchParams.get("sha") ?? "";
      if (!/^[0-9a-f]{40}$/.test(sha))
        return new Response("sha query parameter required\n", { status: 400 });
      const [, mode, owner, repo, number] = m;
      return reviewPage({
        manual: mode === "m",
        owner,
        repo,
        number,
        headSha: sha,
      });
    }

    m = url.pathname.match(LIVE_PR);
    if (m) {
      const [, owner, repo, number, headSha] = m;
      const live = await cachedPrLive(env, url.pathname, {
        owner,
        repo,
        number: Number(number),
        headSha,
      });
      return Response.json(live, { headers: { "cache-control": "no-store" } });
    }

    m = url.pathname.match(VIEW);
    if (m) {
      const [, mode, owner, repo, number, headSha] = m;
      const target = { owner, repo, number: Number(number), headSha };
      if (mode === "m") return manualView(env, target);
      const view = await env.REVIEWS.getByName(reviewKey(target)).view();
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    }

    if (
      url.pathname === "/" ||
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname) ||
      /^\/review\/(assets\/)?[a-zA-Z0-9_.-]+$/.test(url.pathname)
    )
      return env.ASSETS.fetch(request);
    return new Response("not found\n", { status: 404 });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    if (env.LEDGER) ctx.waitUntil(pruneLedger(env.LEDGER, Date.now()));
  },
} satisfies ExportedHandler<Env>;

// GitHub is read at most once per 15 seconds per commit and isolate, however many pages poll.
const LIVE_TTL_MS = 15_000;
const liveCache = new Map<string, { at: number; value: Promise<PrLive> }>();

function cachedPrLive(
  env: Env,
  key: string,
  target: Parameters<typeof prLive>[1],
): Promise<PrLive> {
  const now = Date.now();
  for (const [k, v] of liveCache)
    if (now - v.at > LIVE_TTL_MS) liveCache.delete(k);
  const hit = liveCache.get(key);
  if (hit) return hit.value;
  const value = prLive(env, target);
  liveCache.set(key, { at: now, value });
  value.catch(() => liveCache.delete(key));
  return value;
}

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

  const pr = payload.pull_request;
  const target: Target = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: pr.number,
    headSha: pr.head.sha,
    base: {
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      sha: pr.base.sha,
    },
    installationId: payload.installation.id,
  };
  const review = env.REVIEWS.getByName(reviewKey(target));
  await review.start(target);

  const { token } = await installationToken(env, target.installationId);
  const comment = `${MARKER}\n🐝 [Bumble Bot review](${reviewLink(env, target)})`;
  await upsertComment(
    token,
    target.owner,
    target.repo,
    target.number,
    MARKER,
    comment,
  );
  await dismissBotApprovals(token, target);
  // The owner sign-off status follows what is stored for this commit (see
  // syncOwnerStatus). A failure here (for example the App lacking "Commit
  // statuses: write") must not stop the review.
  try {
    await syncOwnerStatus(env, token, target, review);
  } catch (e) {
    console.error("owner sign-off status", e);
  }
  return new Response("review started\n");
}
