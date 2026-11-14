---
name: verify-pr-change
description: "Verify the current pull request's riskiest changed promise with the strongest practical formal or exhaustive check, then report the evidence. Use when an agent is handed a PR and must verify it rather than create a verification skill."
---

# Verify the current PR change

You are here to **run verification for the PR in front of you**. Do not create a
PR or product-code changes. Keep every generated model, harness, and mutation
in a temporary directory outside the worktree unless the PR already includes it.

## Benchmark tool policy

For the current multi-language benchmark, run
`scripts/provision-verifiers.sh` before deciding a tool is unavailable. It
downloads these pinned tools into `J26_FORMAL_TOOLS_DIR` (default:
`/var/tmp/j26-formal-tools`) without changing the repository:

| Changed implementation | Required first check | What a pass means |
| --- | --- | --- |
| Go (`.go`) | **Gobra v26.09** | The annotated `.gobra` copy in the stated scope. It is not a proof of unannotated code or calls outside that scope. |
| Rust (`.rs`) | **Kani 0.68.0** | All behaviors explored by the stated harness bounds. |
| C# (`.cs`) | **.NET bounded property harness**, with **Dafny 4.11.0** only for a named abstraction | The real C# cases in the stated bound; a Dafny result never verifies C# source. |
| TypeScript (`.ts`, `.tsx`) | **TLA+ 1.7.4** for a state/lifecycle property; otherwise a generated real-code harness | A TLA+ model or stated generated cases, never TypeScript source verification. |

This table is a fixed benchmark policy, not a claim that one tool fits every
future PR. If the changed files do not match their repository's headline
language (for example CUE in a Go repository), choose TLA+ only for a faithful
state model; otherwise use a generated real-code harness and label it bounded.

Record the tool version and exact command. Do not say `not_run` merely because
the host started without the tool: provision it, attempt the relevant check,
then state an incompatibility or setup failure plainly.

## Establish the PR scope

1. Read the repository instructions and identify the checked-out head commit.
2. Identify the PR base from its metadata when available. Otherwise compare
   `HEAD` with the merge base against the repository's default remote branch.
   State the exact base and head commits in the result.
3. Read the full diff and the changed code's callers, invariants, tests, and
   configuration. Do not treat unrelated uncommitted work as part of the PR and
   never discard, stash, reset, or edit it.

## Choose one property worth checking

Choose the highest-consequence promise introduced or changed by this PR that
ordinary tests are least likely to expose. Start with any behavior named in the
PR description or issue. Prefer promises involving concurrent interleavings,
retry or recovery paths, authorization boundaries, state-machine transitions,
parsing or validation, ownership, memory safety, arithmetic bounds, or data
structure invariants.

State, before running anything:

- the property in one plain sentence;
- the concrete harm if it is violated; and
- the changed files, functions, and code steps that implement it.

Do not select a trivial property merely because it is easy to make pass. If the
diff has no credible high-risk promise, say why and run the strongest relevant
existing checks instead.

## Pick and execute the check

Use the benchmark tool policy above, preferring evidence about the changed
implementation over a detached model:

- For event ordering, retries, or lifecycle transitions, model the changed
  design with a model checker. TLA+ is the default when it is available and a
  small faithful state model answers the question.
- For all-input behavior of the actual code (for example overflow, unsafe
  access, parser acceptance, or a data-structure invariant), use a verifier or
  symbolic/exhaustive engine that runs on the language when one is practical.
- If the selected source-level verifier cannot express the changed code without
  a rewrite that would invalidate the experiment, exercise the real changed
  code with generated inputs and exhaustive bounded cases. Call this bounded
  testing, not a proof. Do not swap to a different-language verifier and call
  that source proof.

The model or harness must use repository names and point each transition,
assumption, and invariant to the relevant code. An atomic model step must match
an atomic code step. Do not silently assume away failures, weaken a property to
pass, or substitute a different behavior from the one in the diff.

Run the selected check. Capture the exact command, tool version, duration,
result, bounds, and assumptions. If the tool reports a counterexample, translate
it into the PR's code terms as a short ordered sequence and report it as a
finding; do not change product code unless separately asked.

## Demonstrate that the check can fail

When feasible, copy only the relevant code or model into a temporary workspace
and make the smallest controlled mutation that removes or reverses the guarded
behavior. Re-run the same check and confirm it fails for the expected reason.
Remove the temporary workspace afterward. Never mutate the actual worktree to
perform this demonstration. If a meaningful mutation is not feasible, explain
why and label the evidence accordingly.

For a TLA+ check, inspect every reported violation with `/statechart`; use it to
describe the shortest failing path. When the check passes, use `/statechart` to
show the model's state flow. Do not copy `/statechart` commands or paths: they
vary by environment.

## Report the verification result

Finish with a concise evidence report, not a generated skill. Include:

1. **Scope:** base and head commits; changed code covered.
2. **Property and harm:** one plain sentence each.
3. **Method:** tool and why it fits, exact command, version, duration, and
   pass/fail result.
4. **Strength:** whether this is an unbounded proof, bounded exhaustive check,
   or generated testing; all bounds and assumptions.
5. **Fault sensitivity:** the controlled mutation and its observed failure, or
   why it could not be demonstrated.
6. **Findings:** counterexamples in code terms, or explicitly “none within the
   stated scope.”
7. **Limits:** code paths, environment behavior, integrations, or assumptions
   not covered.

Do not describe a successful bounded or modeled run as proof of the entire
system. A missing tool, an unbuildable target, or insufficient time is a result
to report plainly, along with the commands attempted and the smallest next step.
