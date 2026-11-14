import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { Env, ReviewView } from "../src/review";
import { callback, login, logout } from "../src/auth";
import { seal, unseal } from "../src/session";
import {
  buildSignOff,
  type SignOff,
  signOff,
  signOffComment,
  STATUS_CONTEXT,
} from "../src/signoff";

const SECRET = "test-session-secret";
const sha = "a".repeat(40);
const pr = { owner: "team", repo: "demo", number: 1, headSha: sha };
const origin = "https://review.example";
const api = `${origin}/api/r/team/demo/1/${sha}/signoff`;
let pem = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const blocker = {
  id: "f1",
  path: "src/A.cs",
  line: 10,
  severity: "high",
  class: "correctness",
  confidence: "verified",
  title: "Drops diagnostics",
  body: "",
  source: "agent",
  suggestedPatch: null,
} as const;
const minor = {
  ...blocker,
  id: "f2",
  severity: "low",
  title: "Naming",
} as const;

function view(over: Partial<ReviewView> = {}): ReviewView {
  return {
    status: "done",
    failure: null,
    review: {
      target: { ...pr, installationId: 7 },
      prompt: null,
      model: null,
      startedAt: 0,
      scan: null,
      findings: [blocker, minor],
      verdict: {
        decision: "changes_requested",
        summary: "",
        notChecked: ["Tests were not run."],
        dismissed: [],
      },
      lookups: [],
      docsRefusals: 0,
    },
    heldBack: 0,
    activity: [],
    costUsd: 0,
    signOff: null,
    ...over,
  } as ReviewView;
}

const input = {
  checked: "Read TypeCollector.cs",
  risk: "Analyzer warnings may be missing",
  notChecked: "",
  confirm: true,
  dispositions: [
    { findingId: "f1", decision: "accept", reason: "Covered by a follow-up" },
  ],
};
const signer = { login: "alice", id: 1 };

test("a sealed value round-trips, and tampering, expiry or another purpose rejects it", async () => {
  const token = await seal(SECRET, "session", signer, 60);
  expect(await unseal(SECRET, "session", token)).toEqual(signer);
  expect(await unseal(SECRET, "oauth", token)).toBeNull();
  expect(await unseal("other", "session", token)).toBeNull();
  expect(
    await unseal(
      SECRET,
      "session",
      `${token.split(".")[0]}x.${token.split(".")[1]}`,
    ),
  ).toBeNull();
  expect(
    await unseal(SECRET, "session", await seal(SECRET, "session", signer, -1)),
  ).toBeNull();
  expect(await unseal(SECRET, "session", "garbage")).toBeNull();
});

test("builds a record with the AI's not-checked list and only blocking dispositions", () => {
  const s = buildSignOff(input, view(), signer, "write", 5);
  expect(s.headSha).toBe(sha);
  expect(s.aiNotChecked).toEqual(["Tests were not run."]);
  expect(s.findings).toEqual({ total: 2, blocking: 1 });
  expect(s.dispositions).toHaveLength(1);
  expect(s.dispositions[0]).toMatchObject({
    findingId: "f1",
    decision: "accept",
    title: "Drops diagnostics",
  });
});

for (const [name, body, status] of [
  ["no confirmation", { ...input, confirm: false }, 400],
  ["no risk", { ...input, risk: "  " }, 400],
  ["nothing checked", { ...input, checked: "" }, 400],
  ["a blocker left undecided", { ...input, dispositions: [] }, 422],
  [
    "a blocker without a reason",
    {
      ...input,
      dispositions: [{ findingId: "f1", decision: "dismiss", reason: " " }],
    },
    422,
  ],
  ["oversized text", { ...input, checked: "x".repeat(4001) }, 400],
] as const)
  test(`refuses ${name}`, () => {
    expect(() => buildSignOff(body, view(), signer, "write")).toThrow(
      expect.objectContaining({ status }),
    );
  });

test("refuses an unfinished review", () => {
  expect(() =>
    buildSignOff(input, view({ status: "running" }), signer, "write"),
  ).toThrow(expect.objectContaining({ status: 409 }));
});

test("the comment names the owner, quotes their words and lists what was not checked", () => {
  const s = buildSignOff(input, view(), signer, "write");
  const body = signOffComment(s, "https://review.example/r");
  expect(body).toContain("@alice signed off on `aaaaaaa`");
  expect(body).toContain("> Read TypeCollector.cs");
  expect(body).toContain(
    "- **Risk accepted:** Drops diagnostics\n  > Covered by a follow-up",
  );
  expect(body).toContain("- Tests were not run. _(listed by the AI)_");
  expect(body).toContain("> Analyzer warnings may be missing");
});

test("login and logout only return to review pages", async () => {
  const env = {
    GITHUB_CLIENT_ID: "Iv1",
    GITHUB_CLIENT_SECRET: "s",
    SESSION_SECRET: SECRET,
    REVIEW_BASE_URL: origin,
  } as Env;
  const bad = await login(
    new Request(`${origin}/auth/login?return=https://evil.example`),
    env,
  );
  expect(bad.status).toBe(400);
  const good = await login(
    new Request(
      `${origin}/auth/login?return=${encodeURIComponent(`/r/team/demo/1?sha=${sha}#sign-off`)}`,
    ),
    env,
  );
  expect(good.status).toBe(302);
  const to = new URL(good.headers.get("location")!);
  expect(to.origin).toBe("https://github.com");
  expect(to.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
  expect(good.headers.get("set-cookie")).toContain("HttpOnly");
  expect(
    logout(
      new Request(`${origin}/auth/logout?return=//evil.example`),
    ).headers.get("location"),
  ).toBe("/");
});

test("sign-in uses the public origin when a proxy forwards to another host", async () => {
  const env = {
    GITHUB_CLIENT_ID: "Iv1",
    GITHUB_CLIENT_SECRET: "s",
    SESSION_SECRET: SECRET,
    REVIEW_BASE_URL: origin,
  } as Env;
  const res = await login(
    new Request(
      `https://celld.internal/auth/login?return=${encodeURIComponent(`/r/team/demo/1?sha=${sha}`)}`,
    ),
    env,
  );
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(to.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
});

// The endpoint, against a fake review object and a fake GitHub.

test("the comment quotes multi-line reasons inside the list item and pings nobody", () => {
  const s = buildSignOff(
    {
      ...input,
      checked: "Asked @bob and @team/core",
      dispositions: [
        { findingId: "f1", decision: "dismiss", reason: "Line one\ncc @carol" },
      ],
    },
    view({
      review: {
        ...view().review,
        findings: [{ ...blocker, title: "Ping @dave\nnow" }],
      },
    }),
    signer,
    "write",
  );
  const body = signOffComment(s, "https://review.example/r");
  expect(body).toContain(
    "- **Dismissed:** Ping @\u200bdave now\n  > Line one\n  > cc @\u200bcarol",
  );
  expect(body).toContain("> Asked @\u200bbob and @\u200bteam/core");
  // The signer is named on purpose.
  expect(body).toContain("@alice signed off");
});

test("a GitHub failure during sign-in is a readable 502, not a crash", async () => {
  const env = {
    GITHUB_CLIENT_ID: "Iv1",
    GITHUB_CLIENT_SECRET: "s",
    SESSION_SECRET: SECRET,
  } as Env;
  const state = await seal(
    SECRET,
    "oauth",
    { state: "st", back: `/r/team/demo/1?sha=${sha}` },
    60,
  );
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
  ) =>
    String(input).includes("access_token")
      ? Response.json({ access_token: "user" })
      : new Response("boom", { status: 500 })) as typeof fetch);
  const res = await callback(
    new Request(`${origin}/auth/callback?code=c&state=st`, {
      headers: { cookie: `bb_oauth=${state}` },
    }),
    env,
  );
  expect(res.status).toBe(502);
  expect(res.headers.get("set-cookie")).toBeNull();
});

function harness(opts: {
  head?: string;
  permission?: string;
  existing?: SignOff | null;
  statusFails?: boolean;
  recordEchoFails?: boolean;
}) {
  let stored: SignOff | null = opts.existing ?? null;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const stub = {
    view: async () => view({ signOff: stored }),
    storeSignOff: async (r: SignOff) => {
      if (stored) return stored;
      stored = r;
      return null;
    },
    recordEcho: async (echo: SignOff["echo"]) => {
      if (opts.recordEchoFails) throw new Error("storage unavailable");
      if (stored) stored = { ...stored, echo };
    },
  };
  const env = {
    APP_ID: "1",
    PRIVATE_KEY: pem,
    SESSION_SECRET: SECRET,
    GITHUB_CLIENT_ID: "Iv1",
    GITHUB_CLIENT_SECRET: "s",
    REVIEW_BASE_URL: origin,
    REVIEWS: { getByName: () => stub },
  } as unknown as Env;
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const path = String(input).replace("https://api.github.com", "");
    if (path === "/app/installations/7/access_tokens")
      return Response.json({
        token: "inst",
        expires_at: "2099-01-01T00:00:00Z",
      });
    if (path === "/repos/team/demo/pulls/1")
      return Response.json({ head: { sha: opts.head ?? sha } });
    if (path === "/repos/team/demo/collaborators/alice/permission")
      return opts.permission === "none"
        ? new Response("not found", { status: 404 })
        : Response.json({ permission: opts.permission ?? "write" });
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path.startsWith("/repos/team/demo/statuses/") && opts.statusFails)
        return new Response("Resource not accessible by integration", {
          status: 403,
        });
      return Response.json({});
    }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch);
  return { env, writes, stored: () => stored };
}

async function post(
  env: Env,
  body: unknown = input,
  headers: HeadersInit = {},
) {
  const cookie = `bb_session=${await seal(SECRET, "session", signer, 60)}`;
  return signOff(
    new Request(api, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
    pr,
  );
}

test("a writer signs: stored, commented on the PR and marked on the commit", async () => {
  const h = harness({});
  const res = await post(h.env);
  expect(res.status).toBe(200);
  expect(h.stored()?.signer.login).toBe("alice");
  expect(h.stored()?.echo).toEqual({
    comment: { ok: true },
    status: { ok: true },
  });
  const status = h.writes.find(
    (w) => w.path === `/repos/team/demo/statuses/${sha}`,
  );
  expect(status?.body).toMatchObject({
    state: "success",
    context: STATUS_CONTEXT,
    description: "Signed off by @alice",
  });
  expect(
    h.writes.some((w) => w.path === "/repos/team/demo/issues/1/comments"),
  ).toBe(true);
});

test("a failed status write is recorded, not hidden, and the sign-off stands", async () => {
  const h = harness({ statusFails: true });
  const res = await post(h.env);
  expect(res.status).toBe(200);
  const echo = h.stored()?.echo;
  expect(echo?.comment.ok).toBe(true);
  expect(echo?.status.ok).toBe(false);
});

for (const [name, opts, headers, status] of [
  ["a cross-origin request", {}, { origin: "https://evil.example" }, 403],
  ["no session", {}, { cookie: "" }, 401],
  ["a read-only user", { permission: "read" }, {}, 403],
  ["a non-collaborator", { permission: "none" }, {}, 403],
  ["a commit that is no longer the head", { head: "b".repeat(40) }, {}, 409],
] as const)
  test(`refuses ${name} and writes nothing`, async () => {
    const h = harness(opts);
    const res = await post(h.env, input, headers);
    expect(res.status).toBe(status);
    expect(h.stored()).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

test("the first sign-off wins", async () => {
  const h = harness({});
  expect((await post(h.env)).status).toBe(200);
  const again = await post(h.env);
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toContain("@alice");
});

test("once stored, the sign-off is reported as signed even if recording the echo fails", async () => {
  const h = harness({ recordEchoFails: true });
  const res = await post(h.env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as SignOff;
  expect(body.signer.login).toBe("alice");
  expect(body.echo).toEqual({ comment: { ok: true }, status: { ok: true } });
  expect(h.stored()?.signer.login).toBe("alice");
});

for (const [name, sealed] of [
  [
    "an OAuth state cookie",
    () =>
      seal(
        SECRET,
        "oauth",
        { state: "st", back: `/r/team/demo/1?sha=${sha}` },
        60,
      ),
  ],
  ["a session without a login", () => seal(SECRET, "session", { id: 1 }, 60)],
  [
    "a session with a malformed login",
    () => seal(SECRET, "session", { login: "a/../b", id: 1 }, 60),
  ],
] as const)
  test(`refuses ${name} used as a session, and asks GitHub nothing`, async () => {
    const h = harness({});
    const res = await post(h.env, input, {
      cookie: `bb_session=${await sealed()}`,
    });
    expect(res.status).toBe(401);
    expect(h.stored()).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
