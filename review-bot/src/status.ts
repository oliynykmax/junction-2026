import type { RunFailure } from "@earendil-works/pi-durable";
import type { ReviewState } from "./reviewer";

export type RunStatus =
  "not_started" | "scanning" | "running" | "done" | "failed";

/** Why a run failed, as a fixed class. Failure text is never stored or shown. */
export type FailureClass =
  "model_error" | "no_finish" | "scanner" | "github" | "aborted" | "other";

type Failure = Pick<RunFailure, "reason" | "detail">;

export function reviewStatus(
  review: Pick<ReviewState, "target" | "verdict" | "scan">,
  failure: Failure | null,
  activeTasks: number,
): RunStatus {
  if (!review.target) return "not_started";
  if (review.verdict) return "done";
  if (failure) return "failed";
  if (review.scan?.status === "pending") return "scanning";
  return activeTasks > 0 ? "running" : "failed";
}

const GITHUB_DETAIL = /^(GET|POST|PUT|PATCH|DELETE) \/|^installation token ->/;

export function failureClass(failure: Failure | null): FailureClass {
  if (!failure) return "no_finish";
  switch (failure.reason) {
    case "model_error":
    case "no_model":
      return "model_error";
    case "aborted":
    case "reset":
      return "aborted";
    case "turn_limit":
    case "nothing_to_answer":
      return "no_finish";
    default: {
      const detail = failure.detail ?? "";
      if (detail.startsWith("scanner ->")) return "scanner";
      if (GITHUB_DETAIL.test(detail)) return "github";
      return "other";
    }
  }
}
