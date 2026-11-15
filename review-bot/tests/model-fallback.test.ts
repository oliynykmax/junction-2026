import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { fallBack } from "../src/model-fallback";
import type { ModelChoice } from "../src/review";
import { ReviewDoc } from "../src/reviewer";

const MODELS: ModelChoice[] = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "verda", id: "kimi-k3-1-pro" },
];

const failed = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "529 overloaded",
  });

async function review(script: {
  anthropic: FauxResponseStep[];
  verda: FauxResponseStep[];
  maxTurns?: number;
}) {
  const anthropic = fauxProvider({
    api: "faux-anthropic",
    provider: "anthropic",
    models: [{ id: "claude-opus-5-5" }],
  });
  const verda = fauxProvider({
    api: "faux-verda",
    provider: "verda",
    models: [{ id: "kimi-k3-1-pro" }],
  });
  anthropic.setResponses(script.anthropic);
  verda.setResponses(script.verda);
  const models = createModels();
  models.setProvider(anthropic.provider);
  models.setProvider(verda.provider);

  let scans = 0;
  const scan = defineTool({
    name: "scan",
    description: "Runs the scanners.",
    parameters: obj({}),
    execute: async () => {
      scans += 1;
      return { output: [{ type: "text" as const, text: "no alerts" }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "review", tools: [scan] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { retry: { maxRetries: 0 }, afterFailedRun: "withdraw" },
    },
    ctx,
  );
  const root = await harness.root(ctx, {
    agent: {
      model: { provider: MODELS[0]!.provider, modelId: MODELS[0]!.id },
      maxTurns: script.maxTurns ?? 80,
    },
  });
  await root.commit(async (tx) => {
    (await tx.doc(ReviewDoc, root.id)).target = {
      owner: "o",
      repo: "r",
      number: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      installationId: 1,
    };
  }, ctx);
  await (
    await root.submit({ type: "input", content: "Review it." }, ctx)
  ).wait(ctx);

  const fall = async () => {
    const next = await fallBack(root, MODELS, "medium", ctx);
    await root.waitForIdle(ctx);
    return next;
  };
  const state = async () => ({
    model: (await harness.snapshot(AgentDoc, root.id, ctx))?.model,
    failure:
      (await harness.snapshot(LiveDoc, root.id, ctx))?.runFailure?.reason ??
      null,
    label: (await harness.snapshot(ReviewDoc, root.id, ctx))?.model,
  });
  return {
    fall,
    state,
    scans: () => scans,
    calls: () => ({
      anthropic: anthropic.state.callCount,
      verda: verda.state.callCount,
    }),
  };
}

test("a review Opus answers never touches Kimi", async () => {
  const r = await review({
    anthropic: [fauxAssistantMessage("No blockers found.")],
    verda: [],
  });
  expect(await r.fall()).toBeNull();
  expect(r.calls()).toEqual({ anthropic: 1, verda: 0 });
  expect((await r.state()).model).toEqual({
    provider: "anthropic",
    modelId: "claude-opus-5-5",
  });
});

test("an Opus failure continues on Kimi without rerunning finished tool calls", async () => {
  let sawScan = false;
  const r = await review({
    anthropic: [
      fauxAssistantMessage(fauxToolCall("scan", {}), { stopReason: "toolUse" }),
      failed(),
    ],
    verda: [
      (context) => {
        sawScan = context.messages.some(
          (m) => m.role === "toolResult" && m.toolName === "scan",
        );
        return fauxAssistantMessage("No blockers found.");
      },
    ],
  });
  expect((await r.state()).failure).toBe("model_error");
  expect(r.scans()).toBe(1);

  expect(await r.fall()).toEqual({ provider: "verda", id: "kimi-k3-1-pro" });
  expect(r.calls()).toEqual({ anthropic: 2, verda: 1 });
  expect(r.scans()).toBe(1);
  expect(sawScan).toBe(true);
  expect(await r.state()).toEqual({
    model: { provider: "verda", modelId: "kimi-k3-1-pro" },
    failure: null,
    label: "verda/kimi-k3-1-pro thinking=medium",
  });

  expect(await r.fall()).toBeNull();
  expect(r.calls()).toEqual({ anthropic: 2, verda: 1 });
});

test("a Kimi failure after the fallback ends the review instead of cycling back to Opus", async () => {
  const r = await review({ anthropic: [failed()], verda: [failed()] });
  expect(await r.fall()).toEqual({ provider: "verda", id: "kimi-k3-1-pro" });
  expect((await r.state()).failure).toBe("model_error");

  expect(await r.fall()).toBeNull();
  expect(r.calls()).toEqual({ anthropic: 1, verda: 1 });
  expect((await r.state()).model).toEqual({
    provider: "verda",
    modelId: "kimi-k3-1-pro",
  });
});

test("a turn limit does not send the review to Kimi", async () => {
  const r = await review({
    anthropic: [
      fauxAssistantMessage(fauxToolCall("scan", {}), { stopReason: "toolUse" }),
    ],
    verda: [],
    maxTurns: 1,
  });
  expect((await r.state()).failure).not.toBeNull();
  expect(await r.fall()).toBeNull();
  expect(r.calls()).toEqual({ anthropic: 1, verda: 0 });
});

test("queued recovery attempts start only one Kimi continuation", async () => {
  const r = await review({
    anthropic: [failed()],
    verda: [fauxAssistantMessage("No blockers found.")],
  });
  const attempts = await Promise.all([r.fall(), r.fall(), r.fall()]);
  expect(attempts.filter((model) => model !== null)).toEqual([
    { provider: "verda", id: "kimi-k3-1-pro" },
  ]);
  expect(r.calls()).toEqual({ anthropic: 1, verda: 1 });
  expect((await r.state()).failure).toBeNull();
});
