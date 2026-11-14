import { afterEach, expect, spyOn, test } from "bun:test";
import vm from "node:vm";
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
    commit: async (change) => change({ doc: async () => state }),
    conversation: async () => ({
      submit: async (_tx, input) => submissions.push(input),
    }),
  };
  const api = { ...runtime, read: runtime };
  const reviewer = reviewerExtension({
    token: async () => "token",
    scan: async () => [],
    publish: async (...args) => publications.push(args),
  });
  return { state, runtime, api, reviewer, publications, submissions };
}

test("scan replay reuses persisted evidence; prompt, coverage and publication consume it", async () => {
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
    if (url.pathname.endsWith("code-standard.md"))
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
    { summary: "No code findings", not_checked: [] },
    api,
    {},
  );
  expect(state.verdict.notChecked.join(" ")).toContain(
    "Check runs unavailable",
  );
  expect(state.verdict.notChecked.join(" ")).toContain("No code-standard.md");
  expect(publications[0][3]).toEqual(evidence);
});

test("read_file base uses pinned repository and commit without looking up current PR", async () => {
  const { reviewer, api } = review();
  const urls = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(String(input));
    return new Response("base content");
  });
  const read = reviewer.extension.tools.find((t) => t.name === "read_file");
  await read.execute({ path: "code-standard.md", ref: "base" }, api, {});
  expect(urls).toEqual([
    `https://api.github.com/repos/team/demo/contents/code-standard.md?ref=${target.base.sha}`,
  ]);
});

test("older review without evidence gains explicit coverage gap and publishes no evidence", async () => {
  const { state, reviewer, api, publications } = review();
  delete state.evidence;
  const finish = reviewer.extension.tools.find(
    (t) => t.name === "finish_review",
  );
  await finish.execute({ summary: "Legacy review", not_checked: [] }, api, {});
  expect(state.verdict.notChecked.join(" ")).toContain(
    "No CI or team standard evidence",
  );
  expect(publications[0][3]).toBeNull();
});

test("report shell script renders API evidence and legacy fallback", async () => {
  const response = reviewPage(
    "/api/test",
    "https://github.com/team/demo/pull/1",
    "team/demo#1",
  );
  const html = await response.text();
  expect(html).toContain('id="evidence"');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", className: "" });
      return elements.get(id);
    },
  };
  const { state } = review();
  const view = {
    status: "done",
    review: state,
    activity: [],
    costUsd: 0,
    heldBack: 0,
    evidenceHtml: "<p>Observed CI: pending</p>",
  };
  vm.runInNewContext(script, {
    document,
    fetch: async () => Response.json(view),
    setTimeout() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(elements.get("evidence").innerHTML).toBe(view.evidenceHtml);
  delete view.evidenceHtml;
  vm.runInNewContext(script, {
    document,
    fetch: async () => Response.json(view),
    setTimeout() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(elements.get("evidence").innerHTML).toContain("No evidence snapshot");
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
    if (url.pathname.endsWith("code-standard.md"))
      return Response.json({}, { status: 404 });
    throw new Error("Unexpected request");
  });
  await reviewer.scanTask.definition.phases.scan(null, runtime, {});
  expect(state.evidence.base.sha).toBe(target.base.sha);
  const finish = reviewer.extension.tools.find(
    (t) => t.name === "finish_review",
  );
  await finish.execute(
    { summary: "Read-only report", not_checked: [] },
    api,
    {},
  );
  expect(publications).toEqual([]);
  expect(calls.some((u) => u.pathname.endsWith("code-standard.md"))).toBe(true);
});
