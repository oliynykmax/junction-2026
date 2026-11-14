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

// A missing confidence (legacy data) counts as confirmed, so old severe
// findings keep blocking.
export const blocks = (f: Graded) =>
  SEVERE.has(f.severity) && f.confidence !== "possible";

// A severe finding the agent could not confirm: shown, but it does not
// change the decision.
export const heldBack = (f: Graded) => SEVERE.has(f.severity) && !blocks(f);

export const decisionFor = (findings: readonly Graded[]) =>
  findings.some(blocks) ? "changes_requested" : "no_blockers_found";

// Reviews stored before this scale used blocker/major/minor and had no class
// or confidence, so a stored finding is graded only after this boundary.
const LEGACY: Record<string, Severity> = {
  blocker: "critical",
  major: "high",
  minor: "low",
};

const isSeverity = (s: string): s is Severity =>
  (SEVERITIES as readonly string[]).includes(s);

export type Stored<F> = Omit<F, "severity" | "class" | "confidence"> & {
  severity: Severity;
  class?: FindingClass;
  confidence?: Confidence;
};

export function fromStored<F extends { severity: string }>(f: F): Stored<F> {
  if (isSeverity(f.severity)) return { ...f, severity: f.severity };
  const legacy = LEGACY[f.severity];
  if (legacy) return { ...f, severity: legacy };
  console.warn(`unknown stored severity ${JSON.stringify(f.severity)}`);
  return { ...f, severity: "info" };
}
