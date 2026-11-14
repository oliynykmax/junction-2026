---
name: verify-pr-change
description: "Verify changed behavior with mandatory per-file dispositions alongside docs, code and tests. Resolve candidate findings with targeted execution and explain reason, evidence and fix."
---

# Verify changed behavior and candidate findings

Use this workflow alongside the review rubric. Every changed file needs a
formal-verification-style receipt or explicit unrun disposition. Group related
files. Attempt a meaningful practical check for risky changed behavior even
when docs, tests or code reasoning also support it. Harmless nonbehavior files
may have grouped not_run dispositions explaining why checking is not applicable.
The finish gate requires full coverage without a retry bypass.

Also resolve specific suspected defects that lack enough evidence. Direct code
reasoning, relevant pinned documentation, existing tests or scanner output can
establish a finding without documentation or an expensive model check. Missing
docs alone never suppresses a locally reproduced defect. Verification supplements
these sources rather than replacing them with a single reason.

## State the question

Read repository instructions and identify the pinned base and head from the PR
metadata. Inspect the candidate's code path, callers and existing evidence.
State the suspected wrong behavior, triggering input or ordering, concrete harm,
and expected behavior. Ground external API/version-contract expectations in
relevant pinned official documentation where needed. Missing documentation alone
does not suppress a locally reproduced behavior defect.

## Run the smallest useful check

Use checkout_pr and shell on the pinned head. Prefer a small real-code
reproducer, property test or existing targeted test. For an ordering problem,
a faithful TLA+ state model may answer the question. Source-level tools such as
Kani, CBMC, Gobra, Verus, Dafny, Nagini or Frama-C fit only where the language
and property match. Avoid a rewrite that changes the behavior under test.

Install only the relevant chosen tool if needed. Attempt its setup before
claiming it is unavailable. The bundled scripts/provision-verifiers.sh is an
optional multi-engine benchmark installer. It provisions several engines and
can be expensive. Do not require it or provision all engines for each PR.
Use an existing suitable tool or install the selected engine directly instead.
Record versions, setup commands and actual setup failures honestly.

Keep generated harnesses, models and dependencies outside the reviewed checkout.
Use a scratch copy when building the repository would change its files. Record
the pinned head, exact rerun command, observed output, cases/bounds and scope.
For a model, map transitions and atomic steps to source locations. State the
translation assumptions and omissions. A model result verifies that abstraction
within its bounds, never the implementation merely because names match.

## Interpret the result

- A reproduced failing behavior supports the candidate only if the expected
  behavior is grounded and the failure reaches the real code or faithful model.
  Explain the input or trace in code terms.
- A passing check clears only the tested scope. Do not turn it into a bug or
  claim that the whole PR is correct. For a claimed pass, demonstrate a
  meaningful controlled broken variant rejected by the same check on a scratch
  copy. Otherwise disclose the missing fault-sensitivity check.
- A check that cannot run is not_run. State attempted setup or execution and
  the smallest next step. Keep it in not_checked or a possible hypothesis.
  Never call an unrun check verified.

## Test a feasible proposed fix

Give every finding a concrete proposed fix. When a specific fix is feasible,
run the SAME reproducer on the pinned head and a scratch copy with that fix.
Capture fail-before/pass-after output, the exact command and changed scope.
If the proposed fix still fails, report that failed outcome and keep it proposed.
If the fix cannot be tested, say why and label it proposed. Never silently
apply, publish or commit a fix to the reviewed PR. Remove scratch artifacts
and confirm the reviewed checkout stays clean.

## Record evidence for the owner

Use report_finding with a focused defect body, reason/impact, evidence basis
and proposed fix. Existing evidence uses kind code, docs, test or scanner and
precise locations, pinned links or command/output details.

For new execution evidence, call record_verification with target, property,
harm, method, checker/version, command, outcome/result, scope, assumptions and
limits. Use counterexample for the observed failure, passed only for cleared
scope, and not_run for an unexecuted check. Add fix_check only when the same
reproducer ran before and after the proposed fix. Record its explicit passed
or failed outcome; an unrun fix remains proposed without fix_check. This is separate from a
broken_variant, which tests the checker itself.

Link a relevant returned ID with evidence.verification_id to one finding.
Execution evidence requires a counterexample. Other evidence kinds may link a
receipt alongside code, docs and tests. Use evidence.supporting for additional
concrete sources or reasons. A not_run record cannot substantiate verified
confidence. Hypothesis evidence requires possible confidence. A receipt link alone
never raises confidence. Explain the reason, evidence and fix together so the
named owner can assess the advice. The runtime validates the structure of
agent-reported evidence, not execution authenticity. The human owns approval.
