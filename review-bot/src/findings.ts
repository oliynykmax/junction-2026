// The grading scale for review findings and the rule that turns findings
// into the advisory decision.

export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CLASSES = [
  "correctness",
  "security",
  "reliability",
  "performance",
  "breaking-change",
  "maintainability",
  "testing",
  "docs",
] as const;
export type FindingClass = (typeof CLASSES)[number];

export const CONFIDENCES = ["verified", "likely", "possible"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

type Graded = { severity: Severity; confidence?: Confidence };

const SEVERE: ReadonlySet<Severity> = new Set(["critical", "high"]);

export const blocks = (f: Graded) =>
  SEVERE.has(f.severity) && f.confidence !== "possible";

// A severe finding the agent could not confirm: shown, but it does not
// change the decision.
export const heldBack = (f: Graded) => SEVERE.has(f.severity) && !blocks(f);

export const decisionFor = (findings: readonly Graded[]) =>
  findings.some(blocks) ? "changes_requested" : "no_blockers_found";

// Reviews stored before the five-level scale used blocker/major/minor.
const LEGACY: Record<string, Severity> = {
  blocker: "critical",
  major: "high",
  minor: "low",
};

export function upgradeSeverity<F extends { severity: string }>(
  f: F,
): F & { severity: Severity } {
  return { ...f, severity: LEGACY[f.severity] ?? (f.severity as Severity) };
}
