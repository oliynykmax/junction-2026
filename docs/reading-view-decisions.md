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

## The agent's tool, 2026-11-14

The reviewer agent submits one plan per file with `abridge_file`, after its
findings, using patch line numbers from `read_patch` with `numbered`. It is the
same agent and model as the review, since it has already read every patch.

- **Only the plan is stored**, under `readings` in the review document. The
  viewer renders it against the patch and the findings at display time. A
  finding reported after the plan that cites a hidden line therefore makes the
  plan invalid, and that file falls back to the full diff instead of hiding
  the evidence.
- **Two refusals per file**, then the tool stops accepting plans for that file
  and the owner sees its full diff. This bounds wasted turns, like the other
  refusal caps.
- **The tool checks the patch stored with the review**, the one the owner
  sees, not a fresh copy from GitHub. A file over the size cap has no stored
  patch and cannot be shortened.
- **Patch lines are not file lines.** The `N|` gutter appears only when the
  agent asks for it, and the tool descriptions say `report_finding` still
  takes file lines at the PR head.
- Shortening is optional: `finish_review` does not require a plan per file.

## The viewer, 2026-11-14

- **The reading view lives in the Changes tab**, in each change's diff. The
  Full diff tab stays the complete patch, so its name stays true.
- **Each file opens shortened when it has a valid plan**, with a bar saying
  `Reading view: kept 2/4 changed lines. The AI chose what to hide; lines that
  findings cite always show.` and a toggle to the full diff.
- **Hidden runs say who hid them**: "3 lines hidden by the AI" or "1 using
  directive hidden automatically". A fold shows as `...` at the code's indent.
  Both expand in place on click.
- **A plan that no longer fits the findings is not used.** The file shows its
  full diff with a note, instead of hiding cited evidence.

## Trial on sample PRs, 2026-11-14

We ran the abridge step alone on the 8 files of sample PRs #1 and #2 (our
copy of the MessagePack repo), with the bot's model (`claude-sonnet-5-5`,
effort medium), its real protocol step and tool description, and the real
compiler. Cost: about $0.23.

- **Every file got an accepted plan.** Kept changed lines ranged from 16/50
  (a fix repeated in two places: the second copy hidden) to 28/29 (new code
  with doc comments that explain why, kept).
- **5 of 8 files needed one retry, all for the same rule**: a remove range
  covering a hunk header while the hunk kept lines. The rule protected
  nothing, since the compiler decides header visibility anyway, so a header
  in a remove range now simply stays while its hunk shows.
- **Open failure mode: test inputs hidden whole.** In the generics tests the
  agent hid each scenario's 26-33 line C# source string and kept only test
  names and the final call. The owner must expand to see what a scenario
  sets up. If this repeats, the protocol step should say to keep the
  distinctive part of test inputs, as meat's rubric does for Python.
- **Rerun after the header fix**: retries fell from 5 to 1 of 8 files
  (about $0.19). The remaining refusal was an elision whose `old` text
  occurred twice on its line, which is correctly ambiguous.
- **Run-to-run variance is real.** The same file went from 16/50 kept
  changed lines to 36/50: the second run folded the repeated edit instead of
  hiding it. Both are valid reading views; the owner should not treat the
  kept count as a stable measure of a change.
- Not covered by the trial: findings. No file had any, so the rule that
  cited lines stay visible was tested only by unit tests.

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
