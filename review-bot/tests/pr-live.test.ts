import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as github from "../src/github";
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
    { owner: "team", repo: "demo", number: 7, headSha, mode: "webhook" },
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

test("a manual review reads anonymously even where the app is installed", async () => {
  const repoToken = spyOn(github, "repoToken").mockResolvedValue("app-token");
  const auth: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pull);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
    return Response.json([]);
  });
  const target = { owner: "team", repo: "demo", number: 7, headSha };

  await prLive(
    { APP_ID: "1", PRIVATE_KEY: "k" },
    { ...target, mode: "manual" },
  );
  expect(repoToken).not.toHaveBeenCalled();
  expect(auth.length).toBeGreaterThan(0);
  expect(auth.every((a) => a === null)).toBe(true);

  auth.length = 0;
  await prLive(
    { APP_ID: "1", PRIVATE_KEY: "k" },
    { ...target, mode: "webhook" },
  );
  expect(auth.every((a) => a?.includes("app-token"))).toBe(true);
});

test("uses the owning review's cached installation token", async () => {
  const repoToken = spyOn(github, "repoToken").mockResolvedValue("new-token");
  const auth: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pull);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
    return Response.json([]);
  });

  await prLive(
    { APP_ID: "1", PRIVATE_KEY: "k" },
    { owner: "team", repo: "demo", number: 7, headSha, mode: "webhook" },
    "stored-token",
  );

  expect(repoToken).not.toHaveBeenCalled();
  expect(auth.every((a) => a === "Bearer stored-token")).toBe(true);
});
