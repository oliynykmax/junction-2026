import { afterEach, expect, mock, test } from "bun:test";
import { gh, prFiles } from "../src/github";
import {
  manualKey,
  parsePrUrl,
  resolveManual,
  startManual,
} from "../src/manual";
import { EMPTY_REVIEW, reviewerExtension } from "../src/reviewer";
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { consume } = await import("../src/manual-gate");
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const sha = "a".repeat(40),
  baseSha = "b".repeat(40);
const target = {
  owner: "team",
  repo: "demo",
  number: 12,
  headSha: sha,
  baseSha,
  mode: "manual",
};
const publicPr = {
  head: { sha },
  base: { sha: baseSha },
  changed_files: 2,
  additions: 10,
  deletions: 2,
};
function github(data = publicPr) {
  const calls = [];
  globalThis.fetch = mock(async (url, init) => {
    calls.push({ url, ...init });
    return Response.json(
      url.endsWith("/repos/team/demo")
        ? { private: false, visibility: "public" }
        : data,
    );
  });
  return calls;
}
function env() {
  const started = [];
  const keys = [];
  const admit = mock(async () => true);
  return {
    started,
    keys,
    admit,
    MANUAL_GATE: { getByName: () => ({ admit }) },
    REVIEWS: {
      getByName: (key) => {
        keys.push(key);
        return {
          start: async (t) => {
            started.push(JSON.parse(JSON.stringify(t)));
          },
        };
      },
    },
  };
}
const request = (body) =>
  new Request("https://review.test/api/reviews", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://review.test",
    },
    body: JSON.stringify(body),
  });

test("strictly parses only canonical HTTPS GitHub PR URLs", () => {
  expect(parsePrUrl("https://github.com/Team/Demo/pull/12")).toEqual({
    owner: "team",
    repo: "demo",
    number: 12,
  });
  for (const url of [
    "http://github.com/team/demo/pull/12",
    "https://github.com.evil/team/demo/pull/12",
    "https://user@github.com/team/demo/pull/12",
    "https://github.com/team/demo/pull/0",
    "https://github.com/team/demo/pull/12?x=1",
    "https://github.com/team/demo/pull/12#files",
    "https://github.com/team/../pull/12",
    "https://github.com/team/demo/issues/12",
    null,
  ])
    expect(() => parsePrUrl(url)).toThrow();
});

test("resolves public PR head and base without app tokens or authorization", async () => {
  const calls = github();
  expect(await resolveManual("https://github.com/team/demo/pull/12")).toEqual(
    target,
  );
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBeUndefined();
  }
});

test("rejects private repositories before reading the PR", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ private: true, visibility: "private" }),
  );
  await expect(
    resolveManual("https://github.com/team/demo/pull/12"),
  ).rejects.toThrow("not publicly accessible");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("rejects oversized changes", async () => {
  github({ ...publicPr, changed_files: 61 });
  await expect(
    resolveManual("https://github.com/team/demo/pull/12"),
  ).rejects.toThrow("60 files");
});

test("starts in isolated namespace and persists manual mode with pinned commits", async () => {
  const calls = github();
  const bindings = env();
  const response = await startManual(
    request({ url: "https://github.com/team/demo/pull/12" }),
    bindings,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: `/m/team/demo/12?sha=${sha}` });
  expect(bindings.keys).toEqual([manualKey(target)]);
  expect(bindings.keys[0]).toBe(`manual:team/demo#12@${sha}`);
  expect(bindings.started).toEqual([target]);
  expect(bindings.started[0].installationId).toBeUndefined();
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

test("rejects malformed, large and cross-origin requests without starting work", async () => {
  const bindings = env();
  expect(
    (await startManual(request({ url: "https://evil.test/a" }), bindings))
      .status,
  ).toBe(400);
  expect(
    (await startManual(request({ url: "x".repeat(3000) }), bindings)).status,
  ).toBe(413);
  const cross = request({ url: "https://github.com/team/demo/pull/12" });
  cross.headers.set("origin", "https://evil.test");
  expect((await startManual(cross, bindings)).status).toBe(403);
  expect(bindings.started).toHaveLength(0);
  expect(bindings.admit).not.toHaveBeenCalled();
});

test("budget refusal stops before GitHub or model work", async () => {
  globalThis.fetch = mock(() => {
    throw new Error("must not fetch");
  });
  const bindings = env();
  bindings.admit.mockResolvedValue(false);
  const response = await startManual(
    request({ url: "https://github.com/team/demo/pull/12" }),
    bindings,
  );
  expect(response.status).toBe(429);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(bindings.started).toHaveLength(0);
});

test("safe errors do not expose upstream bodies", async () => {
  globalThis.fetch = mock(
    async () => new Response("secret internal detail", { status: 403 }),
  );
  const response = await startManual(
    request({ url: "https://github.com/team/demo/pull/12" }),
    env(),
  );
  expect(response.status).toBe(422);
  expect(await response.text()).not.toContain("secret");
});

test("manual patches use the pinned comparison, webhook patches retain PR endpoint", async () => {
  const calls = github({ files: [] });
  await prFiles("", target);
  expect(calls[0].url).toEndWith(`/compare/${baseSha}...${sha}`);
  globalThis.fetch = mock(async (url, init) => {
    calls.push({ url, ...init });
    return Response.json([]);
  });
  await prFiles("app-token", { owner: "team", repo: "demo", number: 12 });
  expect(calls[1].url).toContain("/pulls/12/files");
  expect(calls[1].headers.authorization).toBe("Bearer app-token");
});

test("anonymous gh reads omit Bearer while authenticated webhook calls retain it", async () => {
  const calls = github();
  await gh("", "/repos/team/demo");
  await gh("app-token", "/repos/team/demo");
  expect(calls[0].headers.authorization).toBeUndefined();
  expect(calls[1].headers.authorization).toBe("Bearer app-token");
});

for (const manual of [true, false])
  test(`clean completion ${manual ? "never approves manual review after restore" : "preserves webhook approval"}`, async () => {
    const state = structuredClone(EMPTY_REVIEW);
    state.target = JSON.parse(
      JSON.stringify(
        manual
          ? target
          : {
              owner: "team",
              repo: "demo",
              number: 12,
              headSha: sha,
              installationId: 7,
            },
      ),
    );
    state.lookups = [{ tool: "docs", args: "{}", at: Date.now() }];
    const token = mock(async () => "app-token"),
      approve = mock(async () => {});
    const { extension } = reviewerExtension({
      token,
      approve,
      scan: async () => [],
    });
    const finish = extension.tools.find((t) => t.name === "finish_review");
    const api = {
      conversationId: "root",
      snapshot: async () => state,
      commit: async (callback) => callback({ doc: async () => state }),
    };
    await finish.execute({ summary: "Checked", not_checked: [] }, api, {});
    expect(state.verdict.decision).toBe("no_blockers_found");
    expect(approve).toHaveBeenCalledTimes(manual ? 0 : 1);
    expect(token).toHaveBeenCalledTimes(manual ? 0 : 1);
  });

test("durable admission enforces per-client, global hourly and daily budgets across restores", () => {
  let budget = consume(undefined, "ip", 0);
  budget = consume(JSON.parse(JSON.stringify(budget)), "ip", 0);
  expect(consume(budget, "ip", 0)).toBeNull();
  for (let i = 0; i < 8; i++) budget = consume(budget, `other-${i}`, 0);
  expect(consume(budget, "extra", 0)).toBeNull();
  expect(consume(budget, "ip", 3_600_000).hourly).toBe(1);
  expect(consume({ ...budget, daily: 50 }, "ip", 3_600_000)).toBeNull();
  expect(consume({ ...budget, daily: 50 }, "ip", 86_400_000).daily).toBe(1);
});
