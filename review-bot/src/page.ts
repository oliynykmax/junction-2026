// The review page shell. The page itself is the Preact client in web/, built
// to dist/review/ and served as static assets; this shell hands it the
// review's API path and PR identity.

export type PageTarget = {
  /** A manual review started from the landing page (/m/), not a webhook one. */
  manual: boolean;
  owner: string;
  repo: string;
  number: string;
  headSha: string;
};

export function reviewPage(t: PageTarget): Response {
  const label = `${t.owner}/${t.repo}#${t.number}`;
  const config = {
    api: `/api/${t.manual ? "m" : "r"}/${t.owner}/${t.repo}/${t.number}/${t.headSha}`,
    // Manual reviews poll every 15 s, webhook reviews every 2 s.
    pollMs: t.manual ? 15000 : 2000,
    prUrl: `https://github.com/${t.owner}/${t.repo}/pull/${t.number}`,
    owner: t.owner,
    repo: t.repo,
    number: t.number,
  };
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  // "<" escaped so the JSON cannot close the script element.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bumble Bot review of ${esc(label)}</title>
<link rel="icon" href="/favicon.svg?v=bumble-bot" type="image/svg+xml">
<link rel="icon" href="/favicon.ico?v=bumble-bot" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=bumble-bot">
<script>try{var s=localStorage.getItem("bumble-color-scheme");if(s==="light"||s==="dark")document.documentElement.setAttribute("data-color-scheme",s)}catch(_){}</script>
<link rel="stylesheet" href="/review/app.css">
<script type="module" src="/review/app.js"></script>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="config">${json}</script>
<noscript>This page needs JavaScript to show the review.</noscript>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
