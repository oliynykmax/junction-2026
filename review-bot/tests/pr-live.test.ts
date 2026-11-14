import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { parsePr, prLive } from "../src/pr-live";

const headSha = "a".repeat(40);
const pull = {
  title: "Keep review results scoped to the commit",
  user: {
    login: "alex-chen",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  base: { ref: "main" },
  head: { ref: "fix/commit-cache" },
  updated_at: "2026-11-14T10:00:00Z",
  state: "open",
  merged_at: null,
  draft: true,
};

afterEach(() => {
  mock.restore();
});

test("reads title, author, branches and state from a pull request", () => {
  expect(parsePr(pull)).toEqual({
    title: pull.title,
    author: "alex-chen",
    avatarUrl: pull.user.avatar_url,
    base: "main",
    head: "fix/commit-cache",
    updatedAt: pull.updated_at,
    state: "open",
    draft: true,
  });
  expect(parsePr({ ...pull, merged_at: "2026-11-14T11:00:00Z" })?.state).toBe(
    "merged",
  );
});

test("drops an avatar that is not on GitHub's avatar host and rejects a malformed PR", () => {
  expect(
    parsePr({
      ...pull,
      user: { login: "x", avatar_url: "https://evil.test/a.png" },
    })?.avatarUrl,
  ).toBeNull();
  expect(parsePr({ ...pull, head: null })).toBeNull();
});

test("reads a public repo anonymously when the app is not installed there", async () => {
  const auth: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    auth.push(new Headers(init?.headers).get("authorization"));
    if (url.pathname.endsWith("/pulls/7")) return Response.json(pull);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({
        check_runs: [
          {
            id: 1,
            name: "Tests",
            head_sha: headSha,
            status: "in_progress",
            conclusion: null,
            details_url: "https://github.com/team/demo/actions/runs/1",
            app: { name: "GitHub Actions" },
          },
        ],
      });
    if (url.pathname.endsWith("/statuses")) return Response.json([]);
    throw new Error(`Unexpected path ${url}`);
  });
  const live = await prLive(
    { APP_ID: "1", PRIVATE_KEY: "not a key" },
    { owner: "team", repo: "demo", number: 7, headSha },
  );
  expect(auth.every((a) => a === null)).toBe(true);
  expect(live.pr?.title).toBe(pull.title);
  expect(live.checks).toEqual({
    kind: "available",
    items: [
      {
        id: 1,
        name: "Tests",
        state: "pending",
        detail: "in_progress",
        url: "https://github.com/team/demo/actions/runs/1",
        source: "GitHub Actions",
      },
    ],
  });
});
