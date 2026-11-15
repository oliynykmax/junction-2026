import { afterEach, expect, spyOn, test } from "bun:test";
import { dismissBotApprovals, publishReview } from "../src/github";
import type { Severity } from "../src/findings";
import type { Finding } from "../src/reviewer";
import { findingMarker, fingerprint } from "../src/hive";

const pr = { owner: "team", repo: "demo", number: 1, headSha: "a".repeat(40) };
const report = `https://review.example/r/team/demo/1?sha=${pr.headSha}`;
const marker = "<!-- earned-trust-review-approval -->";
const footer = `[Full report](${report}) · A named human owns the merge; this review is advice, never an approval.`;
type Review = { id: number; state: string; commit_id: string; body: string };

const reviewWrites = (writes: { path: string }[]) =>
  writes.filter((w) => w.path.endsWith("/reviews"));

let n = 0;
function finding(f: Partial<Finding> = {}): Finding {
  n++;
  return {
    id: `f${n}`,
    path: "src/a.ts",
    line: null,
    severity: "low",
    class: "correctness",
    confidence: "verified",
    title: `Finding ${n}`,
    body: "Body.",
    source: "agent",
    suggestedPatch: null,
    ...f,
  };
}

function github(
  head = pr.headSha,
  reviews: Review[] = [],
  labels: string[] = [],
  comments: { user: { login: string }; body: string }[] = [],
  refuseInline = false,
  failLookup = false,
) {
  const writes: { path: string; body: unknown }[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    if (path.startsWith("/repos/team/demo/issues/1/labels")) {
      if (!init?.method || init.method === "GET")
        return Response.json(labels.map((name) => ({ name })));
      writes.push({
        path: `${init.method} ${path}`,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({});
    }
    if (path === "/repos/team/demo/labels") {
      writes.push({
        path: `POST ${path}`,
        body: JSON.parse(String(init!.body)),
      });
      return Response.json({});
    }
    if (!path.startsWith("/repos/team/demo/pulls/1"))
      throw new Error(`Unexpected GitHub path ${path}`);
    if (path.startsWith("/repos/team/demo/pulls/1/comments?")) {
      if (failLookup) throw new Error("GitHub lookup unavailable");
      return Response.json(comments);
    }
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (refuseInline && body.comments)
        return new Response("Unprocessable", { status: 422 });
      writes.push({ path, body });
      if (init.method === "POST")
        reviews.push({
          id: reviews.length + 1,
          state: body.event === "APPROVE" ? "APPROVED" : "COMMENTED",
          commit_id: body.commit_id,
          body: body.body,
        });
      return Response.json({});
    }
    const page = path.match(/\/reviews\?per_page=100&page=(\d+)$/);
    if (page) {
      const start = (Number(page[1]) - 1) * 100;
      return Response.json(reviews.slice(start, start + 100));
    }
    if (path === "/repos/team/demo/pulls/1")
      return Response.json({ head: { sha: head } });
    throw new Error(`Unexpected GitHub request ${path}`);
  });
  return writes;
}

afterEach(() => {
  globalThis.fetch.mockRestore();
});

for (const { severities, summary, event } of [
  { severities: [], summary: "0 findings", event: "COMMENT" },
  { severities: ["low"], summary: "1 finding · 1 low", event: "COMMENT" },
  {
    severities: ["low", "medium"],
    summary: "2 findings · 1 medium · 1 low",
    event: "COMMENT",
  },
  {
    severities: ["info", "low", "high", "critical", "medium", "medium"],
    summary: "6 findings · 1 critical · 1 high · 2 medium · 1 low · 1 info",
    event: "COMMENT",
  },
] satisfies { severities: Severity[]; summary: string; event: string }[]) {
  test(`publishes ${summary} as ${event}`, async () => {
    const writes = github();
    await publishReview(
      "token",
      pr,
      severities.map((severity) => finding({ severity })),
      [],
      report,
    );
    expect(writes).toEqual([
      {
        path: "/repos/team/demo/pulls/1/reviews",
        body: {
          commit_id: pr.headSha,
          event,
          body: expect.stringContaining(`**${summary}**`),
        },
      },
    ]);
    const body = (writes[0].body as { body: string }).body;
    expect(body.startsWith(`${marker}\n`)).toBe(true);
    expect(body.endsWith(footer)).toBe(true);
  });
}

test("never approves, even a clean review", async () => {
  const writes = github();
  await publishReview("token", pr, [], [], report, "low");
  expect(
    reviewWrites(writes).map((w) => (w.body as { event: string }).event),
  ).toEqual(["COMMENT"]);
});

test("states the risk tier and its review depth", async () => {
  const writes = github();
  await publishReview(
    "token",
    pr,
    [finding({ severity: "low" })],
    [],
    report,
    "high",
  );
  expect((reviewWrites(writes)[0].body as { body: string }).body).toContain(
    "Risk tier: **high**. Read the flagged files in full",
  );
});

for (const tier of ["low", "medium", "high"] as const) {
  test(`labels the PR risk: ${tier}`, async () => {
    const writes = github();
    await publishReview("token", pr, [], [], report, tier);
    expect(writes.map((w) => w.path)).toEqual([
      "POST /repos/team/demo/labels",
      "POST /repos/team/demo/issues/1/labels",
      "/repos/team/demo/pulls/1/reviews",
    ]);
    expect(writes[1].body).toEqual({ labels: [`risk: ${tier}`] });
  });
}

test("replaces a stale risk label and leaves other labels alone", async () => {
  const writes = github(pr.headSha, [], ["risk: low", "bug", "risk: high"]);
  await publishReview("token", pr, [], [], report, "high");
  expect(writes.map((w) => w.path)).toEqual([
    "DELETE /repos/team/demo/issues/1/labels/risk%3A%20low",
    "/repos/team/demo/pulls/1/reviews",
  ]);
});

test("does not touch labels without a risk tier or on a stale head", async () => {
  const writes = github();
  await publishReview("token", pr, [], [], report);
  expect(writes.map((w) => w.path)).toEqual([
    "/repos/team/demo/pulls/1/reviews",
  ]);
  const stale = github("b".repeat(40));
  await publishReview("token", pr, [], [], report, "high");
  expect(stale).toEqual([]);
});

test("a failed label does not block the review", async () => {
  const writes = github();
  const fetchMock = globalThis.fetch as unknown as {
    getMockImplementation(): typeof fetch;
    mockImplementation(fn: typeof fetch): void;
  };
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).includes("/issues/1/labels"))
      return new Response("forbidden", { status: 403 });
    return original(input, init);
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  await publishReview("token", pr, [], [], report, "high");
  log.mockRestore();
  expect(reviewWrites(writes)).toHaveLength(1);
});

test("skips a stale head", async () => {
  const writes = github("b".repeat(40));
  await publishReview(
    "token",
    pr,
    [finding({ severity: "medium" })],
    [],
    report,
  );
  expect(writes).toEqual([]);
});

for (const findings of [[], [finding({ severity: "medium" })]]) {
  test(`retry skips an existing review with ${findings.length} findings`, async () => {
    const writes = github();
    await publishReview("token", pr, findings, [], report);
    await publishReview("token", pr, findings, [], report);
    expect(writes).toHaveLength(1);
  });
}

test("ignores unrelated reviews and reviews of older commits", async () => {
  const writes = github(pr.headSha, [
    { id: 1, state: "COMMENTED", commit_id: pr.headSha, body: "Human review" },
    { id: 2, state: "COMMENTED", commit_id: "old", body: marker },
  ]);
  await publishReview("token", pr, [finding({ severity: "high" })], [], report);
  expect(writes).toHaveLength(1);
});

test("keeps legacy marked approval deduplication", async () => {
  const writes = github(pr.headSha, [
    {
      id: 1,
      state: "APPROVED",
      commit_id: pr.headSha,
      body: `${marker}\nOld approval`,
    },
  ]);
  await publishReview("token", pr, [], [], report);
  expect(writes).toEqual([]);
});

test("dismisses every bot approval, including the head's, and no human's", async () => {
  const writes = github(pr.headSha, [
    { id: 1, state: "APPROVED", commit_id: "old", body: marker },
    { id: 2, state: "COMMENTED", commit_id: "old", body: marker },
    { id: 3, state: "APPROVED", commit_id: pr.headSha, body: marker },
    { id: 4, state: "APPROVED", commit_id: "old", body: "Human approval" },
  ]);
  await dismissBotApprovals("token", pr);
  expect(writes.map((write) => write.path)).toEqual([
    "/repos/team/demo/pulls/1/reviews/1/dismissals",
    "/repos/team/demo/pulls/1/reviews/3/dismissals",
  ]);
});

test("dismisses a bot approval past the first page of reviews", async () => {
  const humans: Review[] = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    state: "COMMENTED",
    commit_id: "old",
    body: "Human review",
  }));
  const writes = github(pr.headSha, [
    ...humans,
    { id: 101, state: "APPROVED", commit_id: pr.headSha, body: marker },
  ]);
  await dismissBotApprovals("token", pr);
  expect(writes.map((write) => write.path)).toEqual([
    "/repos/team/demo/pulls/1/reviews/101/dismissals",
  ]);
});

const patch = "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n e";
const files = [{ path: "src/a.ts", patch }];

test("posts a finding on a changed line as an inline comment", async () => {
  const writes = github();
  const f = finding({ severity: "high", line: 3, title: "Off by one" });
  await publishReview("token", pr, [f], files, report);
  const body = reviewWrites(writes)[0].body as {
    body: string;
    comments: { path: string; line: number; side: string; body: string }[];
  };
  expect(body.comments).toHaveLength(1);
  expect(body.comments[0]).toMatchObject({
    path: "src/a.ts",
    line: 3,
    side: "RIGHT",
  });
  expect(body.comments[0].body).toContain(findingMarker(await fingerprint(f)));
  expect(body.comments[0].body).toContain(
    "_🟠 High_ | _correctness_ | _✅ Verified_ | _🐝 Blocks merge_",
  );
  expect(body.comments[0].body).toContain("**Off by one**");
  expect(body.body).toContain("Inline comments posted: 1");
  expect(body.body).toContain("stinger out: 1 blocking finding");
});

test("lists a finding off the diff in the summary instead", async () => {
  const writes = github();
  await publishReview(
    "token",
    pr,
    [finding({ line: 9, title: "Far away" })],
    files,
    report,
  );
  const body = reviewWrites(writes)[0].body as {
    body: string;
    comments?: unknown;
  };
  expect(body.comments).toBeUndefined();
  expect(body.body).toContain("📍 Outside the diff (1)");
  expect(body.body).toContain("`src/a.ts:9` 🔵 Low: Far away");
  expect(body.body).toContain("no blockers found");
});

test("does not repeat a finding an earlier inline comment raised", async () => {
  const f = finding({ line: 3, title: "Same thing" });
  const writes = github(
    pr.headSha,
    [],
    [],
    [
      {
        user: { login: "bumble-bot-review[bot]" },
        body: `${findingMarker(await fingerprint(f))}\nold`,
      },
    ],
  );
  await publishReview("token", pr, [{ ...f, id: "new-run" }], files, report);
  const body = reviewWrites(writes)[0].body as {
    body: string;
    comments?: unknown;
  };
  expect(body.comments).toBeUndefined();
  expect(body.body).toContain("♻️ Raised in an earlier thread (1)");
});

test("ignores a look-alike marker from someone other than the bot", async () => {
  const f = finding({ line: 3, title: "Same thing" });
  const writes = github(
    pr.headSha,
    [],
    [],
    [{ user: { login: "mallory" }, body: findingMarker(await fingerprint(f)) }],
  );
  await publishReview("token", pr, [f], files, report);
  expect(
    (reviewWrites(writes)[0].body as { comments: unknown[] }).comments,
  ).toHaveLength(1);
});

test("falls back to a summary-only review when GitHub refuses an anchor", async () => {
  const writes = github(pr.headSha, [], [], [], true);
  const log = spyOn(console, "error").mockImplementation(() => {});
  await publishReview(
    "token",
    pr,
    [finding({ line: 3, title: "Anchored" })],
    files,
    report,
  );
  log.mockRestore();
  const sent = reviewWrites(writes);
  expect(sent).toHaveLength(1);
  const body = sent[0].body as { body: string; comments?: unknown };
  expect(body.comments).toBeUndefined();
  expect(body.body).toContain("`src/a.ts:3` 🔵 Low: Anchored");
});

for (const line of [3, 9]) {
  test(`posts the review when inline dedupe lookup rejects, line ${line}`, async () => {
    const writes = github(pr.headSha, [], [], [], false, true);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await publishReview(
        "token",
        pr,
        [finding({ line, title: "Still reported" })],
        files,
        report,
      );
      const sent = reviewWrites(writes);
      expect(sent).toHaveLength(1);
      const body = sent[0].body as {
        body: string;
        comments?: { body: string }[];
      };
      expect(body.body).toContain("1 finding");
      expect(line === 3 ? body.comments?.[0].body : body.body).toContain(
        "Still reported",
      );
    } finally {
      log.mockRestore();
    }
  });
}
