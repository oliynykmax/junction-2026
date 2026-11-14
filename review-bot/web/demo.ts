// A synthetic finished review for ?demo=1&state=verified: the reviewer's
// findings, the verifier's blind checks, its receipts and its verdicts.

import type { ConversationId } from "@earendil-works/pi-durable";
import type { VerificationReceipt } from "../src/formal";
import type { ReviewView } from "../src/review";
import type { RequirementCheck } from "../src/verifier";

const HEAD = "4f1c9e2a7b3d5f60817a2b3c4d5e6f708192a3b4";
const BASE = "9a8b7c6d5e4f30211203f4e5d6c7b8a9f0e1d2c3";
const CACHE = "src/reviews/cache.ts";
const TEST = "tests/reviews/cache.test.ts";

const checks: RequirementCheck[] = [
  {
    id: "call-save/0",
    requirement:
      "A new push to a pull request gets a fresh review instead of the result cached for the previous commit.",
    path: "tests/verifier/fresh-review-per-commit.test.ts",
    content: `import { expect, test } from "bun:test";
import { ReviewCache } from "../../src/reviews/cache";

test("a new head misses the cache", () => {
  const cache = new ReviewCache(8);
  cache.write({ pr: 7, head: "a" }, "review of a");
  expect(cache.read({ pr: 7, head: "b" })).toBeNull();
});`,
  },
  {
    id: "call-save/1",
    requirement:
      "A commit that was already reviewed reuses its stored result instead of starting another review.",
    path: "tests/verifier/known-commit-reuse.test.ts",
    content: `import { expect, test } from "bun:test";
import { ReviewCache } from "../../src/reviews/cache";

test("a known head hits the cache", () => {
  const cache = new ReviewCache(8);
  cache.write({ pr: 7, head: "a" }, "review of a");
  expect(cache.read({ pr: 7, head: "a" })).toBe("review of a");
});`,
  },
];

const receipts: VerificationReceipt[] = [
  {
    id: "call-blind",
    author: "verifier",
    files: [CACHE, TEST],
    target: "ReviewCache.read and write",
    property:
      "The two checks written before the change: a new head misses, a known head hits.",
    harm: "A human could accept a review produced for older code.",
    method: "other",
    checker: "bun test 1.4.4",
    command: "bun test tests/verifier/",
    outcome: "passed",
    result:
      "2 pass at the head. At the base, fresh-review-per-commit failed: the read returned the review of head a.",
    scope: "The primary read path, one pull request, two heads.",
    brokenVariant:
      "Dropping head from keyFor makes fresh-review-per-commit fail again.",
    assumptions: ["Head SHAs are compared as exact strings."],
    limits: ["Covers the primary path only, not readFallback."],
  },
  {
    id: "call-fallback",
    author: "verifier",
    files: [CACHE],
    target: "readFallback(pr, head)",
    property:
      "A fallback read for head b never returns the review stored for head a.",
    harm: "After a cache miss on the primary path, an old review is shown as current.",
    method: "property test",
    checker: "fast-check 3.23 under bun test 1.4.4",
    command: "bun test tests/verifier/fallback-head.test.ts",
    outcome: "counterexample",
    result:
      "Failed after 3 runs. Counterexample: write(pr 7, head a), then readFallback(pr 7, head b) returned the review of head a.",
    scope: "readFallback with up to 3 pull requests and 4 heads each.",
    brokenVariant: null,
    fixCheck: {
      command: "bun test tests/verifier/fallback-head.test.ts",
      before: "Fails: returned the review of head a.",
      after: "Passes 1,000 runs with the suggested keyFor(pr, head) change.",
      outcome: "passed",
    },
    assumptions: ["The fallback store shares the primary key format."],
    limits: ["Does not exercise the Durable Object storage layer."],
  },
  {
    id: "call-eviction",
    author: "verifier",
    files: [CACHE],
    target: "LRU eviction on write",
    property:
      "The entry written last survives the eviction its write triggers.",
    harm: "A review just stored could vanish and be run again, at cost.",
    method: "TLA+",
    checker: "TLC 2.19.0",
    command: "java -cp tla2tools.jar tlc2.TLC -workers 2 CacheEvict.tla",
    outcome: "passed",
    result: "1,204 distinct states explored; no state loses the newest entry.",
    scope:
      "Capacity 1 to 3, up to 5 writes, every interleaving of two writers.",
    brokenVariant:
      "Evicting before inserting produces a trace that loses the newest entry in 3 steps.",
    assumptions: ["Writes to the map are atomic within one request."],
    limits: [
      "A model of the eviction order, not a proof of the TypeScript.",
      "Does not model storage write failures.",
    ],
  },
];

export const VERIFIED_DEMO: ReviewView = {
  status: "done",
  failure: null,
  heldBack: 0,
  activity: [],
  costUsd: 0.42,
  evidenceHtml: "",
  signOff: null,
  review: {
    target: {
      owner: "demo",
      repo: "review-cache",
      number: 42,
      headSha: HEAD,
      mode: "manual",
      baseSha: BASE,
    },
    prompt: null,
    model: "synthetic",
    startedAt: 0,
    scan: { status: "skipped", results: [], error: null },
    evidence: null,
    lookups: [],
    docsRefusals: 0,
    files: [
      {
        path: CACHE,
        status: "modified",
        additions: 15,
        deletions: 4,
        patch: null,
      },
      {
        path: TEST,
        status: "modified",
        additions: 4,
        deletions: 0,
        patch: null,
      },
    ],
    verifications: receipts,
    verifier: {
      status: "done",
      conversationId: 2 as ConversationId,
      checks,
      verdicts: {
        "call-f1": {
          verdict: "reproduced",
          receiptId: "call-fallback",
          note: "A property test wrote head a and read head b through readFallback; it returned the review of head a.",
        },
        "call-f2": {
          verdict: "not_reproduced",
          receiptId: "call-eviction",
          note: "A bounded TLA+ model of the eviction order found no lost entry; the same model catches evict-before-insert.",
        },
        "call-f3": {
          verdict: "not_checked",
          receiptId: null,
          note: "Needs a force-push event, and the test setup has no fake for GitHub pushes.",
        },
      },
      summary:
        "Of the two checks written before seeing the change, one failed at the base and both pass at the head. The fallback-path finding reproduces; the eviction finding does not.",
    },
    verdict: {
      decision: "changes_requested",
      star: {
        situation:
          "Cached reviews were keyed by pull request alone, so a new push could show the review of an earlier commit.",
        task: "Scope every cached review to the commit it reviewed.",
        action:
          "Keys the primary cache by pull request and head commit and adds a test for a new head.",
        result:
          "New pushes miss the primary cache; the pull request adds one test for that path.",
      },
      summary:
        "The primary path now keys by head, but readFallback still keys by pull request alone. The verifier reproduced that and did not reproduce the eviction concern.",
      notChecked: [
        "Force-push to an older head: the test setup has no GitHub push fake.",
      ],
      dismissed: [],
    },
    findings: [
      {
        id: "call-f1",
        path: CACHE,
        line: 41,
        severity: "high",
        class: "correctness",
        confidence: "verified",
        title: "Fallback read still keys by pull request only",
        body: "`readFallback` builds its key from `pr` alone, so after a push the fallback path returns the review stored for the previous head.",
        reason:
          "When the primary entry is evicted, the owner sees an old commit's review as if it covered the new code.",
        evidence: {
          kind: "code",
          detail:
            "cache.ts:41 calls keyFor(pr) while read at cache.ts:27 calls keyFor(pr, head).",
        },
        fix: "Build the fallback key with keyFor(pr, head), as the primary read does.",
        source: "agent",
        suggestedPatch:
          "--- a/src/reviews/cache.ts\n+++ b/src/reviews/cache.ts\n@@ -41 +41 @@\n-    const key = keyFor(pr);\n+    const key = keyFor(pr, head);",
        verdict: {
          verdict: "reproduced",
          receiptId: "call-fallback",
          note: "A property test wrote head a and read head b through readFallback; it returned the review of head a.",
          receipt: receipts[1],
        },
      },
      {
        id: "call-f2",
        path: CACHE,
        line: 58,
        severity: "medium",
        class: "reliability",
        confidence: "likely",
        title: "Eviction may drop the entry just written",
        body: "`write` evicts when the map is full, and the eviction loop reads `size` after the insert, so the new entry may be the one removed.",
        reason: "A review just stored could vanish and be run again.",
        evidence: {
          kind: "code",
          detail: "cache.ts:58 to 63: the eviction loop runs after map.set.",
        },
        fix: "Evict before inserting, or skip the key just written.",
        source: "agent",
        suggestedPatch: null,
        verdict: {
          verdict: "not_reproduced",
          receiptId: "call-eviction",
          note: "A bounded TLA+ model of the eviction order found no lost entry; the same model catches evict-before-insert.",
          receipt: receipts[2],
        },
      },
      {
        id: "call-f3",
        path: TEST,
        line: 12,
        severity: "low",
        class: "testing",
        confidence: "possible",
        title: "No test for a force-push back to an older head",
        body: "The new test covers a push to a new head but not a force-push that returns to a head reviewed earlier.",
        reason:
          "That path reuses a stored review, which is the intended but untested behaviour.",
        evidence: {
          kind: "hypothesis",
          detail: "No test in cache.test.ts writes the same head twice.",
        },
        fix: "Add a test that writes head a, then b, then reads a.",
        source: "agent",
        suggestedPatch: null,
        verdict: {
          verdict: "not_checked",
          receiptId: null,
          note: "Needs a force-push event, and the test setup has no fake for GitHub pushes.",
        },
      },
    ],
  },
};
