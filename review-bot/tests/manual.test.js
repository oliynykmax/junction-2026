import { afterEach, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { gh, prFiles } from "../src/github";
import {
  manualView,
  parsePrUrl,
  resolveManual,
  startManual,
} from "../src/manual";
import { reviewKey } from "../src/review-key";
import { EMPTY_REVIEW, reviewerExtension } from "../src/reviewer";
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { consume, ManualGate } = await import("../src/manual-gate");
const originalFetch = globalThis.fetch;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
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
  base: { sha: baseSha, repo: { private: false, visibility: "public" } },
  changed_files: 2,
  additions: 10,
  deletions: 2,
};
function github(data = publicPr) {
  const calls = [];
  globalThis.fetch = mock(async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith("/access_tokens"))
      return Response.json({
        token: "public-read-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
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
  const admitLookup = mock(async () => true);
  return {
    APP_ID: "123",
    PRIVATE_KEY: privateKey,
    PUBLIC_INSTALLATION_ID: "7",
    started,
    keys,
    admit,
    admitLookup,
    MANUAL_GATE: { getByName: () => ({ admit, admitLookup }) },
    REVIEWS: {
      getByName: (key) => {
        keys.push(key);
        return {
          hasStarted: async () => started.some((t) => reviewKey(t) === key),
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

test("resolves public PR head and base using the supplied read-only app token", async () => {
  const calls = github();
  expect(
    await resolveManual(
      "https://github.com/team/demo/pull/12",
      "public-read-token",
    ),
  ).toEqual(target);
  expect(calls).toHaveLength(1);
  for (const call of calls) {
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe("Bearer public-read-token");
  }
});

test("rejects PRs whose base repository is private", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      ...publicPr,
      base: {
        ...publicPr.base,
        repo: { private: true, visibility: "private" },
      },
    }),
  );
  await expect(
    resolveManual("https://github.com/team/demo/pull/12", "public-read-token"),
  ).rejects.toThrow("not publicly accessible");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("rejects oversized changes", async () => {
  github({ ...publicPr, changed_files: 61 });
  await expect(
    resolveManual("https://github.com/team/demo/pull/12", "public-read-token"),
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
  expect(bindings.keys).toEqual([reviewKey(target)]);
  expect(bindings.keys[0]).toBe(`manual:team/demo#12@${sha}`);
  expect(bindings.started).toEqual([target]);
  expect(bindings.started[0].installationId).toBeUndefined();
  const issuance = calls.find((c) => c.method === "POST");
  expect(issuance.url).toEndWith("/app/installations/7/access_tokens");
  expect(JSON.parse(issuance.body)).toEqual({
    permissions: {
      contents: "read",
      pull_requests: "read",
      checks: "read",
      statuses: "read",
    },
  });
  const reads = calls.filter((c) => c.method === "GET");
  expect(reads).toHaveLength(1);
  expect(reads[0].headers.authorization).toBe("Bearer public-read-token");
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
  bindings.admitLookup.mockResolvedValue(false);
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
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});

test("manual patches use the pinned comparison, webhook patches retain PR endpoint", async () => {
  const calls = github({ files: [] });
  await prFiles("public-read-token", target);
  expect(calls[0].url).toEndWith(`/compare/${baseSha}...${sha}`);
  expect(calls[0].headers.authorization).toBe("Bearer public-read-token");
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

function settlingCommit(state) {
  return async (callback) => {
    const revokers = [];
    const draft = (value) => {
      if (typeof value !== "object" || value === null) return value;
      const { proxy, revoke } = Proxy.revocable(value, {
        get: (target, key) => draft(Reflect.get(target, key)),
      });
      revokers.push(revoke);
      return proxy;
    };
    try {
      return await callback({ doc: async () => draft(state) });
    } finally {
      for (const revoke of revokers) revoke();
    }
  };
}

const finding = {
  id: "call-1",
  path: "src/a.ts",
  line: 1,
  severity: "low",
  class: "maintainability",
  confidence: "likely",
  title: "Name",
  body: "Body",
  source: "agent",
  suggestedPatch: null,
};

for (const manual of [true, false])
  test(`completion ${manual ? "never publishes a manual review after restore" : "publishes the webhook review"}, after the commit settles`, async () => {
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
    state.findings = [finding];
    state.verifier = {
      status: "done",
      conversationId: 2,
      checks: [],
      verdicts: {},
      summary: "Nothing changed to verify.",
    };
    const token = mock(async () => "app-token"),
      publish = mock(async () => {}),
      finished = mock(() => {});
    const { extension } = reviewerExtension({
      token,
      publish,
      finished,
      scan: async () => [],
    });
    const finish = extension.tools.find((t) => t.name === "finish_review");
    const api = {
      conversationId: "root",
      snapshot: async () => state,
      commit: settlingCommit(state),
    };
    const result = await finish.execute(
      {
        situation: "s",
        task: "t",
        action: "a",
        result: "r",
        summary: "Checked",
        not_checked: [],
      },
      api,
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(state.verdict.decision).toBe("no_blockers_found");
    expect(finished).toHaveBeenCalledWith("no_blockers_found", 1);
    expect(publish).toHaveBeenCalledTimes(manual ? 0 : 1);
    if (!manual) expect(publish.mock.calls[0][2]).toEqual([finding]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledWith(manual ? "public" : 7);
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

test("failed resolution never consumes model review budget", async () => {
  github({ ...publicPr, changed_files: 61 });
  const bindings = env();
  const response = await startManual(
    request({ url: "https://github.com/team/demo/pull/12" }),
    bindings,
  );
  expect(response.status).toBe(422);
  expect(bindings.admitLookup).toHaveBeenCalledTimes(1);
  expect(bindings.admit).not.toHaveBeenCalled();
});

test("manual report polling reads stored public review without GitHub", async () => {
  globalThis.fetch = mock(() => {
    throw new Error("GitHub quota exhausted");
  });
  const view = { status: "done", review: { target } };
  const bindings = {
    REVIEWS: {
      getByName: (key) => {
        expect(key).toBe(reviewKey(target));
        return { view: async () => view };
      },
    },
  };
  for (let i = 0; i < 10; i++) {
    const response = await manualView(bindings, target);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("manual report reads refuse absent or webhook state", async () => {
  for (const stored of [
    null,
    { ...target, mode: "webhook", installationId: 3 },
  ]) {
    const bindings = {
      REVIEWS: {
        getByName: () => ({
          view: async () => ({ review: { target: stored } }),
        }),
      },
    };
    expect((await manualView(bindings, target)).status).toBe(404);
  }
});

test("durable review admission charges a commit once across retries and clients", async () => {
  const data = new Map();
  const storage = {
    get: async (key) => data.get(key),
    put: async (key, value) => data.set(key, value),
  };
  const gate = { ctx: { storage: { transaction: async (fn) => fn(storage) } } };
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit-1")).toBe(
    true,
  );
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit-1")).toBe(
    true,
  );
  expect(
    await ManualGate.prototype.admit.call(gate, "other-ip", "commit-1"),
  ).toBe(true);
  expect(data.get("budget").hourly).toBe(1);
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit-2")).toBe(
    true,
  );
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit-3")).toBe(
    false,
  );
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit-1")).toBe(
    true,
  );
  expect(data.get("budget").hourly).toBe(2);
});

test("resubmitting a stored review bypasses an exhausted review budget", async () => {
  github();
  const bindings = env();
  bindings.started.push(target);
  bindings.admit.mockResolvedValue(false);
  const response = await startManual(
    request({ url: "https://github.com/team/demo/pull/12" }),
    bindings,
  );
  expect(response.status).toBe(200);
  expect(bindings.admit).not.toHaveBeenCalled();
});

test("lookup throttling has its own durable budget", async () => {
  const data = new Map();
  const storage = {
    get: async (key) => data.get(key),
    put: async (key, value) => data.set(key, value),
  };
  const gate = { ctx: { storage: { transaction: async (fn) => fn(storage) } } };
  for (let i = 0; i < 10; i++)
    expect(await ManualGate.prototype.admitLookup.call(gate, "ip")).toBe(true);
  expect(await ManualGate.prototype.admitLookup.call(gate, "ip")).toBe(false);
  expect(data.get("budget")).toBeUndefined();
  expect(await ManualGate.prototype.admit.call(gate, "ip", "commit")).toBe(
    true,
  );
});

test("manual report lookup canonicalizes mixed-case owner and repository", async () => {
  expect(reviewKey({ ...target, owner: "TEAM", repo: "Demo" })).toBe(
    reviewKey(target),
  );
});
