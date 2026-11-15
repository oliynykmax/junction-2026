import type { VerificationReceipt } from "../src/formal";
import type { ViewedVerdict } from "../src/review";
import type { RequirementCheck, VerifierState } from "../src/verifier";

type DemoScenario = "passed" | "counterexample" | "not-run" | "all";

const OUTCOME = {
  passed: {
    label: "Reported pass",
    note: "No violation reported in the stated scope.",
  },
  counterexample: {
    label: "Counterexample",
    note: "A reported path that breaks the property.",
  },
  not_run: {
    label: "Not verified",
    note: "This is a verification plan, not a checker result.",
  },
} as const;

export const RECEIPT_DISCLOSURE =
  "Verifier results are agent-reported. The runtime checks receipt completeness, not checker execution or result authenticity.";

export function verifierLine(verifier: VerifierState): string {
  switch (verifier.status) {
    case "blind":
      return "The verifier is writing checks from the stated requirements. The change is not on its disk yet.";
    case "verifying":
      return "The verifier is running its checks at the head and trying to reproduce each finding.";
    case "done":
      return verifier.summary;
    case "failed":
      return `The verifier stopped before it finished: ${verifier.error}`;
  }
}

const receiptAnchor = (id: string) =>
  `receipt-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const VERDICT_LABEL = {
  reproduced: "Reproduced by verifier",
  not_reproduced: "Not reproduced by verifier",
  not_checked: "Not checked by verifier",
} as const;

/** The verifier's verdict as a short link to the finding's verifier step. */
export function VerdictBadge({ verdict }: { verdict: ViewedVerdict }) {
  const label = VERDICT_LABEL[verdict.verdict];
  const className = `verdict verdict-${verdict.verdict}`;
  return verdict.receiptId ? (
    <a
      class={className}
      href={`#${receiptAnchor(verdict.receiptId)}`}
      title={`${verdict.note} Opens the receipt.`}
    >
      {label}
    </a>
  ) : (
    <span class={className} title={verdict.note}>
      {label}
    </span>
  );
}

/** The verifier's step under a finding: its verdict, note and receipt. */
export function VerdictNode({ verdict }: { verdict: ViewedVerdict }) {
  return (
    <li
      class={`node node-verdict verdict-${verdict.verdict}`}
      id={verdict.receiptId ? receiptAnchor(verdict.receiptId) : undefined}
    >
      <p class="node-label">{VERDICT_LABEL[verdict.verdict]}</p>
      <p class="body">{verdict.note}</p>
      {verdict.receipt && <ReceiptEvidence receipt={verdict.receipt} />}
    </li>
  );
}

/**
 * What the verifier checked without tying it to a finding: the checks it
 * wrote before seeing the change and the receipts no verdict links.
 */
export function VerifierChecks({
  checks,
  receipts,
}: {
  checks: readonly RequirementCheck[];
  receipts: readonly VerificationReceipt[];
}) {
  if (checks.length === 0 && receipts.length === 0) return null;
  return (
    <div class="verifier-checks">
      <h3>Other verifier checks</h3>
      <ol class="trail">
        {checks.map((check) => (
          <li class="node" key={check.id}>
            <p class="node-label">Written before seeing the change</p>
            <p class="body">{check.requirement}</p>
            <details class="node-more">
              <summary>
                <code>{check.path}</code>
              </summary>
              <pre>{check.content}</pre>
            </details>
          </li>
        ))}
        {receipts.map((receipt) => (
          <li class="node" key={receipt.id} id={receiptAnchor(receipt.id)}>
            <p class="node-label">{receipt.target}</p>
            <p class="body">{receipt.property}</p>
            <ReceiptEvidence receipt={receipt} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A receipt as a few lines of text, with its scope and limits folded away. */
function ReceiptEvidence({ receipt }: { receipt: VerificationReceipt }) {
  const outcome = OUTCOME[receipt.outcome];
  return (
    <div class={`receipt outcome-${receipt.outcome}`}>
      <p class="receipt-outcome">
        <strong>{outcome.label}</strong> · {receipt.method} · {receipt.checker}
      </p>
      <p class="body">{receipt.result}</p>
      <code class="receipt-command">{receipt.command}</code>
      {receipt.brokenVariant && (
        <p class="body muted">
          Reported mutation result. {receipt.brokenVariant}
        </p>
      )}
      {receipt.fixCheck && (
        <p class="body muted">
          Fix check {receipt.fixCheck.outcome} on scratch copy, same reproducer.
          Before: {receipt.fixCheck.before} After: {receipt.fixCheck.after}
        </p>
      )}
      <details class="node-more">
        <summary>Scope, assumptions &amp; limits</summary>
        <p>{receipt.scope}</p>
        <p>
          <strong>Assumes</strong> {receipt.assumptions.join(" · ")}
        </p>
        <p>
          <strong>Does not cover</strong> {receipt.limits.join(" · ")}
        </p>
        <p>
          <strong>Files</strong> {receipt.files.join(" · ")}
        </p>
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
      <p class="findings-note">{RECEIPT_DISCLOSURE}</p>
      <VerifierChecks checks={[]} receipts={receipts} />
      <p class="formal-demo-owner">
        The receipt informs the named owner; it never approves the pull request
        for them.
      </p>
    </main>
  );
}
