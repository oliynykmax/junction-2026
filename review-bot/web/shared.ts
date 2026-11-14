// Types and helpers shared by the review page's components.

import {
  blocks,
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

export const location = (f: { path: string; line: number | null }) =>
  f.path + (f.line ? `:${f.line}` : "");
