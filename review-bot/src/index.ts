// GitHub App webhook receiver and review pages. On pull request events it
// starts a review of the head commit and posts (or updates) one comment on the
// PR linking to that review's page.

import faviconSvg from "../assets/logo.svg";
import faviconIco from "../assets/favicon.ico";
import appleTouchIcon from "../assets/apple-touch-icon.png";
import {
  dismissStaleApprovals,
  installationToken,
  upsertComment,
  validSignature,
} from "./github";
import { manualView, startManual } from "./manual";
import { reviewPage } from "./page";
import { type Env, reviewLink } from "./review";
import { reviewKey } from "./review-key";
import type { Target } from "./reviewer";

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
const VIEW = new RegExp(
  `^/api/(r|m)/(${NAME})/(${NAME})/(\\d+)/([0-9a-f]{40})$`,
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/reviews")
      return startManual(request, env);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    if (request.method !== "GET")
      return new Response("not found\n", { status: 404 });

    const icon = ICONS[url.pathname];
    if (icon) {
      return new Response(icon[0], {
        headers: {
          "content-type": icon[1],
          "cache-control": "public, max-age=86400",
        },
      });
    }

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

  const pr = payload.pull_request;
  const target: Target = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    number: pr.number,
    headSha: pr.head.sha,
    installationId: payload.installation.id,
  };
  await env.REVIEWS.getByName(reviewKey(target)).start(target);

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
  await dismissStaleApprovals(token, target);
  return new Response("review started\n");
}
