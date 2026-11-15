# Human review and trust policy

This policy distinguishes current mechanisms from proposed team practice. It does not claim a measured safety improvement.

## Current risk routing

The implementation computes rules from changed paths and patches, outside the model. Each report exposes the reasons and affected files. See [signals.ts](../../review-bot/src/signals.ts).

| Tier | Existing guidance | Examples |
|---|---|---|
| Low | Read the summary and evidence. A full diff read is optional. | Documentation-only changes or no matching risk rule. |
| Medium | Read flagged files in full and spot-check another change. | Source generators, public API declarations, dependencies, large changes, absent patches, or production changes without test changes. |
| High | Read flagged files in full before accepting. | Serializer core, unsafe memory, security-related paths, workflows, or weakened tests. |

These are heuristics. A low tier is not evidence of safety. An owner raises review depth when intent, consequences, or missing evidence demand it. If risk crosses file boundaries, read the complete relevant flow or diff.

## Current owner receipt

GitHub authentication identifies the signer. Repository write access and the current PR head are checked. The owner records their own checks, remaining gaps, residual risk, and a reason for accepting or dismissing each blocker. Sign-off belongs to that commit. Manual public reviews cannot be signed. See [sign-off implementation](../../review-bot/src/signoff.ts).

The intended named owner for the reference walkthrough is Maksym Oliinyk, GitHub `oliynykmax`. Naming the owner here is not a signature or acceptance. Only the owner's recorded decision establishes that.

## Proposed spot-check and withdrawal practice

1. Start each code area in probation. Require full human review until the team has useful local evidence of reviewer quality.
2. For every medium-risk decision, check the flagged files and one additional change. For low-risk decisions, audit at least one complete low-risk PR in each batch of five. These are pilot policy choices, not validated thresholds.
3. Record confirmed findings, rejected claims, missed defects, review time, escapes, reverts, and the area affected. Keep unknown outcomes unknown.
4. After a missed material defect or misleading evidence, withdraw light-review eligibility for the affected area. Read affected changes in full, reproduce the miss, and add a check that catches it.
5. Restore lighter review only through a named maintainer's documented decision after reviewing the repaired check and subsequent spot-checks. No global trust score transfers trust between areas.

A dashboard of reviews, tokens, or tool calls cannot establish reviewer quality. We need outcomes and human adjudication.

## Technology considerations

- **Frontend.** Keep findings, checker outcomes, risk reasons, scope limits, and the exact commit visible. Label synthetic examples. A green visual state must not imply human acceptance.
- **Backend.** Pin base and head, snapshot CI, preserve evidence and sign-off, and treat a new head as a new review. Durable execution helps finish work but does not establish correctness.
- **Security.** Untrusted repository text cannot authorize tools or change base-pinned standards. Agent execution uses separate containers. Network-capable agents and unauthenticated checker claims remain limits. Never send private or uncleared code into the public demo.
- **Scale.** Apply cheap deterministic checks first, reuse reports only for the same commit, and focus expensive execution on consequential behavior. Measure latency and cost alongside defect outcomes. The four sample runs do not establish production scale.
