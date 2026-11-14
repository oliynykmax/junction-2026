# Reading view decisions

## The agent hides lines; code renders them, 2026-11-14

The reading view shortens each changed file to the lines worth reading. It
follows [boldsoftware/meat](https://github.com/boldsoftware/meat): the agent
does not write a shortened diff. It submits a plan in the patch's own line
numbers (remove lines, fold a run of same-kind lines into one `...` row, or
elide part of one line with `...`). `review-bot/src/reading.ts` checks the
plan against the stored patch and renders it.

Why: a diff the model writes can change code without anyone noticing. With a
plan, every visible row is a verbatim patch line or one with visible `...`
gaps. The agent decides what the owner skips, never what the remaining code
says. An elision must keep every other character, and each `...` must stand
for at least one character, so `!allowed` cannot become `allowed`.

## Rules outside the agent's control

- **A line a finding cites is never hidden or elided**, by the agent or by the
  automatic rule. The named owner decides on the findings, so their evidence
  stays on screen. A plan that hides one is refused with the reason.
- **C# `using` directives are hidden automatically** as scaffolding. `using`
  statements and declarations (`using var x = ...;`, `using (...)`) are not
  directives and stay.
- **Hidden lines are kept as gap rows**, not dropped, so the viewer can count
  them (`kept 3/9 changed lines`, computed from the plan) and expand them.
- **Hunk headers belong to the compiler**: shown while any line of the hunk is,
  hidden with the whole hunk.

## Left out of meat, and why

Move detection, chunking, Python structure checks and result caching. GitHub
gives one patch per file under our size caps, the sample repo is C#, and the
reading view is stored with the review rather than recomputed.

## Failure modes

- **Hiding what matters.** The agent can still remove a meaningful line that no
  finding cites. Limits: the kept count shows how much is hidden, gaps expand
  in place, and the full diff stays one click away.
- **Plan refused.** An invalid plan is refused whole, with every problem listed
  so the agent can fix them in one retry. If it never produces a valid plan,
  the file shows as the full diff.
