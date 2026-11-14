# Finding evidence and mandatory verification

2026-11-14. Revision starts at `49b030bd03d28a80d07c3c2ca7e3382166dc02ca`
on `feat/formal-receipts-integrated`. The earlier integration and PR #45 shell
and base-fetch behavior are preserved.

## Shape sketch and choice

Two small shapes were considered before implementation.

1. Nest the complete verification receipt in each finding. This puts the data
   together, but duplicates the existing record tool's payload when a finding
   is reported and introduces two editable versions of checker evidence.
2. Keep immutable verification records and put a record ID in the finding's
   evidence. Reuse the existing receipt schema and resolve the ID for display.

The second shape is selected. Each new finding owns a concise reason/impact,
evidence basis and proposed fix. Its body describes the defect. The primary
basis can be code, docs, existing test output, scanner output, new execution,
or an explicit hypothesis. Supporting evidence strings allow multiple reasons
without another finding body or mutually exclusive sources.

A linked receipt must exist, cover the finding path and belong to no other
finding. Records are append-only by tool-call ID. Recording another check for
the same target never replaces a linked record. The API resolves the reference
for display, without storing a second receipt inside the finding.

## Mandatory coverage retained

The user's latest correction retains formal-verification-style checking
alongside docs, tests and code reasoning. Every changed file still needs a
receipt or explicit unrun disposition before finish_review can store a verdict.
The original uncoveredVerificationFiles helper and mandatory refusal are
unchanged. There is no retry bypass, including reviews with zero findings.
Legacy reviews without a captured file list retain their existing behavior.

The prompt, review rubric wrapper and bundled verify-pr-change skill require
meaningful practical checks for risky changed behavior, even when existing
evidence supports it. Related files can share a receipt. Harmless nonbehavior
files can have grouped not_run/nonapplicable dispositions with concrete reasons.

A candidate without sufficient evidence gets the smallest real-code reproducer,
property test or suitable model check on the pinned head. Missing docs alone
never suppresses locally reproduced defects or requires an expensive formal
check for an obvious defect. External API and version-contract expectations
remain grounded in relevant pinned docs where needed.

The multi-engine benchmark installer is unchanged and optional. The agent must
attempt setup of the chosen relevant tool before claiming it unavailable.
Provisioning every engine on each PR is not required.

## Finding evidence and fixes

report_finding rejects missing, blank or oversized reason, evidence and fix.
Legacy stored findings still render their body and retain their original grading.
Severity and decision rules are unchanged.

An execution finding requires a linked counterexample. A passed record clears
only its stated scope and cannot establish a bug. Other evidence bases can link
a relevant pass alongside their own concrete reasoning. A not_run link cannot
substantiate verified confidence. Hypothesis evidence requires possible
confidence, so a severe unconfirmed hypothesis remains visible without blocking.
A link alone never promotes confidence.

For feasible specific fixes, instructions require the same reproducer to fail
on the reviewed head and pass on a scratch copy with the proposed fix. Optional
fix_check records keep command, before, after and explicit passed/failed fix
outcome separate from broken_variant,
which tests the checker itself. fix_check requires a counterexample record.
The UI labels fixes without such evidence as proposed and untested. A failed
fix check stays a proposed fix with its failure visible. A passed fix check is
reported as tested on a scratch copy, never applied to the PR.

Linked evidence appears with the finding's reason and fix. Unlinked changed-file
receipts remain in the verification panel. Assumptions and limits expand on
demand. Embedded receipts have their own theme variables and a single-column
layout so they do not depend on the outer panel or its width.

## Observed checks

Commands ran from review-bot/ with Bun `1.4.4-canary.1`, revision `b1305ddc7`,
using the existing bun.lock.

- bun install --frozen-lockfile succeeded without lockfile changes.
- bun test passed 252 tests across 24 files with zero failures and 916 assertions.
- The focused changes/formal/installation suite passed 36 tests with 244 assertions.
- bun scripts/verify-finding-evidence.mjs passed all three scratch mutations.
- bunx tsc --noEmit, bun run lint and bun fmt --check passed.
- bun run build and bun run celld:prepare passed.
- CELLD_ESBUILD=./node_modules/.bin/esbuild celld deploy celld.json --dry-run
  --bucket s3://ci-build-only bundled the Worker and assets. CellD reported
  a dry run with nothing written. Nothing was deployed or uploaded.
- git diff --check passed. No README, benchmark, executor or base-fetch files changed.

The bounded coverage test invokes the real finish_review tool for all four
receipt subsets of a two-file review. Additional real-tool tests cover repeated
missing-coverage completion attempts, empty/oversized finding fields, several
supporting sources, unknown/wrong-path/cross-finding references, execution
confidence, hypotheses and append-only records. Rendering tests cover legacy
findings, reason/evidence/fix, tested versus proposed fixes, and outcome/limits
and result-authenticity disclosures.

The scratch script copies current source/tests, runs passing baselines, disables
one boundary, requires an assertion failure, restores the source and reruns the
same passing check. It catches removal of the mandatory coverage refusal,
removal of required finding-field validation, and acceptance of a passing
receipt as evidence for an execution finding. It never edits the reviewed
checkout, and removes its temporary directory in finally.

Initial test invocations from the repository root could not resolve the Preact
JSX runtime and TypeScript configuration. All reported successful checks ran
from review-bot/. An early mutation-script run hit a missing-field TypeError
rather than an assertion after the guard was disabled. The test cases were
ordered to exercise the blank-field assertion first, then all three controlled
variants passed the required fail-before/pass-after validation.

## Limits and handoff

This is bounded testing of the actual tools with an in-memory transaction
harness, not a formal proof. It does not establish concurrent Durable Object
transactions, restart persistence, arbitrary inputs or all termination paths.
A model result verifies its stated abstraction under disclosed translation
assumptions and bounds, not source code merely because it names source functions.

Receipt contents, fix results and confidence are agent-reported. The runtime
validates structure, associations and dispositions, not checker execution or
result authenticity. It still uses one reviewer agent that writes its own
verification evidence. No independent runtime verification agent, orchestration
change, trust/probation mechanism or permanent regression-test PR was added.
The named human remains accountable for the merge.

No external verifier installation, live model review or public deployment ran.
The implementation checks covered rendered markup and a production build.
The Vite landing build still emits its existing inlineDynamicImports deprecation
warning and succeeds.

## Parent review and layout correction

A fresh Codex GPT-6.1 Sol reviewer independently ran the full 252-test suite,
three controlled variants, type checking, lint and formatting. It found one
reproducible layout defect. Embedded receipts declared one grid column, but
their limits section retained placement in column two. Chromium created an
implicit second column and compressed the checker output in a narrow panel.

The parent reproduced the defect using the actual VerificationReceiptCard and
repository stylesheet at a 1280px viewport inside a 400px container. Setting
the embedded limits section to grid-column 1 / -1 restored one column.
The corrected component has one column and no horizontal overflow for 400px
and 700px containers at a 1280px viewport, and a 350px container at a 390px
viewport. The parent inspected a screenshot with assumptions and limits open.
This checks the component layout, not a deployed live-page interaction.

The parent also reran the 36 focused tests and all three controlled variants.
After the CSS correction and removal of eleven narration comment lines, the
nine rendering and skill-installation tests, formatting and production build
passed. The retained Kani/rustup comment explains an external tool dependency.

Claude and DeepSeek review attempts failed on usage limits and supplied no
completed review. The completed review used a fresh Codex agent, the same model
family as implementation. No cross-family review or merge-ready claim is made.
The separate runtime verifier discussed with the user remains a follow-up.
