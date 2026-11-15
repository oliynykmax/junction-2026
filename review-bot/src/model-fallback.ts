import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  type Conversation,
  LiveDoc,
  type RunFailureReason,
} from "@earendil-works/pi-durable";
import type { ModelChoice } from "./review";
import { ReviewDoc } from "./reviewer";

// The failures another provider can recover from. A turn limit, an abort or a
// crash loop is the review's own outcome and stays failed.
const PROVIDER_FAILURES: ReadonlySet<RunFailureReason> = new Set([
  "model_error",
  "no_model",
]);

export function modelLabel(
  model: ModelChoice,
  thinking: ModelThinkingLevel,
): string {
  return `${model.provider}/${model.id} thinking=${thinking}`;
}

/**
 * When the review run failed on its model, moves the review to the next entry
 * of `models` and continues the run on its transcript, so finished tool calls
 * are not run again. One commit decides, switches and continues, so a repeat
 * or a crash finds either nothing to do or the continued run. Returns the
 * model it switched to, or null when there is nothing to fall back to.
 */
export function fallBack(
  root: Conversation,
  models: readonly ModelChoice[],
  thinking: ModelThinkingLevel,
  context: Context,
): Promise<ModelChoice | null> {
  return root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, root.id);
    const failure = live.runFailure?.reason;
    if (live.run || !failure || !PROVIDER_FAILURES.has(failure)) return null;
    const review = await tx.doc(ReviewDoc, root.id);
    if (!review.target || review.verdict) return null;
    const current = (await tx.doc(AgentDoc, root.id)).model;
    const at = models.findIndex(
      (m) => m.provider === current?.provider && m.id === current.modelId,
    );
    const next = at < 0 ? undefined : models[at + 1];
    if (!next) return null;
    await root.submit(tx, {
      type: "continue",
      requestId: `fallback:${next.provider}/${next.id}`,
    });
    await configure(tx, root.id, {
      model: { provider: next.provider, modelId: next.id },
    });
    review.model = modelLabel(next, thinking);
    return next;
  }, context);
}
