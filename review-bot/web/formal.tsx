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

export function VerificationReceipts({
  receipts,
  verifier,
  running,
}: {
  receipts: readonly VerificationReceipt[] | undefined;
  verifier?: VerifierState;
  running: boolean;
}) {
  if (receipts === undefined) return null;
  if (receipts.length === 0 && !verifier && !running) return null;
  // Reviews from before the verifier existed hold reviewer-written receipts.
  const independent = verifier !== undefined;
  return (
    <section class="verification" aria-labelledby="verification-h">
      <div class="verification-heading">
        <div>
          <p class="verification-kicker">
            {independent
              ? "Independent verifier · separate agent and container"
              : "Verification receipts"}
          </p>
          <h2 id="verification-h">
            {independent
              ? "What the verifier reports"
              : "What the reviewer reports"}
          </h2>
        </div>
        <p class="verification-count">
          {receipts.length} {receipts.length === 1 ? "receipt" : "receipts"}
        </p>
      </div>
      <p class="verification-disclosure">
        {independent
          ? "Written by the verifier, a second agent that did not write the findings. "
          : ""}
        Agent-reported evidence. The runtime checks receipt completeness, not
        checker execution or result authenticity.
      </p>
      {verifier && <p class="verifier-status">{verifierLine(verifier)}</p>}
      {verifier && verifier.status !== "blind" && (
        <BlindChecks checks={verifier.checks} />
      )}
      {receipts.length ? (
        <ol class="verification-list">
          {receipts.map((receipt) => (
            <li key={receipt.id} id={receiptAnchor(receipt.id)}>
              <VerificationReceiptCard receipt={receipt} />
            </li>
          ))}
        </ol>
      ) : (
        <p class="verification-empty">
          {running
            ? "Every changed file needs a verification receipt or explicit unrun disposition before the review can finish."
            : "No verification receipts were recorded."}
        </p>
      )}
    </section>
  );
}

const receiptAnchor = (id: string) =>
  `receipt-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function verifierLine(verifier: VerifierState): string {
  switch (verifier.status) {
    case "blind":
      return "Writing checks from the stated requirements. The change is not on its disk yet.";
    case "verifying":
      return "Running its checks at the head and trying to reproduce each finding.";
    case "done":
      return verifier.summary;
    case "failed":
      return `Stopped before it finished: ${verifier.error}`;
  }
}

/** The checks the verifier saved while only the base commit was on disk. */
function BlindChecks({
  checks,
}: {
  checks: readonly RequirementCheck[];
}) {
  return (
    <div class="blind-checks">
      <h3>Checks written before seeing the change</h3>
      <p class="blind-checks-note">
        From the title, description and commit messages, with only the base
        commit checked out. Saved before the diff and findings were shown.
      </p>
      {checks.length ? (
        <ol>
          {checks.map((check) => (
            <li key={check.id}>
              <p>{check.requirement}</p>
              <details>
                <summary>
                  <code>{check.path}</code>
                </summary>
                <pre>{check.content}</pre>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p class="blind-checks-note">
          The verifier found no stated requirement it could check.
        </p>
      )}
    </div>
  );
}

const VERDICT_LABEL = {
  reproduced: "Reproduced by verifier",
  not_reproduced: "Not reproduced by verifier",
  not_checked: "Not checked by verifier",
} as const;

/** The verifier's verdict on one finding, linked to the receipt behind it. */
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

export function VerificationReceiptCard({
  receipt,
}: {
  receipt: VerificationReceipt;
}) {
  const outcome = OUTCOME[receipt.outcome];
  return (
    <div class={`verification-receipt outcome-${receipt.outcome}`}>
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
