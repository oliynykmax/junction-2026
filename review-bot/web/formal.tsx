import type { VerificationReceipt } from "../src/formal";

type DemoScenario = "passed" | "counterexample" | "not-run" | "all";

const OUTCOME = {
  passed: {
    label: "Reported pass",
    note: "Agent reports no violation in the stated scope.",
  },
  counterexample: {
    label: "Counterexample",
    note: "Agent reports a path that breaks the property.",
  },
  not_run: {
    label: "Not verified",
    note: "This is a verification plan, not a checker result.",
  },
} as const;

export function VerificationReceipts({
  receipts,
  running,
}: {
  receipts: readonly VerificationReceipt[] | undefined;
  running: boolean;
}) {
  if (receipts?.length === 0 && !running) return null;
  if (receipts === undefined) return null;
  return (
    <section class="verification" aria-labelledby="verification-h">
      <div class="verification-heading">
        <div>
          <p class="verification-kicker">Verification receipts</p>
          <h2 id="verification-h">What the reviewer reports</h2>
        </div>
        <p class="verification-count">
          {receipts.length} {receipts.length === 1 ? "claim" : "claims"}
        </p>
      </div>
      <p class="verification-disclosure">
        Agent-reported evidence. The runtime checks receipt completeness, not
        checker execution or result authenticity.
      </p>
      {receipts.length ? (
        <ol class="verification-list">
          {receipts.map((receipt) => (
            <li key={receipt.id}>
              <VerificationReceiptCard receipt={receipt} />
            </li>
          ))}
        </ol>
      ) : (
        <p class="verification-empty">
          {running
            ? "Every changed file needs a verification receipt or explicit unrun disposition before the review can finish."
            : "No additional verification receipts. Linked evidence appears with its finding."}
        </p>
      )}
    </section>
  );
}

export function VerificationReceiptCard({
  receipt,
  embedded = false,
}: {
  receipt: VerificationReceipt;
  embedded?: boolean;
}) {
  const outcome = OUTCOME[receipt.outcome];
  return (
    <div
      class={`verification-receipt outcome-${receipt.outcome}${embedded ? " inline-verification" : ""}`}
    >
      <div class="verification-state">
        <p>{outcome.label}</p>
        <span>{outcome.note}</span>
      </div>
      <div class="verification-main">
        <p class="verification-target">{receipt.target}</p>
        <h3>{receipt.property}</h3>
        <p class="verification-harm">
          <span>Why it matters</span>
          {receipt.harm}
        </p>
      </div>
      <dl class="verification-proof">
        <div>
          <dt>
            {receipt.outcome === "not_run"
              ? "Planned checker"
              : "Reported checker"}
          </dt>
          <dd>
            {receipt.method} · {receipt.checker}
          </dd>
        </div>
        <div>
          <dt>Command</dt>
          <dd>
            <code>{receipt.command}</code>
          </dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>{receipt.result}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{receipt.scope}</dd>
        </div>
        {receipt.fixCheck && (
          <div>
            <dt>
              Fix check {receipt.fixCheck.outcome} on scratch copy, same
              reproducer
            </dt>
            <dd>
              <code>{receipt.fixCheck.command}</code>
            </dd>
            <dd>Before fix: {receipt.fixCheck.before}</dd>
            <dd>After fix: {receipt.fixCheck.after}</dd>
          </div>
        )}
        {receipt.brokenVariant && (
          <div class="verification-mutation">
            <dt>Reported mutation result</dt>
            <dd>{receipt.brokenVariant}</dd>
          </div>
        )}
      </dl>
      {embedded && (
        <p class="verification-disclosure">
          Agent-reported evidence. The runtime checks structure, not checker
          execution or result authenticity.
        </p>
      )}
      <details class="verification-limits">
        <summary>Assumptions &amp; limits</summary>
        <div>
          <p>
            <strong>Assumes</strong> {receipt.assumptions.join(" · ")}
          </p>
          <p>
            <strong>Does not cover</strong> {receipt.limits.join(" · ")}
          </p>
          <p>
            <strong>Files</strong> {receipt.files.join(" · ")}
          </p>
        </div>
      </details>
    </div>
  );
}

const DEMOS: Record<Exclude<DemoScenario, "all">, VerificationReceipt> = {
  passed: {
    id: "demo-passed",
    files: ["src/reviews/cache.ts", "tests/reviews/cache.test.ts"],
    target: "review cache key",
    property:
      "A review read for one pull-request head cannot be returned for a different head.",
    harm: "A human could accept evidence produced for older code.",
    method: "TLA+",
    checker: "TLC 2.19.0",
    command: "java -cp tla2tools.jar tlc2.TLC CacheScope.tla",
    outcome: "passed",
    result: "312 states explored; no stale-head read found.",
    scope: "Two PRs, three head commits each, all read/write interleavings.",
    brokenVariant:
      "Replacing the (PR, head) key with PR alone produces a stale-head trace in 4 steps.",
    assumptions: [
      "The cache write is atomic.",
      "A head SHA uniquely names code.",
    ],
    limits: [
      "Does not model storage eviction.",
      "Does not prove the Worker implementation.",
    ],
  },
  counterexample: {
    id: "demo-counterexample",
    files: ["src/review.ts"],
    target: "review publication state machine",
    property:
      "A verdict is published only for the head commit that the agent reviewed.",
    harm: "A bot comment could make a later, unreviewed commit look reviewed.",
    method: "TLA+",
    checker: "TLC 2.19.0",
    command: "java -cp tla2tools.jar tlc2.TLC PublishHead.tla",
    outcome: "counterexample",
    result:
      "Counterexample: review A starts → head B arrives → A finishes → A is published on B.",
    scope: "One PR, two heads, one delayed reviewer and one publisher.",
    brokenVariant: null,
    assumptions: ["GitHub delivers the second push before A publishes."],
    limits: [
      "Trace is a model, not a production incident.",
      "No GitHub API failures modeled.",
    ],
  },
  "not-run": {
    id: "demo-not-run",
    files: ["src/ledger.ts"],
    target: "ledger append ordering",
    property:
      "A completed review has one terminal ledger entry after its evidence is committed.",
    harm: "The operations view could report a completed review with misleading evidence.",
    method: "Dafny",
    checker: "Dafny 4.10",
    command: "dafny verify verification/LedgerReceipt.dfy",
    outcome: "not_run",
    result:
      "Not run: pinned toolchain setup failed; no checker result was produced.",
    scope: "Planned proof over the receipt transition only.",
    brokenVariant: null,
    assumptions: ["The durable store provides transactional commits."],
    limits: [
      "No checker result exists.",
      "Does not establish crash recovery or storage behavior.",
    ],
  },
};

/** Synthetic layouts for the walkthrough: passed, failed, and deliberately absent proof. */
export function FormalDemo({ scenario }: { scenario: string | null }) {
  const selected: DemoScenario =
    scenario === "passed" ||
    scenario === "counterexample" ||
    scenario === "not-run" ||
    scenario === "all"
      ? scenario
      : "all";
  const receipts =
    selected === "all" ? Object.values(DEMOS) : [DEMOS[selected]];
  return (
    <main class="formal-demo page">
      <header class="formal-demo-header">
        <p>synthetic walkthrough · no production result</p>
        <h1>Verification, readable at a glance.</h1>
        <p>
          Every state keeps the same question visible: what precise property was
          checked, by which tool, and where does its promise stop?
        </p>
      </header>
      <nav class="formal-demo-tabs" aria-label="Verification receipt mockups">
        {(
          [
            ["all", "All states"],
            ["passed", "Reported pass"],
            ["counterexample", "Counterexample"],
            ["not-run", "Not verified"],
          ] as const
        ).map(([key, label]) => (
          <a
            href={`?formal-demo=${key}`}
            aria-current={selected === key ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <VerificationReceipts receipts={receipts} running={false} />
      <p class="formal-demo-owner">
        The receipt informs the named owner; it never approves the pull request
        for them.
      </p>
    </main>
  );
}
