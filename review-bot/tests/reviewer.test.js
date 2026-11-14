import { afterEach, expect, spyOn, test } from "bun:test";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { EvidencePanel } from "../web/evidence";
import { EMPTY_REVIEW, reviewerExtension } from "../src/reviewer";
import { evidenceHtml } from "../src/evidence";
import { reviewPage } from "../src/page";

const target = {
  owner: "team",
  repo: "demo",
  number: 1,
  headSha: "a".repeat(40),
  installationId: 1,
  base: { owner: "team", repo: "demo", sha: "b".repeat(40) },
};
afterEach(() => {
  if (globalThis.fetch.mockRestore) globalThis.fetch.mockRestore();
});

// Like pi-durable, documents read in a commit are unusable once it settles.
function review() {
  const state = {
    ...structuredClone(EMPTY_REVIEW),
    target,
    lookups: [{ tool: "docs", args: "{}", at: 1 }],
  };
  const publications = [];
  const submissions = [];
  const runtime = {
    conversationId: "test",
    snapshot: async () => structuredClone(state),
    commit: async (change) => {
      const proxies = [];
      const wrap = (value) => {
        if (value === null || typeof value !== "object") return value;
        const p = Proxy.revocable(value, {
          get: (o, k) => wrap(Reflect.get(o, k)),
        });
        proxies.push(p);
        return p.proxy;
      };
      try {
        return await change({ doc: async () => wrap(state) });
      } finally {
        for (const p of proxies) p.revoke();
      }
    },
    conversation: async () => ({
      submit: async (_tx, input) => submissions.push(input),
    }),
  };
  const api = { ...runtime, read: runtime };
  const reviewer = reviewerExtension({
    token: async () => "token",
    scan: async () => [],
    publish: async (...args) => publications.push(args),
    finished: () => {},
  });
  return { state, runtime, api, reviewer, publications, submissions };
}

const STAR = {
  situation: "The demo service had no retry on transient errors.",
  task: "Retry transient failures once.",
  action: "Wraps the client call in a single retry.",
  result: "Callers see fewer transient failures; the PR adds no tests.",
};
test("scan replay reuses persisted evidence; prompt and coverage consume it; publication carries the risk tier", async () => {
  let ciReads = 0;
  spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/compare/")) return Response.json({ files: [] });
    if (url.pathname.endsWith("/files")) return Response.json([]);
    if (url.pathname.endsWith("/check-runs")) {
      ciReads++;
      return Response.json({}, { status: 403 });
    }
    if (url.pathname.endsWith("/statuses")) {
      ciReads++;
      return Response.json([]);
    }
    if (url.pathname.includes("/git/commits/"))
      return Response.json({ sha: target.base.sha });
    if (url.pathname.endsWith("CODING_STANDARDS.md"))
      return Response.json({}, { status: 404 });
    throw new Error(`Unexpected request ${url}`);
  });
  const { state, runtime, api, reviewer, publications, submissions } = review();
  await reviewer.scanTask.definition.phases.scan(null, runtime, {});
  const evidence = structuredClone(state.evidence);
  expect(submissions).toHaveLength(1);
  expect(state.scan.status).toBe("skipped");
  await reviewer.scanTask.definition.phases.scan(null, runtime, {});
  expect(ciReads).toBe(2);
  expect(state.evidence).toEqual(evidence);
  const section = reviewer.extension.sections.find(
    (s) => s.key === "review_evidence",
  );
  const prompt = await section.render(
    { read: runtime, conversationId: "test" },
    {},
  );
  expect(prompt).toContain(target.headSha);
  expect(prompt).toContain('"kind":"absent"');
  expect(evidenceHtml(state.evidence)).toContain(target.headSha);
  const finish = reviewer.extension.tools.find(
    (t) => t.name === "finish_review",
  );
  await finish.execute(
    { ...STAR, summary: "No code findings", not_checked: [] },
    api,
    {},
  );
  expect(state.verdict.notChecked.join(" ")).toContain(
    "Check runs unavailable",
  );
  expect(state.verdict.notChecked.join(" ")).toContain(
    "No CODING_STANDARDS.md",
  );
  expect(publications[0][3]).toBe(state.risk.tier);
});

test("read_file base uses pinned repository and commit without looking up current PR", async () => {
  const { reviewer, api } = review();
  const urls = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(String(input));
    return new Response("base content");
  });
  const read = reviewer.extension.tools.find((t) => t.name === "read_file");
  await read.execute({ path: "CODING_STANDARDS.md", ref: "base" }, api, {});
  expect(urls).toEqual([
    `https://api.github.com/repos/team/demo/contents/CODING_STANDARDS.md?ref=${target.base.sha}`,
  ]);
});

test("older review without evidence or risk gains explicit coverage gap and publishes no tier", async () => {
  const { state, reviewer, api, publications } = review();
  delete state.evidence;
  delete state.risk;
  const finish = reviewer.extension.tools.find(
    (t) => t.name === "finish_review",
  );
  await finish.execute(
    { ...STAR, summary: "Legacy review", not_checked: [] },
    api,
    {},
  );
  expect(state.verdict.notChecked.join(" ")).toContain(
    "No CI or team standard evidence",
  );
  expect(publications[0][3]).toBeUndefined();
});

test("report shell loads the Preact client with pinned API configuration", async () => {
  const response = reviewPage({
    manual: false,
    owner: "team",
    repo: "demo",
    number: "1",
    headSha: target.headSha,
  });
  const html = await response.text();
  expect(html).toContain('src="/review/app.js"');
  expect(html).toContain('href="/favicon.svg?v=bumble-bot"');
  const config = JSON.parse(
    html.match(
      /<script type="application\/json" id="config">([\s\S]*?)<\/script>/,
    )[1],
  );
  expect(config.api).toBe(`/api/r/team/demo/1/${target.headSha}`);
});

test("Preact evidence panel renders the persisted snapshot and legacy fallback", () => {
  const { state } = review();
  const snapshot = {
    headSha: target.headSha,
    base: target.base,
    capturedAt: 1,
    checks: { kind: "available", items: [] },
    statuses: { kind: "available", items: [] },
    standard: {
      kind: "available",
      blobSha: "c".repeat(40),
      sha256: "digest",
      text: "</pre><script>bad()</script>",
      url: `https://github.com/team/demo/blob/${target.base.sha}/CODING_STANDARDS.md`,
    },
  };
  state.evidence = snapshot;
  const html = renderToString(
    h(EvidencePanel, { html: evidenceHtml(state.evidence) }),
  );
  expect(html).toContain("CI and team standard evidence");
  expect(html).toContain(target.headSha);
  expect(html).toContain(target.base.sha);
  expect(html).toContain("Observed CI:");
  expect(html).toContain("&#60;script&#62;");
  expect(html).not.toContain("<script>");
  expect(renderToString(h(EvidencePanel, {}))).toContain(
    "No evidence snapshot",
  );
});

test("manual evidence uses anonymous reads and never publishes to GitHub", async () => {
  const { state, reviewer, api, runtime, publications } = review();
  state.target = {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    headSha: target.headSha,
    baseSha: target.base.sha,
    mode: "manual",
  };
  const calls = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init.headers.authorization).toBeUndefined();
    expect(init.method).toBe("GET");
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.includes("/compare/")) return Response.json({ files: [] });
    if (url.pathname.endsWith("/files")) return Response.json([]);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ check_runs: [] });
    if (url.pathname.endsWith("/statuses")) return Response.json([]);
    if (url.pathname.includes("/git/commits/"))
      return Response.json({ sha: target.base.sha });
    if (url.pathname.endsWith("CODING_STANDARDS.md"))
      return Response.json({}, { status: 404 });
    throw new Error("Unexpected request");
  });
  await reviewer.scanTask.definition.phases.scan(null, runtime, {});
  expect(state.evidence.base.sha).toBe(target.base.sha);
  const finish = reviewer.extension.tools.find(
    (t) => t.name === "finish_review",
  );
  await finish.execute(
    { ...STAR, summary: "Read-only report", not_checked: [] },
    api,
    {},
  );
  expect(publications).toEqual([]);
  expect(calls.some((u) => u.pathname.endsWith("CODING_STANDARDS.md"))).toBe(
    true,
  );
});
