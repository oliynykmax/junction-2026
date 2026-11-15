# Lessons and decisions

Recorded 15 November 2026. These are observed limitations and the resulting decisions, not a claim that every limitation is resolved.

| Observation | Evidence | Decision |
|---|---|---|
| A reviewer suggested `TryAdd` although the target framework did not support it. | Earlier #2234 review, recorded in the event log on 14 November. | Check target versions and documentation or compile advice before accepting it. |
| The reviewer claimed a duplicate-key diagnostic was missing although it was emitted in nearby code. | Earlier #2234 review, recorded in the event log on 14 November. | Treat findings as candidates. Read surrounding control flow and reproduce suspected behavior. |
| The #2283 patch fixed the crash but suppressed a required diagnostic for a reachable user type. | [Historical executable checks](evidence/2283-historical-checks.md). | Pair the positive requirement with preservation properties. A successful build alone is insufficient. |
| A consumer build could look successful despite a missing generated resolver. Compiler mismatch also disrupted checks. | [Historical #2283 environment and results](evidence/2283-historical-checks.md). | Inspect generated behavior and compiler diagnostics, and disclose environment failures separately. |
| One agent originally reported findings and its own verification evidence. | [Two-agent decision record](../two-agent-verification-decisions.md). | Separate claim author from checker author and freeze initial requirement checks before revealing the implementation. |
| A separate agent still reports its own checker results and can reach the network. | [Two-agent limits](../two-agent-verification-decisions.md). | Disclose weak isolation and result authenticity. Do not market two agents as proof of truth. |
| Earlier bot approval semantics could be mistaken for human acceptance. | Current [publication code](../../review-bot/src/github.ts) includes withdrawal of historical bot approvals. | Treat the bot as advice and use a separate named-owner sign-off. |
| Attractive synthetic examples can look like measured evidence. | [Demo fixture](../../review-bot/web/demo.ts). | Keep mock walkthroughs separate from the four real, commit-pinned sample reviews. |

## Fresh rerun limitation, 15 November

The #2297 verifier reported executor-capacity errors, recorded its checks as `not_run`, and left its candidate finding `not_checked`. The review completed with those gaps visible. This is a real abstention example, not evidence that the candidate defect was reproduced. The #2283 rerun also completed. Other run states are captured in the [live sample ledger](sample-reviews.md).

## Decisions for this reference

Use the four original supplied commits on our own fork. Preserve failures and incomplete runs. Use issue #2283 for the detailed walkthrough because it exposes a fix that satisfies one property while breaking another. Keep risk routing separate from confidence. Keep per-area trust withdrawal a stated pilot policy until implemented and evaluated.

The historical #2283 repair remained local after the fork was restored to the sponsor's original change. We do not claim the repair shipped in the sample PR.
