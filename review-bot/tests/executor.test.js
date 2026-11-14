import { afterEach, expect, spyOn, test } from "bun:test";
import { executor } from "../src/executor";

afterEach(() => {
  if (globalThis.fetch.mockRestore) globalThis.fetch.mockRestore();
});

test("executor uses a private bearer token and forwards the exact pinned checkout", async () => {
  const requests = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      workspace: "/tmp/runner/repo",
      commit: "a".repeat(40),
    });
  });
  const client = executor({
    EXECUTOR_URL: "http://127.0.0.1:8787/",
    EXECUTOR_TOKEN: "private-runner-token",
  });

  await expect(
    client.checkout({
      session: "review-7",
      owner: "team",
      repo: "demo",
      sha: "a".repeat(40),
      githubToken: "temporary-github-token",
    }),
  ).resolves.toEqual({ workspace: "/tmp/runner/repo", commit: "a".repeat(40) });

  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:8787/v1/checkout",
      init: expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer private-runner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session: "review-7",
          owner: "team",
          repo: "demo",
          sha: "a".repeat(40),
          githubToken: "temporary-github-token",
        }),
      }),
    },
  ]);
});

test("executor fails closed when its private configuration is absent", () => {
  expect(() => executor({ EXECUTOR_URL: "http://127.0.0.1:8787" })).toThrow(
    "Free shell executor is not configured",
  );
});
