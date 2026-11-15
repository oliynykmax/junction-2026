# Measuring earned trust

## What we have measured

The [sample ledger](sample-reviews.md) captures four fresh runs of the original sponsor changes. It records the reviewed head, workflow state, findings, verifier dispositions, receipt outcomes, risk tier, and whether a human signed. These are observed system outputs, not independently confirmed defect counts.

The [historical #2283 experiment](evidence/2283-historical-checks.md) supplies a concrete positive check, a preserved-behavior regression, and a controlled broken variant. It demonstrates the value of checking more than build success for this case. It does not establish aggregate reviewer accuracy.

## What we cannot yet claim

We have no controlled before-and-after measurement of human review time, comprehensive ground truth for the four PRs, or longitudinal incident and revert history. We cannot report recall, a safe reduction in reading time, or a production safety improvement. Candidate counts are not confirmed bugs. A verifier's reproduction is evidence to inspect, not an independent human label.

## Pilot measurement protocol

For each exact commit, a human records requirement IDs, code area, risk reasons, candidate findings, confirmed findings, dismissed claims with reasons, missed defects, unchecked scope, and their decision. Time the owner's evidence review and required code reading. Compare with a separate full-read review of the same change by another engineer, while disclosing order and familiarity effects.

Track these outcomes over later changes:

- Finding precision: human-confirmed findings divided by human-adjudicated findings. Keep unresolved findings outside the denominator and report them separately.
- Misses: defects found by human spot-checks or later incidents that the reviewer did not identify. Recall requires a sufficiently complete ground-truth set and is otherwise unknown.
- Human review time and time to merge, with risk tier and change size retained for comparison.
- Fraction of changes routed to full human review, plus actual reading performed.
- Escapes, reverts, and incidents by area after acceptance. A miss triggers the [withdrawal policy](review-policy.md).
- Review completion, checker failures, latency, and cost as operational measures. These do not replace defect outcomes.

Success means review time falls without worse defect outcomes in comparable risk groups. Four sample PRs are a demonstration, not enough data to establish that result.
