# Two-agent verification decisions

## The reviewer no longer verifies itself, 2026-11-15

Before this change one agent reported findings and also wrote the
verification receipts that backed them, so nothing independent checked its
work. The runtime now runs two agents.

- **Reviewer** (the root conversation) reports candidate findings. It has no
  `record_verification` tool. After its findings it calls `verify`, which
  starts the verifier and waits for it. `report_finding` refuses once `verify`
  has started, so every finding gets a verdict.
- **Verifier** (a child conversation owned by the `verify` call) has its own
  executor container, because the session key is the conversation id. It works
  in two phases:
  1. **Blind.** It sees only the pull request's title, description and commit
     messages, and `checkout` gives it the base commit. It writes checks from
     those requirements and saves them with `save_checks` (at most 6, 8,000
     characters each). Saving ends the blind phase.
  2. **At the head.** `verifier_context` now shows the changed files and the
     findings. `checkout` gives the head and writes the saved checks back at
     their paths. A head file at one of those paths is kept, and the check is
     written beside it as `<path>.blind-check`. The verifier records receipts
     and ends with `finish_verification`, which needs a receipt for every
     changed file and one verdict per finding.

A third agent was considered and rejected. Two agents are enough to separate
the claim from its check.

## State

`ReviewState.verifier` is a union by phase. `blind` has no checks yet.
`verifying` holds the frozen checks. `done` adds the verdicts and a summary.
`failed` keeps the checks and the error. Receipts stay in `verifications`, with
`author: "verifier"`. A verdict is `reproduced` (links a counterexample),
`not_reproduced` (links a passed receipt, so a broken variant that the same
check caught), or `not_checked` (links nothing). The verifier writes into the
root's review document through `VerifierLink`, a document in its own
conversation that names the root.

`finish_review` refuses until the verifier status is `done`, and it still
checks receipt coverage. A verifier that stops without `finish_verification`
is marked `failed`, and the reviewer calls `verify` again, which starts a fresh
child. There is no bypass.

## Limits

- Blindness covers the disk, not the network. The base checkout fetches only
  the base commit, but the container and the MCP tools can reach GitHub. The
  prompt forbids looking for the change, but nothing enforces it.
- Receipts are still agent-reported. Separating the author of a finding from
  the author of its check removes self-grading. It does not authenticate a
  checker run.
- A verdict does not change a finding's severity, confidence or the advisory
  decision. The owner sees both side by side.

## Demo

Any review page with `?demo=1&state=verified` renders a finished review from mock data:
verdict badges on findings, the blind checks, and the verifier's receipts.
