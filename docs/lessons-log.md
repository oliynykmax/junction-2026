# Lessons log

Failure modes we saw and what we learned from them. The brief asks us to "name the failure modes we saw". Add an entry when the AI, the tooling or our process surprises you.

Format: **L<n> · date · what happened.** Evidence. What we changed or still need to.

## How the AI reviewer fails

**L1 · 2026-11-14 · The reviewer read only part of the change.**
On sample PR #1 (`ju26-issue-2283`), the first version read 2 of the 4 changed files. It did say so under "not checked".
_Lesson:_ "I read all of it" cannot be assumed. Coverage has to be shown on the report, and the owner should treat unread files as unreviewed.
_Status:_ reported, not enforced. The tools could refuse `finish_review` until every changed file has been read.
Source: #6.

**L2 · 2026-11-14 · Asking in the prompt to check docs did not work.**
The prompt told the agent its knowledge might be out of date and to look things up. On sample PRs #1 and #2 it looked up nothing.
_Lesson:_ rules the AI must follow belong in the tools (code that refuses), not in the prompt.
_Changed:_ the docs gate (D9).
Source: #10.

**L3 · 2026-11-14 · Given a way out, the AI took it.**
An early docs gate let the agent opt out. On sample PR #3 it opted out and made claims about GitHub Actions from memory.
_Lesson:_ any escape hatch will be used. Make the gate hard, and when it finally gives way, say so on the report.
_Changed:_ no opt-out; the gate refuses twice, then the report says the claims came from memory. On the next run the agent searched twice and cited GitHub's guidance on untrusted input.
Source: #10.

**L4 · 2026-11-14 · The AI's verdict could contradict its own findings.**
When the agent chose its own decision, nothing stopped "no blockers" next to a serious finding.
_Lesson:_ let the AI report evidence and compute the decision with a rule people can read.
_Changed:_ D11.
Source: #8.

## How the process fails

**L5 · 2026-11-14 · An old approval can outlive new problems.**
If the bot approves commit A and commit B then adds a bug, the approval of A still shows on the PR.
_Changed:_ each push dismisses the bot's approvals of older commits (D13).
Source: #11.

**L6 · 2026-11-14 · The PR description went stale, and the bot noticed.**
Sample PR #3 said "each file has deliberate issues for the scanners". Later commits fixed all of them. The final review found nothing and said that the description did not match the code.
_Lesson:_ the description is a claim to check, not evidence. A mismatch between story and code is worth showing to the owner.
Source: `oliynykmax/junction26-messagepack-csharp#3`, review of `1130036`.

**L7 · 2026-11-14 · The bot found real bugs in our own code.**
Reviewing our landing-page PR, the bot found repeated anonymous GitHub calls during report polling, and review slots charged for failed or duplicate submissions. Both were reproduced with tests and fixed. Its maintainability suggestions were deferred with a written reason.
_Lesson:_ reviewing our own PRs gives us a real track record, and "fix or dismiss with a reason" works in practice.
Source: #13, `landing/DECISIONS.md`.

## Where outside limits bite

**L8 · 2026-11-14 · A second, independent AI review was blocked by a rate limit.**
An independent Claude review of #13 could not run because the provider API was rate limited. The PR said so instead of claiming it was reviewed.
_Lesson:_ when a check cannot run, say "not checked". Do not quietly skip it.
Source: #13.

**L9 · 2026-11-14 · GitHub's anonymous quota limits public demo reviews.**
Public reviews use unauthenticated GitHub requests, about 60 per hour per IP. Report polling was cut to one request every 15 s and made to read stored state only.
_Lesson:_ budget for this before a live demo in front of judges.
Source: #13.

**L10 · 2026-11-14 · Requesting an unknown commit creates an empty review object.**
Hitting `/api/r/...` with a made-up SHA creates an empty Durable Object.
_Status:_ known, not fixed.
Source: #6.

## Still to learn

- How often are the bot's findings real? Needs a human-checked comparison (decision log Q4).
- What happens on the 28-file and 237-file sample changes (`ju26-issue-2129`, `ju26-issue-2297`)?
