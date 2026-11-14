// The reviewer's reading-plan policy: how abridge_file records or refuses a
// plan, how many attempts a file gets, and when finish_review insists that
// files be shortened. reading.ts compiles plans; this module decides what the
// review document keeps.

import {
  compileReadingPlan,
  keptLine,
  own,
  type ReadingPlan,
  readingText,
} from "./reading";
import type { ReviewState } from "./reviewer";

/** abridge_file refusals per file before it takes no more plans for it. */
export const MAX_READING_REFUSALS = 2;
// Once is enough to catch a skipped step; the review then finishes, and the
// owner sees those files' full diffs.
const MAX_READING_GATE_REFUSALS = 1;
// The preview abridge_file returns to the agent is capped, like any tool output.
const MAX_READING_PREVIEW_CHARS = 8_000;

/**
 * Checks one file's plan and records it in the review document, or refuses it.
 * The reply is what the agent reads. Mutates `state` inside the caller's commit.
 */
export function recordReadingPlan(
  state: ReviewState,
  path: string,
  plan: ReadingPlan,
): { reply: string; refused: boolean } {
  const refuse = (reply: string) => ({ reply, refused: true });
  const file = (state.files ?? []).find((f) => f.path === path);
  if (!file)
    return refuse(
      `Not recorded. ${path} is not a changed file in this review; use paths exactly as pr_overview lists them.`,
    );
  if (!file.patch)
    return refuse(
      `Not recorded. ${path} has no stored diff (binary or over the size cap), so there is nothing to shorten.`,
    );
  const refusals = state.readingRefusals ?? {};
  const count = own(refusals, path) ?? 0;
  // What the owner sees once no more plans are taken for this file.
  const fallback = own(state.readings, path)
    ? "the owner sees the last plan you recorded for it"
    : "the owner sees its full diff";
  if (count >= MAX_READING_REFUSALS)
    return refuse(
      `Not recorded: no more attempts for ${path}; ${fallback}. Move on.`,
    );

  const cited = state.findings
    .filter((f) => f.path === path && f.line !== null)
    .map((f) => f.line!);
  const result = compileReadingPlan(file.patch, plan, {
    path,
    protectedLines: cited,
  });
  if (!result.ok) {
    state.readingRefusals = { ...refusals, [path]: count + 1 };
    const problems = `\n- ${result.problems.join("\n- ")}`;
    return refuse(
      count + 1 < MAX_READING_REFUSALS
        ? `Not recorded. Fix every problem and call abridge_file again with the complete plan:${problems}`
        : `Not recorded, and no more attempts for ${path}; ${fallback}. Move on. Problems:${problems}`,
    );
  }
  state.readings = { ...state.readings, [path]: plan };
  const preview = readingText(result.rows);
  return {
    refused: false,
    reply: `recorded: ${keptLine(result.stats)}\n\n${
      preview.length > MAX_READING_PREVIEW_CHARS
        ? `${preview.slice(0, MAX_READING_PREVIEW_CHARS)}\n... (preview truncated)`
        : preview
    }`,
  };
}

/**
 * Changed files the agent could still shorten for the owner: a stored diff,
 * no reading plan yet, and abridge_file attempts left.
 */
export function unabridgedFiles(state: ReviewState): string[] {
  return (state.files ?? [])
    .filter(
      (f) =>
        f.patch !== null &&
        !own(state.readings, f.path) &&
        (own(state.readingRefusals, f.path) ?? 0) < MAX_READING_REFUSALS,
    )
    .map((f) => f.path);
}

/**
 * finish_review's reading check: the refusal to send while files can still
 * be shortened, at most once per review, or null to let the review finish.
 * Mutates `state` inside the caller's commit.
 */
export function readingGateRefusal(state: ReviewState): string | null {
  const unabridged = unabridgedFiles(state);
  const refusals = state.readingGateRefusals ?? 0;
  if (!unabridged.length || refusals >= MAX_READING_GATE_REFUSALS) return null;
  state.readingGateRefusals = refusals + 1;
  return `Not finished: these changed files have no reading view for the owner: ${unabridged.join(", ")}. For each, read it with read_patch (numbered: true) and call abridge_file (protocol step 9), then call finish_review again. A file with nothing to hide still needs a plan: submit empty remove, fold and replace arrays.`;
}
