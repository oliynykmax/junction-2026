import { AsyncLocalStorage } from "node:async_hooks";
import { type Env, Review } from "../../src/review";
import type { Target } from "../../src/reviewer";

type Origin = "ctor" | "start" | "view" | "probe" | "alarm";

type Tally = {
  phase: string;
  origin: Origin | "unknown";
  op: "sql" | "setAlarm" | "deleteAlarm";
  table: string;
  statement: string;
  calls: number;
  rowsWritten: number;
  rowsRead: number;

  sameTimeSetAlarm: number;
};

type Pending = {
  phase: string;
  origin: Tally["origin"];
  table: string;
  statement: string;

  docs: (number | string)[];
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
};

type Profile = {
  phase: string;
  tallies: Map<string, Tally>;
  pending: Pending[];
  alarm: number | null | undefined;
  raw: SqlStorage["exec"] | null;

  alarms: {
    phase: string;
    origin: string;
    op: string;
    inMs: number | null;
    before: string;
  }[];
};

const origin = new AsyncLocalStorage<Origin>();
const profiles = new Map<string, Profile>();

function profileOf(id: string): Profile {
  let p = profiles.get(id);
  if (!p) {
    p = {
      phase: "unmarked",
      tallies: new Map(),
      pending: [],
      alarm: undefined,
      raw: null,
      alarms: [],
    };
    profiles.set(id, p);
  }
  return p;
}

const TABLE =
  /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+\w+(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|SELECT[\s\S]*?\bFROM)\s+["`]?([\w.]+)/i;

function classify(sql: string): { table: string; statement: string } {
  const statement = sql.replace(/\s+/g, " ").trim().slice(0, 160);
  return { table: TABLE.exec(sql)?.[2] ?? "(other)", statement };
}

/** Rows bound to pi-durable's insertRows: one JSON array of rows, or flat VALUES parameters. */
function boundRows(bindings: unknown[], columns: number): unknown[][] {
  if (bindings.length === 1 && typeof bindings[0] === "string") {
    try {
      const parsed: unknown = JSON.parse(bindings[0]);
      if (Array.isArray(parsed))
        return parsed.map((r) => (typeof r === "string" ? JSON.parse(r) : r));
    } catch {}
  }
  const rows: unknown[][] = [];
  for (let i = 0; i + columns <= bindings.length; i += columns)
    rows.push(bindings.slice(i, i + columns));
  return rows;
}

function docsOf(table: string, sql: string, bindings: unknown[]) {
  if (!/^\s*INSERT/i.test(sql)) return [];
  if (table === "documents")
    return boundRows(bindings, 9).map((r) => String(r[1]).replace(/"/g, ""));
  if (table === "document_revisions")
    return boundRows(bindings, 5).map((r) => Number(r[0]));
  return [];
}

function count(
  p: Profile,
  fields: Omit<
    Tally,
    "calls" | "rowsWritten" | "rowsRead" | "sameTimeSetAlarm"
  >,
): Tally {
  const key = [
    fields.phase,
    fields.origin,
    fields.op,
    fields.table,
    fields.statement,
  ].join("\u0000");
  let t = p.tallies.get(key);
  if (!t) {
    t = {
      ...fields,
      calls: 0,
      rowsWritten: 0,
      rowsRead: 0,
      sameTimeSetAlarm: 0,
    };
    p.tallies.set(key, t);
  }
  t.calls++;
  return t;
}

function instrument(state: DurableObjectState) {
  const p = profileOf(state.id.toString());
  const storage = state.storage;
  const sql = storage.sql;
  const exec = sql.exec.bind(sql);
  p.raw = exec;
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    const cursor = exec(query, ...bindings);
    const { table, statement } = classify(query);
    p.pending.push({
      phase: p.phase,
      origin: origin.getStore() ?? "unknown",
      table,
      statement,
      docs: docsOf(table, query, bindings),
      cursor,
    });
    return cursor;
  }) as typeof sql.exec;

  const alarm = (op: "setAlarm" | "deleteAlarm", at?: number) => {
    p.alarms.push({
      phase: p.phase,
      origin: origin.getStore() ?? "unknown",
      op,
      inMs: at === undefined ? null : at - Date.now(),
      before:
        p.alarm === undefined
          ? "unknown"
          : p.alarm === null
            ? "none"
            : `in ${p.alarm - Date.now()} ms`,
    });
    return count(p, {
      phase: p.phase,
      origin: origin.getStore() ?? "unknown",
      op,
      table: "(alarm)",
      statement: op,
    });
  };
  const getAlarm = storage.getAlarm.bind(storage);
  storage.getAlarm = async (options) => {
    const at = await getAlarm(options);
    p.alarm = at;
    return at;
  };
  const setAlarm = storage.setAlarm.bind(storage);
  storage.setAlarm = (time, options) => {
    const at = typeof time === "number" ? time : time.getTime();
    const t = alarm("setAlarm", at);
    if (p.alarm === at) t.sameTimeSetAlarm++;
    p.alarm = at;
    return setAlarm(time, options);
  };
  const deleteAlarm = storage.deleteAlarm.bind(storage);
  storage.deleteAlarm = (options) => {
    alarm("deleteAlarm");
    p.alarm = null;
    return deleteAlarm(options);
  };

  const block = state.blockConcurrencyWhile.bind(state);
  state.blockConcurrencyWhile = (fn) => block(() => origin.run("ctor", fn));
}

function drain(p: Profile) {
  const kinds = new Map<number, string>();
  if (p.raw)
    for (const row of p.raw("SELECT id, kind FROM documents").toArray())
      kinds.set(Number(row.id), String(row.kind));
  for (const w of p.pending) {
    const docs = [
      ...new Set(
        w.docs.map((d) =>
          typeof d === "string" ? d : (kinds.get(d) ?? `#${d}`),
        ),
      ),
    ].sort();
    const t = count(p, {
      phase: w.phase,
      origin: w.origin,
      op: "sql",
      table: docs.length ? `${w.table}{${docs.join(",")}}` : w.table,
      statement: w.statement,
    });
    t.rowsWritten += w.cursor.rowsWritten;
    t.rowsRead += w.cursor.rowsRead;
  }
  p.pending = [];
  const tallies = [...p.tallies.values()];
  p.tallies.clear();
  const alarms = p.alarms;
  p.alarms = [];
  return { tallies, alarms };
}

export function markPhase(id: string, phase: string) {
  profileOf(id).phase = phase;
}

export class ProfiledReview extends Review {
  constructor(state: DurableObjectState, env: Env) {
    instrument(state);
    super(state, env);
  }

  override start(target: Target) {
    return origin.run("start", () => super.start(target));
  }

  override view() {
    return origin.run("view", () => super.view());
  }

  override alarm() {
    return origin.run("alarm", () => super.alarm());
  }

  fireAlarm() {
    return this.alarm();
  }

  probe() {
    return origin.run("probe", () => super.view());
  }

  drain() {
    return drain(profileOf(this.ctx.id.toString()));
  }

  async storedAlarm() {
    return this.ctx.storage.getAlarm();
  }

  evict() {
    this.ctx.abort("profile eviction");
  }
}

const BASE = "b".repeat(40);
const FILES = [
  {
    filename: "src/cache.ts",
    status: "modified",
    additions: 4,
    deletions: 1,
    patch:
      "@@ -1,3 +1,6 @@\n export function get(key: string) {\n-  return store[key];\n+  const value = store[key];\n+  if (value === undefined) return fetchRemote(key);\n+  return value;\n }",
  },
  {
    filename: "src/remote.ts",
    status: "added",
    additions: 3,
    deletions: 0,
    patch:
      "@@ -0,0 +1,3 @@\n+export async function fetchRemote(key: string) {\n+  return (await fetch(`/kv/${key}`)).json();\n+}",
  },
];

const fixture = {
  requests: {} as Record<string, number>,
  unexpected: [] as string[],

  hangTurn: null as number | null,
  hung: false,
};

function hit(kind: string) {
  fixture.requests[kind] = (fixture.requests[kind] ?? 0) + 1;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown };

function script(turn: number): Block[] {
  switch (turn) {
    case 0:
      return [
        { type: "text", text: "Reading the change." },
        { type: "tool_use", name: "pr_overview", input: {} },
      ];
    case 1:
      return FILES.map((f) => ({
        type: "tool_use",
        name: "read_patch",
        input: { path: f.filename },
      }));
    case 2:
      return [
        {
          type: "tool_use",
          name: "codemode",
          input: {
            code: "const a = await tools.mcp__docs__search({ query: 'fetch json error handling' });\nconst b = await tools.mcp__docs__search({ query: 'undefined index access' });\nreturn [a, b].join('\\n');",
          },
        },
      ];
    case 3:
      return [
        {
          type: "tool_use",
          name: "describe_change",
          input: {
            title: "Fetch missing cache entries remotely",
            tags: ["cache"],
            summary: "Adds a remote fallback and fetch helper for cache misses.",
            files: FILES.map((f) => f.filename),
          },
        },
        {
          type: "tool_use",
          name: "report_finding",
          input: {
            path: "src/remote.ts",
            line: 2,
            severity: "medium",
            class: "reliability",
            confidence: "verified",
            title: "Remote errors are parsed as JSON",
            body: "fetchRemote never checks res.ok.",
          },
        },
        {
          type: "tool_use",
          name: "report_finding",
          input: {
            path: "src/cache.ts",
            line: 3,
            severity: "low",
            class: "maintainability",
            confidence: "likely",
            title: "Cache miss is not stored",
            body: "Every miss refetches.",
            source: "oxlint",
          },
        },
      ];
    default:
      return [
        {
          type: "tool_use",
          name: "finish_review",
          input: {
            summary: "Two findings in the remote fallback.",
            not_checked: ["Runtime behaviour."],
          },
        },
      ];
  }
}

function anthropic(turn: number, model: string): Response {
  const blocks = script(turn);
  const events: { type: string }[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${turn}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2000, output_tokens: 1 },
      },
    } as { type: string },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        } as { type: string },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        } as { type: string },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: `toolu_${turn}_${index}`,
            name: block.name,
            input: {},
          },
        } as { type: string },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        } as { type: string },
      );
    }
    events.push({ type: "content_block_stop", index } as { type: string });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 200 },
    } as { type: string },
    { type: "message_stop" },
  );
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
};

function mcp(body: Rpc): Response {
  if (body.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: unknown) =>
    Response.json({ jsonrpc: "2.0", id: body.id, result });
  if (body.method === "initialize")
    return reply({
      protocolVersion:
        (body.params as { protocolVersion?: string })?.protocolVersion ??
        "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "docs-fixture", version: "1.0.0" },
    });
  if (body.method === "tools/list")
    return reply({
      tools: [
        {
          name: "search",
          description: "Search fixture documentation.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });
  if (body.method === "tools/call") {
    hit("mcp.call");
    return reply({
      content: [
        {
          type: "text",
          text: "Fixture docs: check Response.ok before json().",
        },
      ],
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: body.method },
  });
}

async function offline(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  if (url.hostname === "rubric.invalid") {
    hit("rubric");
    return new Response("# Fixture rubric\nPrefer simple code.\n");
  }
  if (url.hostname === "scanner.invalid" && path === "/scan") {
    hit("scanner");
    const { checks } = (await request.json()) as {
      checks: { tool: string; paths: string[] }[];
    };
    return Response.json(
      checks.map((c) => ({
        tool: c.tool,
        version: "fixture",
        status: "ok",
        durationMs: 1,
        paths: c.paths,
        diagnostics: [
          {
            tool: c.tool,
            rule: "no-unused-vars",
            severity: "warning",
            path: c.paths[0],
            line: 1,
            message: "fixture diagnostic",
            url: null,
          },
        ],
        error: null,
      })),
    );
  }
  if (url.hostname === "docs.invalid") {
    hit("mcp");
    if (request.method !== "POST") return new Response(null, { status: 405 });
    return mcp((await request.json()) as Rpc);
  }
  if (url.hostname === "api.anthropic.com" && path === "/v1/messages") {
    const body = (await request.json()) as {
      model: string;
      messages: unknown[];
    };
    const answered = [
      ...JSON.stringify(body.messages).matchAll(
        /"tool_use_id":"toolu_(\d+)_\d+"/g,
      ),
    ];
    const turn = answered.length
      ? Math.max(...answered.map((m) => Number(m[1]))) + 1
      : 0;
    hit("model");
    if (fixture.hangTurn === turn && !fixture.hung) {
      fixture.hung = true;
      return new Promise<Response>(() => {});
    }
    return anthropic(turn, body.model);
  }
  if (url.hostname === "api.github.com") {
    hit("github");
    const m = /^\/repos\/fixture\/demo\/(.*)$/.exec(path);
    const rest = m?.[1] ?? "";
    if (rest.startsWith("compare/")) return Response.json({ files: FILES });
    if (rest === "pulls/1") {
      return Response.json({
        title: "Fall back to remote fetch on cache miss",
        body: "Implements REQ-1.",
        user: { login: "agent" },
        base: { ref: "main", sha: BASE },
        head: { ref: "feature", sha: currentHead },
      });
    }
    if (rest.startsWith("git/commits/"))
      return Response.json({ sha: rest.slice("git/commits/".length) });
    if (rest === "contents/CODING_STANDARDS.md")
      return new Response("not found", { status: 404 });
    if (rest.endsWith("/check-runs"))
      return Response.json({ total_count: 0, check_runs: [] });
    if (rest.endsWith("/statuses")) return Response.json([]);
    if (rest.startsWith("contents/"))
      return new Response(
        "export const store: Record<string, unknown> = {};\n",
      );
  }
  fixture.unexpected.push(`${request.method} ${request.url}`);
  return new Response("offline fixture has no route\n", { status: 599 });
}

let currentHead = "";
const events: Record<string, unknown>[] = [];
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const event = args[0];
  if (
    args.length === 1 &&
    typeof event === "object" &&
    event !== null &&
    "objectId" in event &&
    typeof event.objectId === "string"
  ) {
    events.push({
      phase: profiles.get(event.objectId)?.phase ?? "unmarked",
      ...event,
    });
    return;
  }
  log(...args);
};
globalThis.fetch = offline as typeof fetch;

type Profiled = DurableObjectNamespace<ProfiledReview>;

export default {
  async fetch(
    request: Request,
    env: Env & { REVIEWS: Profiled },
  ): Promise<Response> {
    const url = new URL(request.url);
    const [, scope, action, head] = url.pathname.split("/");
    if (scope === "fixture") {
      if (action === "hang") {
        fixture.hangTurn = Number(url.searchParams.get("turn"));
        fixture.hung = false;
      }
      if (action === "events") return Response.json(events.splice(0));
      if (action === "reset") {
        events.length = 0;
        fixture.requests = {};
        fixture.unexpected = [];
        fixture.hangTurn = null;
        fixture.hung = false;
      }
      return Response.json(fixture);
    }
    if (scope !== "review" || !/^[0-9a-f]{40}$/.test(head ?? ""))
      return new Response("not found\n", { status: 404 });
    const target: Target = {
      mode: "manual",
      owner: "fixture",
      repo: "demo",
      number: 1,
      headSha: head,
      baseSha: BASE,
    };
    currentHead = head;
    const name = `manual:fixture/demo#1@${head}`;
    const stub = env.REVIEWS.getByName(name);
    const phase = url.searchParams.get("phase");
    if (phase) markPhase(env.REVIEWS.idFromName(name).toString(), phase);
    try {
      switch (action) {
        case "start":
          await stub.start(target);
          return Response.json(null);
        case "view":
          return Response.json(await stub.view());
        case "probe":
          return Response.json(await stub.probe());
        case "alarm":
          await stub.fireAlarm();
          return Response.json(null);
        case "stored-alarm":
          return Response.json(await stub.storedAlarm());
        case "drain":
          return Response.json(await stub.drain());
        case "evict":
          await stub.evict().catch(() => {});
          return Response.json(null);
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
    return new Response("not found\n", { status: 404 });
  },
};
