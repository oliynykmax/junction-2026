import { afterEach, expect, spyOn, test } from "bun:test";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { EvidencePanel } from "../web/evidence";
import {
  capCodemodeOutput,
  EMPTY_REVIEW,
  MAX_CODEMODE_OUTPUT_TOKENS,
  readBudget,
  reviewerExtension,
} from "../src/reviewer";
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
  const checkouts = [];
  const shells = [];
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
    checkout: async (args) => {
      checkouts.push(args);
      return {
        workspace: "/tmp/review/repo",
        commit: args.sha,
        ...(args.baseSha && { base: args.baseSha }),
      };
    },
    shell: async (args) => {
      shells.push(args);
      return { exitCode: 17, stdout: "out", stderr: "err", timedOut: false };
    },
  });
  return {
    state,
    runtime,
    api,
    reviewer,
    publications,
    submissions,
    checkouts,
    shells,
  };
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
  const brief = await reviewer.extension.sections
    .find((s) => s.key === "review_brief")
    .render({ read: runtime, conversationId: "test" }, {});
  expect(brief).toContain(`head ${target.headSha}`);
  expect(brief).toContain("could not be read when the review started");
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

test("checkout_pr and shell expose the pinned writable workspace without returning its token", async () => {
  const { reviewer, api, checkouts, shells } = review();
  const checkout = reviewer.extension.tools.find((t) => t.name === "checkout_pr");
  const shell = reviewer.extension.tools.find((t) => t.name === "shell");
  const checkedOut = await checkout.execute({}, api, {});
  expect(checkouts).toEqual([
    {
      session: "test",
      owner: target.owner,
      repo: target.repo,
      sha: target.headSha,
      baseSha: target.base.sha,
      githubToken: "token",
    },
  ]);
  expect(checkedOut.output[0].text).toContain("/tmp/review/repo");
  expect(checkedOut.output[0].text).toContain(`Fetched base ${target.base.sha}`);
  expect(checkedOut.output[0].text).not.toContain("token");
  const ran = await shell.execute(
    { command: "go test ./...", cwd: "pkg", timeout_ms: 1234 },
    api,
    {},
  );
  expect(shells).toEqual([
    {
      session: "test",
      command: "go test ./...",
      cwd: "pkg",
      timeoutMs: 1234,
    },
  ]);
  expect(ran.output[0].text).toBe("exit 17\nstdout:\nout\nstderr:\nerr");
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

test("manual evidence uses authenticated reads and never publishes to GitHub", async () => {
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
    expect(init.headers.authorization).toBe("Bearer token");
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

test("codemode output budget is capped on the options line and left alone otherwise", () => {
  const script =
    'const out = await tools.read_file({ path: "a" });\ntext(out);';
  expect(capCodemodeOutput(script)).toBe(script);
  const small = `// @options: {"max_output_tokens": 2000}\n${script}`;
  expect(capCodemodeOutput(small)).toBe(small);
  const capped = capCodemodeOutput(
    `// @options: {"max_output_tokens": 40000, "timeout_ms": 60000}\n${script}`,
  );
  const [line, ...rest] = capped.split("\n");
  expect(JSON.parse(line.slice("// @options:".length))).toEqual({
    max_output_tokens: MAX_CODEMODE_OUTPUT_TOKENS,
    timeout_ms: 60000,
  });
  expect(rest.join("\n")).toBe(script);
  const indented = capCodemodeOutput(
    ` \t// @options: {"max_output_tokens": 40000}\n${script}`,
  );
  expect(indented).toBe(
    `// @options: {"max_output_tokens":${MAX_CODEMODE_OUTPUT_TOKENS}}\n${script}`,
  );
  const invalid = `// @options: {oops\n${script}`;
  expect(capCodemodeOutput(invalid)).toBe(invalid);
});

test("the codemode wrap passes the capped script to the tool", async () => {
  const { reviewer } = review();
  const wrap = reviewer.extension.wraps.find((w) => w.tool === "codemode");
  const seen = [];
  const tool = wrap.wrap({
    name: "codemode",
    execute: async (args) => (seen.push(args.code), { output: [] }),
  });
  await tool.execute(
    { code: '// @options: {"max_output_tokens": 35000}\ntext(1);' },
    {},
    {},
  );
  expect(seen).toEqual([
    `// @options: {"max_output_tokens":${MAX_CODEMODE_OUTPUT_TOKENS}}\ntext(1);`,
  ]);
});

test("read_file and list_dir share a read budget that grows with the PR", async () => {
  const { state, reviewer, api } = review();
  state.files = [
    { path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "" },
    { path: "b.ts", status: "added", additions: 1, deletions: 0, patch: "" },
  ];
  const budget = readBudget(2);
  let fetches = 0;
  spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    fetches++;
    return String(input).includes("/contents/src?")
      ? Response.json([{ name: "a.ts", type: "file" }])
      : new Response("content");
  });
  const read = reviewer.extension.tools.find((t) => t.name === "read_file");
  const list = reviewer.extension.tools.find((t) => t.name === "list_dir");
  for (let i = 0; i < budget - 1; i++)
    await read.execute({ path: "a.ts" }, api, {});
  await list.execute({ path: "src" }, api, {});
  expect(state.reads).toBe(budget);
  expect(fetches).toBe(budget);
  await expect(read.execute({ path: "a.ts" }, api, {})).rejects.toThrow(
    /Read budget spent/,
  );
  await expect(list.execute({ path: "src" }, api, {})).rejects.toThrow(
    /Read budget spent/,
  );
  expect(fetches).toBe(budget);
  expect(state.reads).toBe(budget);
});
