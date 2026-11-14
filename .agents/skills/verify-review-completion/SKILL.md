---
name: verify-review-completion
description: "Use when changing the Bumble Bot formal-review receipt, its finish gate, or its verification-result UI. It checks that an agent cannot settle a changed review without a bounded, explicit verification disposition."
---

# Verify the formal-review completion gate

Run this skill before changing `review-bot/src/formal.ts`, the
`record_verification` or `finish_review` tools in `review-bot/src/reviewer.ts`,
or the verification receipt view in `review-bot/web/formal.tsx`.

## The property and the harm

**Property:** a review with changed files cannot finish until every changed file
is covered by a verification receipt.

**Harm if it breaks:** the named owner can mistake an uncovered agent change for
checked evidence. This is the narrow completion promise behind the receipt UI;
it does not prove that the changed code is correct.

## Coverage record

- **Covered code:** `recordVerification` and `finishReview` in
  `review-bot/src/reviewer.ts`, and the validation/coverage helpers in
  `review-bot/src/formal.ts`.
- **Check:** `review-bot/tests/changes.test.ts`, especially “finish gate
  rejects every incomplete receipt set in a two-file review”, calls the real
  `finish_review` tool for all four receipt subsets of two changed files.
- **Supporting checks:** `review-bot/tests/formal.test.ts` rejects a claimed
  pass with no broken variant or limits, and requires counterexample/not-run
  records to disclose their outcome.
- **Tool choice:** the production code is TypeScript and the Worker has no
  TypeScript deductive verifier. The lowest-cost truthful check is a bounded
  property test of the real completion tool, not a hand-written state model.
- **Reproducible command:** from `review-bot/`, run
  `bun test tests/changes.test.ts tests/formal.test.ts`.
- **Last confirmed sync commit:** `274cc278e91629fc8b7cd6cdeed3ccc01f92d451`.

## Scope, assumptions and limits

The check exhausts the empty, each singleton, and complete receipt sets for two
changed files. It assumes that `finish_review` is the only path that commits a
verdict and that captured changed-file paths are trustworthy. It does **not**
prove arbitrary-size set behavior, Durable Object storage behavior, checker
honesty, or the correctness of code reviewed by the agent.

Do not call the result a formal proof. A receipt marked `passed` is a claim
about its named external checker, scope and mutation—not the whole PR.

## Run and interpret

1. Read the covered code and keep the receipt fields together: target,
   property, harm, tool/checker, exact rerun command, outcome/result, scope,
   broken variant for a pass, assumptions and limits.
2. Run the reproducible command above. A passing run means the bounded
   completion property still holds in the real tool path.
3. Run `bun test`, `bun run lint`, `bunx tsc --noEmit`, and `bun run build`
   before handing off a behavior or UI change.
4. If a receipt is missing, invalid or says `not_run`, keep that visible to the
   human owner. Do not silently promote it to `passed` or weaken the gate.

## Required broken-variant validation

On a scratch edit only, remove the `if (unverified.length)` refusal in
`finishReview`, then run:

```sh
bun test tests/changes.test.ts -t "finish gate rejects every incomplete receipt set in a two-file review"
```

The test must fail because an incomplete receipt set can now settle. Restore the
scratch edit, rerun the same command and confirm it passes. If it does not
fail, strengthen the test or the completion gate; do not relax the property.

## Keeping it in sync

After a covered-code change, repeat the normal and broken-variant checks. Move
the “Last confirmed sync commit” forward only after confirming that this skill
still describes the code at that commit. If the target changes materially,
rewrite the property, scope, tool choice and limits here before moving it.
