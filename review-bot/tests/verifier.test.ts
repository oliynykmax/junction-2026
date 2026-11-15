import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDoc } from "@earendil-works/pi-durable";
import {
  capturedFiles,
  EMPTY_REVIEW,
  ReviewDoc,
  type ReviewState,
  reviewerExtension,
} from "../src/reviewer";
import { VerifierLink } from "../src/verifier";
import type { CheckoutInput, ShellInput } from "../src/executor";

const ROOT = 1;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PATH = "src/cache.ts";

const finding = {
  id: "f1",
  path: PATH,
  line: 3,
  severity: "high" as const,
  class: "correctness" as const,
  confidence: "verified" as const,
  title: "Fallback read ignores the head commit",
  body: "readFallback keys by pull request only.",
  reason: "An old review shows on new code.",
  evidence: { kind: "code" as const, detail: "cache.ts:3" },
  fix: "Key by head too.",
  source: "agent" as const,
  suggestedPatch: null,
};

const receipt = (outcome: "passed" | "counterexample" | "not_run") => ({
  files: [PATH],
  target: "readFallback",
  property: "A read for head b never returns head a's review.",
  harm: "The owner trusts an old review.",
  method: "property test" as const,
  checker: "bun test 1.4",
  command: "bun test tests/verifier/fallback.test.ts",
  outcome,
  result: {
    passed: "1000 runs, no violation.",
    counterexample: "Failed: counterexample head a then b returned review a.",
    not_run: "Not run: the toolchain is unavailable.",
  }[outcome],
  scope: "Two heads.",
  ...(outcome === "passed" && {
    broken_variant: "Dropping head from the key fails the test.",
  }),
  assumptions: ["Heads are exact strings."],
  limits: ["No storage layer."],
});

const STAR = {
  situation: "Cached reviews were keyed by pull request alone.",
  task: "Scope cached reviews to the commit.",
  action: "Keys the cache by pull request and head.",
  result: "New pushes get fresh reviews; the PR adds one test.",
};

// An in-memory stand-in for the harness: documents keyed by kind and
// conversation, task-owned child conversations, and a submission whose wait
// runs the child's turn as a script.
function world(seed: Partial<ReviewState> = {}) {
  const docs = new Map<string, any>();
  const docOf = (token: any, id: number) => {
    const key = `${token.definition.kind}:${id}`;
    if (!docs.has(key)) docs.set(key, token.definition.initial?.() ?? {});
    return docs.get(key);
  };
  docs.set(`review.state:${ROOT}`, {
    ...structuredClone(EMPTY_REVIEW),
    target: {
      owner: "team",
      repo: "demo",
      number: 1,
      headSha: HEAD,
      installationId: 1,
      base: { owner: "team", repo: "demo", sha: BASE },
    },
    brief: {
      facts: {
        kind: "available",
        value: {
          title: "Scope cached reviews to the commit",
          author: "alex",
          baseRef: "main",
          body: "A new push must get a fresh review.",
        },
        omitted: 0,
      },
      commits: {
        kind: "available",
        value: [{ sha: "c", message: "Key the cache by head" }],
        omitted: 0,
      },
      comments: { kind: "available", value: [], omitted: 0 },
    },
    lookups: [{ tool: "docs", args: "{}", at: 1 }],
    files: capturedFiles([
      {
        filename: PATH,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-a\n+b",
      },
    ]),
    changes: [{ id: "c", title: "Key by head", tags: ["fix"], files: [PATH] }],
    findings: [finding],
    ...seed,
  });
  const children: { id: number; owner: number }[] = [];
  const checkouts: CheckoutInput[] = [];
  const shells: ShellInput[] = [];
  const submissions: unknown[] = [];
  const released: string[] = [];
  let script: (child: number) => Promise<"done" | "unanswered"> = async () =>
    "done";
  let shellRun = async (_input: ShellInput) => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  const { extension, verifier } = reviewerExtension({
    token: async () => "token",
    scan: async () => [],
    publish: async () => {},
    finished: () => {},
    checkout: async (input) => {
      checkouts.push(input);
      return { workspace: `/w/${input.session}`, commit: input.sha };
    },
    shell: async (input) => {
      shells.push(input);
      return shellRun(input);
    },
    release: async (session) => released.push(session),
  });
  let call = 0;
  const tx = {
    doc: async (token: any, id: number) => docOf(token, id),
    scanConversations: async (q: { ownerTaskId: number }) => ({
      items: children.filter((c) => c.owner === q.ownerTaskId),
    }),
    createConversation: async (o: { ownership: { taskId: number } }) => {
      const c = { id: 7 + children.length, owner: o.ownership.taskId };
      children.push(c);
      return c;
    },
  };
  const api = (conversationId: number, taskId = 100) => ({
    conversationId,
    taskId,
    callId: `call-${++call}`,
    snapshot: async (token: any, id: number) =>
      structuredClone(docOf(token, id)),
    commit: async (change: (t: typeof tx) => unknown) => change(tx),
    details: async () => {},
    conversation: async (id: number) => ({
      submit: async (request: unknown) => {
        submissions.push(request);
        return { wait: async () => ({ status: await script(id) }) };
      },
    }),
  });
  const tool = (ext: typeof extension, name: string) => {
    const t = ext.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  const reviewer = (name: string, args: object = {}, taskId?: number) =>
    (tool(extension, name).execute as any)(args, api(ROOT, taskId), {});
  const verify = (child: number, name: string, args: object = {}) =>
    (tool(verifier, name).execute as any)(args, api(child), {});
  const context = async (child: number) =>
    (await verifier.sections
      .find((s) => s.key === "verifier_context")!
      .render({ read: api(child), conversationId: child } as any, {} as any))!;
  return {
    state: () => docOf(ReviewDoc, ROOT) as ReviewState,
    docOf,
    extension,
    verifier,
    reviewer,
    verify,
    context,
    checkouts,
    shells,
    submissions,
    released,
    script: (s: typeof script) => (script = s),
    shellRun: (s: typeof shellRun) => (shellRun = s),
  };
}

const check = {
  requirement: "A new push must get a fresh review.",
  path: "tests/verifier/fresh.test.ts",
  content: "test('fresh', () => {});",
};

test("verify starts a child without the reviewer's tools and returns its verdicts", async () => {
  const w = world();
  w.script(async (child) => {
    await w.verify(child, "save_checks", { checks: [check] });
    await w.verify(child, "record_verification", receipt("counterexample"));
    const id = w.state().verifications!.at(-1)!.id;
    await w.verify(child, "finish_verification", {
      summary: "The blind check passes at the head.",
      verdicts: [
        {
          finding_id: "f1",
          verdict: "reproduced",
          receipt_id: id,
          note: "Returned review a.",
        },
      ],
    });
    return "done";
  });
  const result = await w.reviewer("verify");
  expect(result.isError).toBeUndefined();
  expect(result.output[0].text).toContain("reproduced. Returned review a.");
  expect(w.docOf(AgentDoc, 7).extensions).toEqual({ remove: ["reviewer"] });
  expect(w.docOf(VerifierLink, 7).root).toBe(ROOT);
  expect(w.submissions).toEqual([
    expect.objectContaining({ type: "input", requestId: "verify:100" }),
  ]);
  const verifier = w.state().verifier;
  expect(verifier?.status).toBe("done");
  expect(verifier?.status === "done" && verifier.verdicts.f1?.verdict).toBe(
    "reproduced",
  );
  expect(w.state().verifications![0].author).toBe("verifier");
  expect(w.released).toEqual(["7"]);
  expect(
    (
      await w.reviewer("finish_review", {
        ...STAR,
        summary: "s",
        not_checked: [],
      })
    ).isError,
  ).toBeUndefined();
  expect(w.state().verdict?.decision).toBe("changes_requested");
});

test("the reviewer records findings but no receipts, and findings close once verify starts", async () => {
  const w = world();
  const names = (ext: typeof w.extension) => ext.tools.map((t) => t.name);
  expect(names(w.extension)).toContain("verify");
  expect(names(w.extension)).not.toContain("record_verification");
  expect(names(w.verifier)).toContain("record_verification");
  expect(names(w.verifier)).not.toContain("report_finding");
  w.script(async () => "unanswered");
  await w.reviewer("verify");
  const late = await w.reviewer("report_finding", {
    ...finding,
    id: undefined,
  });
  expect(late.isError).toBe(true);
  expect(w.state().findings).toHaveLength(1);
});

test("the verifier checks out the base while blind, then the head with its saved checks restored", async () => {
  const scratch = await mkdtemp(join(import.meta.dir, ".verifier-"));
  try {
    const w = world();
    const workspace = join(scratch, "repo");
    w.shellRun(async ({ command }) => {
      const run = Bun.spawnSync([
        "bash",
        "-c",
        command.replaceAll("/w/7", workspace),
      ]);
      return {
        exitCode: run.exitCode,
        stdout: run.stdout.toString(),
        stderr: run.stderr.toString(),
        timedOut: false,
      };
    });
    w.script(async (child) => {
      await w.verify(child, "checkout");
      const unsafe = await w.verify(child, "save_checks", {
        checks: [{ ...check, path: "../outside.ts" }],
      });
      expect(unsafe.isError).toBe(true);
      await w.verify(child, "save_checks", {
        checks: [check, { ...check, path: PATH, content: "blind copy" }],
      });
      expect(
        (await w.verify(child, "save_checks", { checks: [] })).isError,
      ).toBe(true);
      await mkdir(join(workspace, "src"), { recursive: true });
      await writeFile(join(workspace, PATH), "head code");
      const head = await w.verify(child, "checkout");
      expect(head.output[0].text).toContain(`restored ${check.path}`);
      return "unanswered";
    });
    await w.reviewer("verify");
    expect(
      w.checkouts.map(({ sha, baseSha, session }) => ({
        sha,
        baseSha,
        session,
      })),
    ).toEqual([
      { sha: BASE, baseSha: undefined, session: "7" },
      { sha: HEAD, baseSha: BASE, session: "7" },
    ]);
    expect(await readFile(join(workspace, check.path), "utf8")).toBe(
      check.content,
    );
    expect(await readFile(join(workspace, PATH), "utf8")).toBe("head code");
    expect(await readFile(join(workspace, `${PATH}.blind-check`), "utf8")).toBe(
      "blind copy",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("verifier_context withholds the change and the findings until checks are saved", async () => {
  const w = world();
  w.script(async (child) => {
    const blind = await w.context(child);
    expect(blind).toContain("A new push must get a fresh review.");
    expect(blind).toContain("Key the cache by head");
    expect(blind).not.toContain(finding.title);
    expect(blind).not.toContain(PATH);
    await w.verify(child, "save_checks", { checks: [check] });
    const revealed = await w.context(child);
    expect(revealed).toContain(finding.title);
    expect(revealed).toContain("id f1");
    expect(revealed).toContain(PATH);
    return "unanswered";
  });
  await w.reviewer("verify");
});

test("finish_review refuses until a verifier finishes, and a failed verifier can be run again", async () => {
  const w = world();
  const finish = () =>
    w.reviewer("finish_review", { ...STAR, summary: "s", not_checked: [] });
  expect((await finish()).output[0].text).toContain("Call verify");
  w.script(async () => "unanswered");
  const failed = await w.reviewer("verify");
  expect(failed.isError).toBe(true);
  expect(w.state().verifier?.status).toBe("failed");
  expect((await finish()).isError).toBe(true);
  expect(w.state().verdict).toBeNull();
  w.script(async (child) => {
    await w.verify(child, "save_checks", { checks: [] });
    await w.verify(child, "record_verification", receipt("not_run"));
    await w.verify(child, "finish_verification", {
      summary: "No stated requirement could be checked.",
      verdicts: [
        {
          finding_id: "f1",
          verdict: "not_checked",
          note: "No runnable setup.",
        },
      ],
    });
    return "done";
  });
  expect((await w.reviewer("verify", {}, 101)).isError).toBeUndefined();
  expect(w.state().verifier?.conversationId).toBe(8);
  expect((await finish()).isError).toBeUndefined();
});

test("finish_verification needs every changed file covered and a verdict per finding backed by a matching receipt", async () => {
  const w = world();
  w.script(async (child) => {
    await w.verify(child, "save_checks", { checks: [check] });
    const finishWith = (verdicts: object[]) =>
      w.verify(child, "finish_verification", { summary: "s", verdicts });
    const uncovered = await finishWith([
      { finding_id: "f1", verdict: "not_checked", note: "n" },
    ]);
    expect(uncovered.output[0].text).toContain(`No receipt covers ${PATH}`);
    await w.verify(child, "record_verification", receipt("passed"));
    const passed = w.state().verifications!.at(-1)!.id;
    await w.verify(child, "record_verification", {
      ...receipt("counterexample"),
      files: [PATH],
    });
    const failed = w.state().verifications!.at(-1)!.id;
    for (const [verdicts, problem] of [
      [[], "Missing: f1"],
      [
        [
          {
            finding_id: "f1",
            verdict: "reproduced",
            receipt_id: passed,
            note: "n",
          },
        ],
        "needs a counterexample receipt",
      ],
      [
        [
          {
            finding_id: "f1",
            verdict: "not_reproduced",
            receipt_id: failed,
            note: "n",
          },
        ],
        "needs a passed receipt",
      ],
      [
        [
          {
            finding_id: "f1",
            verdict: "not_checked",
            receipt_id: passed,
            note: "n",
          },
        ],
        "links no receipt",
      ],
      [
        [{ finding_id: "f1", verdict: "not_reproduced", note: "n" }],
        "needs the receipt_id",
      ],
    ] as const) {
      const res = await finishWith([...verdicts]);
      expect(res.isError).toBe(true);
      expect(res.output[0].text).toContain(problem);
      expect(w.state().verifier?.status).toBe("verifying");
    }
    const ok = await finishWith([
      {
        finding_id: "f1",
        verdict: "not_reproduced",
        receipt_id: passed,
        note: "1000 runs pass.",
      },
    ]);
    expect(ok.control.terminate).toBe(true);
    return "done";
  });
  await w.reviewer("verify");
  const v = w.state().verifier;
  expect(v?.status === "done" && v.verdicts.f1).toEqual({
    verdict: "not_reproduced",
    receiptId: expect.any(String),
    note: "1000 runs pass.",
  });
});

test("one receipt cannot back the verdicts of two findings", async () => {
  const w = world({
    findings: [
      finding,
      { ...finding, id: "f2", title: "Eviction drops entry" },
    ],
  });
  w.script(async (child) => {
    await w.verify(child, "save_checks", { checks: [check] });
    await w.verify(child, "record_verification", receipt("passed"));
    const passed = w.state().verifications!.at(-1)!.id;
    const res = await w.verify(child, "finish_verification", {
      summary: "s",
      verdicts: ["f1", "f2"].map((id) => ({
        finding_id: id,
        verdict: "not_reproduced",
        receipt_id: passed,
        note: "n",
      })),
    });
    expect(res.isError).toBe(true);
    expect(res.output[0].text).toContain(`Receipt ${passed} already backs f1`);
    return "unanswered";
  });
  await w.reviewer("verify");
});
