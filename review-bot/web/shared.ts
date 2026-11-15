// Types and helpers shared by the review page's components.

import {
  blocks,
  type Confidence,
  CONFIDENCES,
  SEVERITIES,
  type Severity,
} from "../src/findings";
import type { ReviewView } from "../src/review";
import type { Change, ChangedFile } from "../src/reviewer";

export type { Change, ChangedFile };
export type Finding = ReviewView["review"]["findings"][number];
export type LineUrl = (path: string, line: number | null) => string;

/** A line the owner selected to look at: a finding's location in the diff. */
export type Focus = { path: string; line: number; findingId: string } | null;

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Red marks exactly the findings that make the advice "changes requested":
 * critical or high, rated verified or likely. Anything red therefore agrees
 * with the advice at the top of the page.
 */
export const isBlocking = (f: Finding) => blocks(f);

export const QUIET: ReadonlySet<Severity> = new Set(["low", "info"]);

/** What each severity means, as the reviewer agent's protocol defines it. */
export const SEVERITY_MEANING: Record<Severity, string> = {
  critical:
    "Exploitable vulnerability, data loss or corruption, or an outage on a normal path.",
  high: "A real bug or security hole on a reachable path, or a breaking change to a public contract with no migration.",
  medium:
    "A likely bug in an edge case, or a design problem that will cost real work later.",
  low: "A local quality issue such as naming, duplication or a missing guard on an unlikely path.",
  info: "An observation or question with no action required.",
};

/** What each confidence means, as the reviewer agent's protocol defines it. */
export const CONFIDENCE_MEANING: Record<Confidence, string> = {
  verified:
    "The AI read the code path and can point at the lines that prove it.",
  likely:
    "The code the AI read strongly suggests it, but some context is unread.",
  possible: "A suspicion for you to check.",
};

export const BLOCKING_RULE =
  "Only critical or high findings rated verified or likely block, meaning the AI would ask for changes.";

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      CONFIDENCES.indexOf(a.confidence ?? "verified") -
        CONFIDENCES.indexOf(b.confidence ?? "verified") ||
      String(a.class ?? "").localeCompare(String(b.class ?? "")),
  );
}

/** Non-zero finding counts by severity, most severe first, with how many block. */
export function severityCounts(findings: readonly Finding[]) {
  return SEVERITIES.map((s) => {
    const of = findings.filter((f) => f.severity === s);
    return {
      severity: s,
      count: of.length,
      blocking: of.filter(blocks).length,
    };
  }).filter((c) => c.count > 0);
}

/** The change's sentence, falling back to the one older reviews stored. */
export const changeSentence = (c: Change): string | null =>
  c.summary?.trim() || c.action?.trim() || null;

export const location = (f: { path: string; line: number | null }) =>
  f.path + (f.line ? `:${f.line}` : "");
