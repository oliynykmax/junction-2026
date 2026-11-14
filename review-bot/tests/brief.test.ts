import { afterEach, expect, spyOn, test } from "bun:test";
import {
  collectBrief,
  MAX_BODY_CHARS,
  MAX_LISTED_FILES,
  MAX_PAGES,
  MAX_BRIEF_DIFF_CHARS,
  MAX_COMMENTS_CHARS,
  renderBrief,
} from "../src/brief";
import type { ChangedFile, Target } from "../src/reviewer";

const target: Target = {
  owner: "team",
  repo: "demo",
  number: 7,
  headSha: "a".repeat(40),
  installationId: 1,
};

afterEach(() => {
  const f = globalThis.fetch as typeof fetch & { mockRestore?: () => void };
  f.mockRestore?.();
});

type Routes = Record<string, unknown | ((url: URL) => Response)>;
function github(routes: Routes) {
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (route === undefined) throw new Error(`Unexpected request ${url}`);
    return typeof route === "function"
      ? (route as (u: URL) => Response)(url)
      : Response.json(route);
  }) as typeof fetch);
}

const pull = "/repos/team/demo/pulls/7";
const user = (login: string) => ({ login });
const pr = {
  title: "Retry transient errors",
  body: "Wraps the client in one retry.",
  user: user("alice"),
  base: { ref: "main" },
};
const commit = (sha: string, message: string, parents = 1) => ({
  sha: sha.repeat(40),
  commit: { message },
  parents: Array(parents).fill({}),
});

const file = (path: string, patch: string | null): ChangedFile => ({
  path,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch,
});

test("the rendered brief carries the PR, its commits, comments, diff and rubric", async () => {
  github({
    [pull]: pr,
    [`${pull}/commits`]: [
      commit("1", "Retry once on 503\n\nThe upstream flaps during deploys."),
      commit("2", "Merge main", 2),
    ],
    [`${pull}/reviews`]: [
      {
        user: user("bob"),
        state: "CHANGES_REQUESTED",
        body: "Add a test for the 503 path.",
        submitted_at: "2026-11-14T10:00:00Z",
      },
    ],
    [`${pull}/comments`]: [
      {
        user: user("bob"),
        path: "src/client.ts",
        line: 12,
        body: "Why only once?",
        created_at: "2026-11-14T10:01:00Z",
      },
    ],
    "/repos/team/demo/issues/7/comments": [],
  });
  const brief = await collectBrief("token", target);
  const text = renderBrief({
    target,
    brief,
    files: [file("src/client.ts", "@@ -1 +1,2 @@\n-a\n+b\n+c")],
    rubric: "RUBRIC TEXT",
  });

  for (const expected of [
    '#7: "Retry transient errors" by alice, https://github.com/team/demo/pull/7',
    `Base main, head ${target.headSha}, 3 changed lines.`,
    "Wraps the client in one retry.",
    "111111111111 Retry once on 503\n\nThe upstream flaps during deploys.",
    "modified  +2 -1  src/client.ts",
    "=== src/client.ts\n1|@@ -1 +1,2 @@\n2|-a\n3|+b\n4|+c",
    "--- bob at 2026-11-14T10:00:00Z (review, CHANGES_REQUESTED)\nAdd a test for the 503 path.",
    "--- bob at 2026-11-14T10:01:00Z on src/client.ts:12\nWhy only once?",
    "RUBRIC TEXT",
  ])
    expect(text).toContain(expected);
  expect(text).toContain("The base commit is not pinned");
  expect(text).toContain("The checkout holds only the head commit");
  expect(text).toContain(`HEAD is still ${target.headSha}`);
  expect(text).not.toContain("no shell");
  expect(text).not.toContain("Merge main");
  expect(text).not.toMatch(/\{[a-z_]+\}/);
  expect(text).not.toContain("Left out of the diff");
  expect(text).not.toContain("simplifications");
});

test("files past the diff budget or without a patch are listed for read_patch", () => {
  const big = `@@ -1 +1 @@\n+${"x".repeat(MAX_BRIEF_DIFF_CHARS)}`;
  const text = renderBrief({
    target,
    brief: null,
    files: [
      file("small.ts", "@@ -1 +1 @@\n+ok"),
      file("big.ts", big),
      file("logo.png", null),
    ],
    rubric: "r",
  });
  expect(text).toContain("=== small.ts");
  expect(text).not.toContain("=== big.ts");
  expect(text).toContain("- big.ts (over the prompt's diff budget)");
  expect(text).toContain(
    "- logo.png (no stored diff: binary or over the size cap)",
  );
});

test("a part GitHub refuses renders as unreadable while the others still render", async () => {
  github({
    [pull]: pr,
    [`${pull}/commits`]: () => Response.json({}, { status: 403 }),
    [`${pull}/reviews`]: [],
    [`${pull}/comments`]: [],
    "/repos/team/demo/issues/7/comments": [],
  });
  const brief = await collectBrief("token", target);
  expect(brief.commits).toEqual({
    kind: "unavailable",
    reason: "GitHub returned HTTP 403",
  });
  const text = renderBrief({ target, brief, files: [], rubric: "r" });
  expect(text).toContain(
    "(The commit messages could not be read when the review started: GitHub returned HTTP 403.",
  );
  expect(text).toContain("Retry transient errors");
  expect(text).toContain("(no reviews or comments yet)");
});

test("comments over the budget keep the newest and count the rest", async () => {
  const long = "y".repeat(1_400);
  const comments = Array.from({ length: 40 }, (_, i) => ({
    user: user("carol"),
    body: `#${i} ${long}`,
    created_at: `2026-11-14T10:${String(i).padStart(2, "0")}:00Z`,
  }));
  github({
    [pull]: pr,
    [`${pull}/commits`]: [],
    [`${pull}/reviews`]: [],
    [`${pull}/comments`]: [],
    "/repos/team/demo/issues/7/comments": comments,
  });
  const brief = await collectBrief("token", target);
  if (brief.comments.kind !== "available") throw new Error("comments unread");
  const kept = brief.comments.value;
  const size = kept.reduce((n, c) => n + c.body.length + 80, 0);
  expect(size).toBeLessThanOrEqual(MAX_COMMENTS_CHARS);
  expect(kept.length + brief.comments.omitted).toBe(40);
  expect(kept.at(-1)!.body.startsWith("#39 ")).toBe(true);
  expect(kept[0]!.body.startsWith(`#${brief.comments.omitted} `)).toBe(true);
  const text = renderBrief({ target, brief, files: [], rubric: "r" });
  expect(text).toContain(
    `(${brief.comments.omitted} older comments left out to fit the prompt.)`,
  );
});

test("a pinned base sha drives the git fallbacks", () => {
  const pinned: Target = {
    ...target,
    base: { owner: "team", repo: "demo", sha: "b".repeat(40) },
  };
  expect(
    renderBrief({ target: pinned, brief: null, files: [], rubric: "r" }),
  ).toContain(`git diff --numstat ${"b".repeat(40)}...HEAD`);
});

test("a change over 300 lines asks for a simplification", () => {
  const files = [
    { ...file("a.ts", "@@ -1 +1 @@\n+a"), additions: 250, deletions: 60 },
  ];
  expect(renderBrief({ target, brief: null, files, rubric: "r" })).toContain(
    "look for one or two simplifications",
  );
});

test("list endpoints are read past the first page, and a cut-off listing says so", async () => {
  const comment = (i: number) => ({
    user: user("dave"),
    path: "a.ts",
    line: 1,
    body: `n${i}`,
    created_at: `2026-11-14T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
  });
  const inline = Array.from({ length: 105 }, (_, i) => comment(i));
  github({
    [pull]: pr,
    [`${pull}/commits`]: (url) =>
      Response.json(
        Array.from({ length: 100 }, (_, i) =>
          commit(String(i % 10), `c${url.searchParams.get("page")}-${i}`),
        ),
      ),
    [`${pull}/reviews`]: [],
    [`${pull}/comments`]: (url) =>
      Response.json(
        url.searchParams.get("page") === "1"
          ? inline.slice(0, 100)
          : inline.slice(100),
      ),
    "/repos/team/demo/issues/7/comments": [],
  });
  const brief = await collectBrief("token", target);
  if (brief.comments.kind !== "available") throw new Error("comments unread");
  expect(brief.comments.value.map((c) => c.body)).toContain("n104");
  expect(brief.comments.incomplete).toBe(false);
  if (brief.commits.kind !== "available") throw new Error("commits unread");
  expect(brief.commits.incomplete).toBe(true);
  expect(brief.commits.value.at(-1)!.message).toBe(`c${MAX_PAGES}-99`);
  const text = renderBrief({ target, brief, files: [], rubric: "r" });
  expect(text).toContain(
    `(GitHub listed more than ${MAX_PAGES * 100} commits, so the newest may be missing.`,
  );
  expect(text).not.toContain("comments, so the newest may be missing");
});

test("the file lists stop at the cap and count the rest", () => {
  const files = Array.from({ length: MAX_LISTED_FILES + 2 }, (_, i) =>
    file(`bin/f${i}.png`, null),
  );
  const text = renderBrief({ target, brief: null, files, rubric: "r" });
  const last = `bin/f${MAX_LISTED_FILES - 1}.png`;
  const over = `bin/f${MAX_LISTED_FILES}.png`;
  expect(text).toContain(`modified  +2 -1  ${last}`);
  expect(text).not.toContain(over);
  expect(text).toContain(
    "(2 more files not listed. pr_overview lists them all.)",
  );
  expect(text).toContain("- and 2 more: pr_overview lists them all.");
});

test("a clipped field stays within its cap and says how much was cut", async () => {
  github({
    [pull]: { ...pr, body: "z".repeat(MAX_BODY_CHARS + 500) },
    [`${pull}/commits`]: [],
    [`${pull}/reviews`]: [],
    [`${pull}/comments`]: [],
    "/repos/team/demo/issues/7/comments": [],
  });
  const brief = await collectBrief("token", target);
  if (brief.facts.kind !== "available") throw new Error("facts unread");
  const body = brief.facts.value.body;
  expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  const kept = body.indexOf("\n[…");
  const cut = Number(body.match(/\[… (\d+) characters cut\]$/)![1]);
  expect(kept + cut).toBe(MAX_BODY_CHARS + 500);
});
