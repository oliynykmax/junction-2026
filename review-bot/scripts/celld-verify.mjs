import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:9876");
const headers = new Headers();
if (process.env.CELLD_ORIGIN_TOKEN_FILE) {
  headers.set(
    "x-celld-origin-token",
    (await readFile(process.env.CELLD_ORIGIN_TOKEN_FILE, "utf8")).trim(),
  );
  headers.set("x-forwarded-host", base.host);
  headers.set("x-forwarded-proto", base.protocol.slice(0, -1));
}
async function get(path) {
  const response = await fetch(new URL(path, base), { headers });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response;
}
assert.deepEqual(await (await get("/.well-known/celld/health")).json(), {
  ok: true,
});
const home = await (await get("/")).text();
assert.match(home, /<html/i);
for (const [path, contentType] of [
  ["/assets/landing.js", /javascript/],
  ["/review/app.js", /javascript/],
  ["/review/app.css", /text\/css/],
  ["/review/dashboard.js", /javascript/],
  ["/favicon.svg", /image\/svg\+xml/],
  ["/dashboard", /text\/html/],
]) {
  const response = await get(path);
  assert.match(response.headers.get("content-type") ?? "", contentType);
  assert.ok(Number(response.headers.get("content-length") ?? 1) > 0);
  assert.ok((await response.arrayBuffer()).byteLength > 0, `${path} is empty`);
}
const dashboard = await (await get("/api/dashboard")).json();
assert.ok(
  Array.isArray(dashboard.runs.rows),
  "ledger must return dashboard rows",
);
assert.ok(
  dashboard.collectionStartedAt > 0,
  "ledger schema must be initialized",
);
const badWebhook = await fetch(new URL("/webhook", base), {
  method: "POST",
  headers,
  body: "{}",
});
assert.equal(
  badWebhook.status,
  401,
  "webhook must reject an invalid signature",
);
const manualHeaders = new Headers(headers);
manualHeaders.set("content-type", "application/json");
manualHeaders.set("origin", base.origin);
const invalidManual = await fetch(new URL("/api/reviews", base), {
  method: "POST",
  headers: manualHeaders,
  body: "{}",
});
assert.equal(
  invalidManual.status,
  400,
  "the original site origin must reach validation",
);
manualHeaders.set("origin", "https://untrusted.example");
const crossSite = await fetch(new URL("/api/reviews", base), {
  method: "POST",
  headers: manualHeaders,
  body: "{}",
});
assert.equal(
  crossSite.status,
  403,
  "manual reviews must reject a different site origin",
);
console.log(
  "PASS health, landing, assets, review UI, dashboard, D1 ledger, webhook signature rejection",
);

if (process.env.PR_URL) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", base.origin);
  const response = await fetch(new URL("/api/reviews", base), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ url: process.env.PR_URL }),
  });
  assert.equal(response.status, 200, "manual review must start");
  const { url } = await response.json();
  const report = new URL(url, base);
  const viewPath = `/api${report.pathname}/${report.searchParams.get("sha")}`;
  console.log(`REPORT ${report.href}`);
  console.log(`VIEW ${viewPath}`);
  let view;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    view = await (await get(viewPath)).json();
    if (!["running", "scanning"].includes(view.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal(
    view?.status,
    "done",
    `review failed: ${view?.failure ?? view?.status}`,
  );
  assert.ok(view.review.verdict, "review must persist a verdict");
  console.log(
    JSON.stringify({
      status: view.status,
      decision: view.review.verdict.decision,
      model: view.review.model,
      activity: view.activity.length,
      costUsd: view.costUsd,
    }),
  );
}
