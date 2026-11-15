# Walk through requirement #2283

Use [the real sample review](sample-reviews.md) for MessagePack-CSharp issue #2283. The walkthrough combines a fresh review with separately labelled historical execution evidence. It does not substitute mock receipts for real checks.

## Requirement and commits

[Requirement #2283](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2283) asks the generator and analyzer to handle a closed generic value type from a referenced assembly without crashing and to produce the expected resolver.

- Base commit: `32258fdbee4bcd653c79f51b4376b5103c6f4d27`.
- Original agent-written head: `9df83c38409c8bfad0517aebffe48211eda4a5b4`.
- Fresh rerun: [fork PR #13](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/13).
- [Pinned report](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/13?sha=9df83c38409c8bfad0517aebffe48211eda4a5b4).

The report's live status is authoritative for this rerun. The result ledger records the latest captured status. A failed or unfinished run is not a successful review.

## Show where the trust comes from

1. Open the pinned report and confirm its commit matches the PR. Explain the requirement before showing findings.
2. Inspect risk reasons and changed-file coverage. Source-generator changes can affect consumers outside this repository.
3. Inspect the reviewer's candidate findings and the verifier's verdicts. Open commands, scope, assumptions, limits, and any unrun checks. Do not equate a completed workflow with successful execution.
4. Compare the requirement's positive behavior with the diagnostic-preservation property below. A fix must not suppress diagnostics for invalid user code.
5. Ask the named owner to explain the remaining uncertainty and record their decision. High-risk behavior still requires the prescribed human reading.

## Historical execution evidence, 14 November

The [preserved experiment report](evidence/2283-historical-checks.md) records tests on base, original head, an experimental repair, and a deliberately broken variant. These are historical local measurements, not results of today's rerun.

| Check | Base | Original agent head | Local repair |
|---|---|---|---|
| `2283-F1`: closed metadata generic produces expected output without crash | Fails | Passes | Passes |
| `2283-P1`: reachable invalid user type still reports its diagnostic | Fails | Fails | Passes |
| `2283-P2`: metadata symbols do not produce invalid diagnostic locations | Fails | Passes | Passes |

The original patch's broad diagnostic filter solved the immediate crash but hid MsgPack003 for a user type reached through a metadata generic. The preservation test exposed the regression. The local repair was `8c146e4e8a343b63a63f0a72813deb84b21699a2` and was not retained in the fork's supplied branch.

The historical report includes the test command, SDK and compiler mismatch, test names, controlled mutant, and limitations. Its scratch log paths are temporary. Do not present those paths as durable downloadable evidence or claim the historical experiment was rerun today.

## What the AI must leave to the owner

An absent or failed check cannot establish safety. The AI cannot decide that missing resolver generation is an acceptable product risk, that an ambiguous requirement is complete, or that a local test covers every consumer. A verifier's `not_checked` or receipt's `not_run` is a limit, not approval.

Maksym Oliinyk (`oliynykmax`) is the intended human owner. An example decision would withhold acceptance of the original head until diagnostic preservation is resolved. This document records no human acceptance and performs no merge. The real receipt must name what the owner checked, what remains unchecked, and the residual risk they accept.
