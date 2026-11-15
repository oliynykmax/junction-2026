# Four supplied sample reviews

These reruns use the four original supplied agent-written commits on our own fork. Opening fresh PRs starts fresh webhook reviews without modifying the supplied code. Requirement IDs refer to the upstream issues, not to generated checker IDs.

This ledger is a timestamped observation. Follow each report for its current state. A running or failed review is not a completed check. Findings, reproduction verdicts, and receipt text are agent-reported. Human confirmation is recorded separately.

Refresh from the repository root with `python3 scripts/capture-challenge-reviews.py`. The script reads the four public APIs and rewrites only this ledger and its JSON snapshots. It does not start reviews, modify PRs, or sign decisions.

| Requirement | Sample PR | Pinned report | Captured state | Candidate findings | Receipt outcomes | Human sign-off |
|---|---|---|---|---|---|---|
| [#2283](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2283) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/13) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/13?sha=9df83c38409c8bfad0517aebffe48211eda4a5b4) | running | 2 | None recorded yet | Not recorded |
| [#2234](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2234) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/14) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/14?sha=9007cee1163c4a274fd60c3cc20c21ae63622786) | running | 0 | None recorded yet | Not recorded |
| [#2129](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2129) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/15) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/15?sha=083afd994c1c9a994cb2cd5aa0b6ad805a621457) | running | 0 | None recorded yet | Not recorded |
| [#2297](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2297) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/16) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/16?sha=a0aa5ab2de7f5a669d97e37184a89034c1de82b6) | running | 1 | None recorded yet | Not recorded |

## Commit and evidence register

### Requirement #2283

- Original head: `9df83c38409c8bfad0517aebffe48211eda4a5b4`.
- Captured: 2026-11-15T07:54:37.148467+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: medium.
- Verifier state: blind.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/13/9df83c38409c8bfad0517aebffe48211eda4a5b4) and [captured evidence](evidence/issue-2283.json).

### Requirement #2234

- Original head: `9007cee1163c4a274fd60c3cc20c21ae63622786`.
- Captured: 2026-11-15T07:54:37.090293+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: medium.
- Verifier state: not recorded.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/14/9007cee1163c4a274fd60c3cc20c21ae63622786) and [captured evidence](evidence/issue-2234.json).

### Requirement #2129

- Original head: `083afd994c1c9a994cb2cd5aa0b6ad805a621457`.
- Captured: 2026-11-15T07:54:37.171948+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: high.
- Verifier state: not recorded.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/15/083afd994c1c9a994cb2cd5aa0b6ad805a621457) and [captured evidence](evidence/issue-2129.json).

### Requirement #2297

- Original head: `a0aa5ab2de7f5a669d97e37184a89034c1de82b6`.
- Captured: 2026-11-15T07:54:37.122049+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: high.
- Verifier state: blind.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/16/a0aa5ab2de7f5a669d97e37184a89034c1de82b6) and [captured evidence](evidence/issue-2297.json).


## Interpretation

No human sign-off means no recorded human acceptance. Candidate counts do not establish precision or recall. Scope gaps, scanner failures, and verifier abstentions stay visible in each report and snapshot. Empty findings while running do not mean the change is clean.

The [#2283 walkthrough](walkthrough-2283.md) separates historical local checks from these new runs. The [measurement plan](measurement.md) states the outcome data still needed before claiming safer or faster review.
