---
name: verify-review-completion
description: "Check mandatory changed-file verification coverage and finding reason/evidence/fix boundaries through the real review tools, including controlled broken variants."
---

# Verify review completion and finding evidence

Run this skill when changing `review-bot/src/formal.ts`, `report_finding`,
`record_verification`, `finish_review`, or their evidence UI.

## Properties and harm

Every changed file must have a verification receipt or explicit unrun
disposition before finish_review stores a verdict. There is no retry bypass.
A review with zero findings still needs complete file coverage. Legacy reviews
without a captured file list retain their existing behavior.

Every new finding must carry a concise concrete reason, evidence basis and
proposed fix. Multiple supporting sources are allowed. A linked record must
exist, cover the finding path and belong to no other finding. Records are
immutable. Execution evidence needs a counterexample; linking passed or not_run
records cannot promote an execution claim to verified. Hypotheses remain
possible. A not_run link cannot substantiate verified confidence.

These boundaries keep the named owner from mistaking missing or unrun evidence
for checked work. The tool validates agent-reported structure, not authenticity.
A code read, test, scanner result and documentation can also support findings.
Formal-style checking remains mandatory alongside these sources.

## Run the checks

From `review-bot/`, run:

```sh
bun test tests/changes.test.ts tests/formal.test.ts tests/verification-skill.test.ts
bun scripts/verify-finding-evidence.mjs
bun test
bunx tsc --noEmit
bun run lint
bun fmt --check
bun run build
```

`changes.test.ts` calls the actual report_finding, record_verification and
finish_review tools with an in-memory transaction harness. The two-file coverage
test exhausts the empty set, each singleton and complete receipt set. Repeated
completion attempts prove no retry bypass within the tested attempts.

The finding boundary tests reject blank/oversized reason, evidence and fix,
dangling/cross-finding/wrong-path links, and unrun or passing execution evidence.
They accept code, docs, test and scanner evidence with supporting reasons.
They preserve a possible hypothesis without changing the blocking rule.
Additional tests distinguish immutable records and explicit unrun dispositions.

`formal.test.ts` checks receipt outcome disclosures, checker fault sensitivity,
fix_check field boundaries, and rendered legacy/current finding evidence.
Fix checks retain the same command, fail-before, after result and explicit
passed/failed fix outcome separately from a broken_variant used to test the
checker itself. Untested or failing fixes stay proposed.

## Validate controlled broken variants

The script copies the current sources and tests into a temporary directory,
links the installed dependencies, and invokes the same real-tool tests. It runs
a passing baseline, disables one boundary, requires an assertion failure, then
restores the source and reruns the passing check for each mutation:

- Disable the mandatory changed-file coverage refusal.
- Disable report_finding's reason/evidence/fix refusal.
- Allow passed records to substantiate execution findings.

The reviewed checkout is never edited and the scratch directory is removed in
finally. A failure to load a test is not accepted as fault-sensitivity evidence.

## Scope and limits

This is bounded testing of the production tool path, not a formal proof.
It assumes the captured file list is trustworthy and finish_review is the path
that stores a verdict. It does not prove arbitrary-size inputs, concurrent
Durable Object storage behavior, recovery, agent honesty, or the reviewed PR.

The runtime still uses one reviewer agent. It records and reports its own
checker claims. No independent verification agent or result-authentication
boundary is implemented here. A human remains accountable for the merge.

Last verified revision starts at `49b030bd03d28a80d07c3c2ca7e3382166dc02ca`.
See `docs/formal-receipts-verification.md` for the measured revision checks.
