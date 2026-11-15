// The stored review document, shared by the reviewer and the verifier it
// starts. Its shape is ReviewState in reviewer.ts.

import { defineDoc } from "@earendil-works/pi-durable";
import type { Base } from "./evidence";
import type { ReviewState, Target } from "./reviewer";

export function pinnedBase(t: Target): Base | undefined {
  return t.mode === "manual"
    ? { owner: t.owner, repo: t.repo, sha: t.baseSha }
    : t.base;
}

export const EMPTY_REVIEW: ReviewState = {
  target: null,
  prompt: null,
  model: null,
  startedAt: null,
  scan: null,
  evidence: null,
  findings: [],
  verdict: null,
  lookups: [],
  docsRefusals: 0,
  files: [],
  changes: [],
  changeRefusals: 0,
  summaryRefusals: 0,
  verifications: [],
  reads: 0,
  readings: {},
  readingRefusals: {},
  readingGateRefusals: 0,
};

export const ReviewDoc = defineDoc<ReviewState>({
  kind: "review.state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => structuredClone(EMPTY_REVIEW),
  checkpointWhen: () => false,
});
