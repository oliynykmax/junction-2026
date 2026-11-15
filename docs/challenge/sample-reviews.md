# Four supplied sample reviews

These reruns use the four original supplied agent-written commits on our own fork. Opening fresh PRs starts fresh webhook reviews without modifying the supplied code. Requirement IDs refer to the upstream issues, not to generated checker IDs.

This ledger is a timestamped observation. Follow each report for its current state. A running or failed review is not a completed check. Findings, reproduction verdicts, and receipt text are agent-reported. Human confirmation is recorded separately.

Refresh from the repository root with `python3 scripts/capture-challenge-reviews.py`. The script reads the four public APIs and rewrites only this ledger and its JSON snapshots. It does not start reviews, modify PRs, or sign decisions.

| Requirement | Sample PR | Pinned report | Captured state | Candidate findings | Receipt outcomes | Human sign-off |
|---|---|---|---|---|---|---|
| [#2283](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2283) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/13) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/13?sha=9df83c38409c8bfad0517aebffe48211eda4a5b4) | running | 2 | not_run: 2 | Not recorded |
| [#2234](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2234) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/14) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/14?sha=9007cee1163c4a274fd60c3cc20c21ae63622786) | running | 5 | None recorded yet | Not recorded |
| [#2129](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2129) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/15) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/15?sha=083afd994c1c9a994cb2cd5aa0b6ad805a621457) | running | 0 | None recorded yet | Not recorded |
| [#2297](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2297) | [PR](https://github.com/oliynykmax/junction26-messagepack-csharp/pull/16) | [Review](https://review.oliinyk.dev/r/oliynykmax/junction26-messagepack-csharp/16?sha=a0aa5ab2de7f5a669d97e37184a89034c1de82b6) | done | 1 | not_run: 2 | Not recorded |

## Commit and evidence register

### Requirement #2283

- Original head: `9df83c38409c8bfad0517aebffe48211eda4a5b4`.
- Captured: 2026-11-15T07:56:50.671896+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: medium.
- Verifier state: done.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/13/9df83c38409c8bfad0517aebffe48211eda4a5b4) and [captured evidence](evidence/issue-2283.json).

Candidate findings and verifier dispositions:

- Catch-all diagnostic filter hides the real rule and also drops location-less diagnostics for source types. Severity medium; confidence likely; verifier not_checked.
  Verifier note: Not run: no container was available (executor capacity errors on every checkout), so I could not test whether the ReportIfLocatedInCompilation filter drops Location.None diagnostics.
- Changed reporting branches lack tests; helper hand-builds a second compilation pipeline. Severity medium; confidence likely; verifier not_checked.
  Verifier note: Not run: no container was available, so I could not mutate the changed reporting branches to check whether the new tests catch them.

Verifier summary:

Nothing was verified: every checkout/shell call failed with "executor capacity reached", so nothing was built or run. My blind check was off-target: unable to open the issue, I guessed #2283 was the Unity .meta issue, but the change is a TypeCollector fix for MsgPack004 diagnostics on referenced-assembly generic types. All changed files have not_run receipts and both findings are unchecked. Next step: run dotnet test on MessagePack.SourceGenerator.Tests at the head.

### Requirement #2234

- Original head: `9007cee1163c4a274fd60c3cc20c21ae63622786`.
- Captured: 2026-11-15T07:56:50.634899+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: medium.
- Verifier state: blind.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/14/9007cee1163c4a274fd60c3cc20c21ae63622786) and [captured evidence](evidence/issue-2234.json).

Candidate findings and verifier dispositions:

- Change fixes duplicate/mixed-key analyzer crashes for all types, not the #2234 suppression regression it claims. Severity medium; confidence likely; verifier pending.
- Duplicate-key handling is a copy-pasted double lookup in four places, when one if/else per key kind would do. Severity medium; confidence verified; verifier pending.
- The field-loop changes and the string-first mixed-key path have no tests. Severity medium; confidence verified; verifier pending.
- The mixed-key `continue` also skips recursive collection of the member's type. Severity low; confidence verified; verifier pending.
- SA1649: the first type in the file is not the type the file is named after. Severity low; confidence verified; verifier pending.

### Requirement #2129

- Original head: `083afd994c1c9a994cb2cd5aa0b6ad805a621457`.
- Captured: 2026-11-15T07:56:50.667910+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: high.
- Verifier state: not recorded.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/15/083afd994c1c9a994cb2cd5aa0b6ad805a621457) and [captured evidence](evidence/issue-2129.json).

### Requirement #2297

- Original head: `a0aa5ab2de7f5a669d97e37184a89034c1de82b6`.
- Captured: 2026-11-15T07:56:50.684076+00:00.
- Model: `anthropic/claude-opus-5-5 thinking=medium`.
- Risk tier: high.
- Verifier state: done.
- [Public API](https://review.oliinyk.dev/api/r/oliynykmax/junction26-messagepack-csharp/16/a0aa5ab2de7f5a669d97e37184a89034c1de82b6) and [captured evidence](evidence/issue-2297.json).

Candidate findings and verifier dispositions:

- The `#if !NETSTANDARD2_0 && !NETFRAMEWORK` guard isn't needed and drops the feature for netstandard2.0 and .NET Framework consumers. Severity medium; confidence likely; verifier not_checked.
  Verifier note: I could not run the reproducer (compile generated code against netstandard2.0/net472 with the attribute unguarded) because every checkout failed with executor capacity errors, and the Microsoft Learn docs tool was also unavailable to confirm the API page.

Verifier summary:

Nothing was executed. Every checkout attempt, more than 40 before and after save_checks, failed with "executor capacity reached", so no shell command could run. I saved two blind checks without seeing the base: a scan that every generated formatter/resolver class in the snapshots has [ExcludeFromCodeCoverage], and a grep that the generator sources emit the attribute. Neither ran at the base or the head. Both receipts are not_run, covering every changed file. The PR's claim that generated code gets the attribute is unverified by execution.

Recorded AI verdict:

```json
{
  "decision": "no_blockers_found",
  "star": {
    "situation": "Formatters and resolvers emitted by the MessagePack source generator counted toward consumers' code-coverage reports and skewed them (issue #2297).",
    "task": "The PR aims to mark all generated formatter and resolver types so coverage tools ignore them.",
    "action": "Each T4 template (formatter, string-key, enum, union, resolver with its FormatterCache/GetFormatterHelper, composite resolver) and its generated .cs now emits `[global::System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]` inside `#if !NETSTANDARD2_0 && !NETFRAMEWORK`, and TransformUtilities now writes a newline after a constrained nesting type's opening brace so the directive starts a line.",
    "result": "Consumers on modern .NET targets get generated code excluded from coverage, but netstandard2.0 and .NET Framework consumers do not; the PR carries a new CodeCoverageExclusionTests class, about 220 refreshed snapshot files and a README note."
  },
  "summary": "I found one medium issue and no blockers. The diff is mostly mechanical and consistent: every template has a matching .tt/.cs edit and refreshed snapshots, and the TransformUtilities brace change is needed so the `#if` starts its own line. The problem is the premise behind the `#if !NETSTANDARD2_0 && !NETFRAMEWORK` guard. ExcludeFromCodeCoverageAttribute is available on netstandard2.0 and .NET Framework 4.0+ and can be placed on classes. The guard therefore withholds the fix from those consumers, makes the README text wrong, and repeats a 3-line preprocessor block 13 times. Removing the guard would shrink every site to one line. The verifier ran nothing and left the finding unchecked, because of executor capacity errors. The PR text says no code changes were added for this rerun, which matches the single commit. No CI ran on the head.",
  "notChecked": [
    "CI snapshot for a0aa5ab2de7f5a669d97e37184a89034c1de82b6: none. This is not proof that required checks passed.",
    "No CODING_STANDARDS.md exists at the pinned base commit; only the review rubric applies.",
    "Scanners did not run (scanner service returned 500).",
    "No shell execution: checkout_pr kept failing with 'session busy', so I could not build the generator, run the snapshot tests or CodeCoverageExclusionTests, or compile generated output against netstandard2.0/net472.",
    "The netstandard2.0 availability of ExcludeFromCodeCoverageAttribute rests on the Learn API page rendered for the netstandard-2.0 moniker; I could not read the page's 'Applies to' table, and no compile check confirmed it.",
    "I read the ~220 snapshot files only in the brief's representative diffs and their stat lines, not one by one.",
    "Neither I nor the verifier ran anything, and the verifier left the finding unchecked."
  ],
  "dismissed": []
}
```


## Interpretation

No human sign-off means no recorded human acceptance. Candidate counts do not establish precision or recall. Scope gaps, scanner failures, and verifier abstentions stay visible in each report and snapshot. Empty findings while running do not mean the change is clean.

The [#2283 walkthrough](walkthrough-2283.md) separates historical local checks from these new runs. The [measurement plan](measurement.md) states the outcome data still needed before claiming safer or faster review.
