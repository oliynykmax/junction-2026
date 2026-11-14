import { afterEach, expect, spyOn, test } from "bun:test";
import { dismissStaleApprovals, publishReview } from "../src/github";
import type { Severity } from "../src/findings";
import type { Evidence } from "../src/evidence";

const pr = { owner: "team", repo: "demo", number: 1, headSha: "a".repeat(40) };
const report = `https://review.example/r/team/demo/1?sha=${pr.headSha}`;
const evidence: Evidence = {
  headSha: pr.headSha,
  base: { owner: pr.owner, repo: pr.repo, sha: "b".repeat(40) },
  capturedAt: 1,
  checks: {
    kind: "available",
    items: [
      { id: 1, name: "tests", state: "success", detail: "success", url: null },
    ],
  },
  statuses: { kind: "available", items: [] },
  standard: { kind: "absent" },
};
const marker = "<!-- earned-trust-review-approval -->";
type Review = { id: number; state: string; commit_id: string; body: string };

function github(head = pr.headSha, reviews: Review[] = []) {
  const writes: { path: string; body: unknown }[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    if (!path.startsWith("/repos/team/demo/pulls/1"))
      throw new Error(`Unexpected GitHub path ${path}`);
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
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
    if (path.endsWith("/reviews?per_page=100")) return Response.json(reviews);
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
  { severities: [], summary: "0 findings", event: "APPROVE" },
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
      severities.map((severity) => ({ severity })),
      report,
      evidence,
    );
    expect(writes).toEqual([
      {
        path: "/repos/team/demo/pulls/1/reviews",
        body: {
          commit_id: pr.headSha,
          event,
          body: `${marker}\n${summary}\n\n[Full report](${report})`,
        },
      },
    ]);
  });
}

test("skips a stale head", async () => {
  const writes = github("b".repeat(40));
  await publishReview("token", pr, [{ severity: "medium" }], report, evidence);
  expect(writes).toEqual([]);
});

for (const findings of [[], [{ severity: "medium" }]] satisfies {
  severity: Severity;
}[][]) {
  test(`retry skips an existing ${findings.length ? "comment review" : "approval"}`, async () => {
    const writes = github();
    await publishReview("token", pr, findings, report, evidence);
    await publishReview("token", pr, findings, report, evidence);
    expect(writes).toHaveLength(1);
  });
}

test("ignores unrelated reviews and reviews of older commits", async () => {
  const writes = github(pr.headSha, [
    { id: 1, state: "COMMENTED", commit_id: pr.headSha, body: "Human review" },
    { id: 2, state: "COMMENTED", commit_id: "old", body: marker },
  ]);
  await publishReview("token", pr, [{ severity: "high" }], report, evidence);
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
  await publishReview("token", pr, [], report, evidence);
  expect(writes).toEqual([]);
});

test("dismisses only stale bot approvals", async () => {
  const writes = github(pr.headSha, [
    { id: 1, state: "APPROVED", commit_id: "old", body: marker },
    { id: 2, state: "COMMENTED", commit_id: "old", body: marker },
    { id: 3, state: "APPROVED", commit_id: pr.headSha, body: marker },
    { id: 4, state: "APPROVED", commit_id: "old", body: "Human approval" },
  ]);
  await dismissStaleApprovals("token", pr);
  expect(writes.map((write) => write.path)).toEqual([
    "/repos/team/demo/pulls/1/reviews/1/dismissals",
  ]);
});

for (const incomplete of [
  null,
  { ...evidence, checks: { kind: "available", items: [] } },
  {
    ...evidence,
    checks: { kind: "unavailable", items: [], reason: "HTTP 403" },
  },
  {
    ...evidence,
    checks: {
      kind: "available",
      items: [{ ...evidence.checks.items[0], state: "pending" }],
    },
  },
  {
    ...evidence,
    checks: {
      kind: "available",
      items: [{ ...evidence.checks.items[0], state: "failed" }],
    },
  },
  { ...evidence, standard: { kind: "unavailable", reason: "HTTP 403" } },
  { ...evidence, headSha: "d".repeat(40) },
] satisfies (Evidence | null)[]) {
  test("comments instead of approving without complete successful matching evidence", async () => {
    const writes = github();
    await publishReview("token", pr, [], report, incomplete);
    expect(writes[0].body).toMatchObject({ event: "COMMENT" });
  });
}
