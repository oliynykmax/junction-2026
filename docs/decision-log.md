# Decision log

What we decided, why, and what we gave up. Newest last. Each entry links the PR or commit where the decision landed. Add an entry when you make a choice someone could reasonably have made differently.

Format: **D<n> · date · decision.** Why. Trade-off. Source.

## Scope

**D1 · 2026-11-14 · Build for Tieto's Earned Trust in AI Code; drop Hostinger's Decode the Noise.**
We had started on a Telegram propaganda detector for Hostinger. We moved to Tieto's challenge and later removed the old files from the repo.
_Why:_ not written down at the time. TODO: whoever made the call, add the reason.
Source: `9df0aed`, #9.

**D2 · 2026-11-14 · Review a copy of the sample repo, never upstream.**
The GitHub App is installed only on `oliynykmax/junction26-messagepack-csharp`. Synthetic demo PRs (#3, #4) live there next to Tieto's AI-made branches.
_Why:_ the brief requires synthetic or cleared data, and we must not write to Tieto's or MessagePack's repos.
Source: #4, `AGENTS.md`.

## Architecture

**D3 · 2026-11-14 · A GitHub App on a Cloudflare Worker, triggered by PR events.**
Opening, reopening, marking ready or pushing to a PR starts a review. The bot keeps one comment linking to the report.
_Why:_ the review has to live in the normal PR flow (Practicality criterion), not in a separate tool people must remember to open.
_Trade-off:_ ties the demo to GitHub.
Source: #4.

**D4 · 2026-11-14 · One durable review per (PR, head commit).**
Each review runs in its own Durable Object with pi-durable. Model turns, tool calls and findings are saved before they are shown, and an evicted run resumes.
_Why:_ evidence must be pinned to the exact commit the human signs off on. A new push is a new review, never an edited old one.
_Trade-off:_ no re-run button for the same commit.
Source: #6.

**D5 · 2026-11-14 · The reviewer gets read-only tools only.**
`pr_overview`, `read_patch`, `read_file`, `list_dir`. No shell, no checkout, no build.
_Why:_ the reviewer should not be able to change what it reviews, and a sandboxed build is out of scope for a hackathon.
_Trade-off:_ the agent cannot run tests or the build. It must list them as not checked.
Source: #6.

**D6 · 2026-11-14 · Model: Claude Sonnet 5.5, thinking level medium.**
_Why:_ fast and cheap enough to review every push. Reviews cost $0.01–0.08 each on the sample PRs.
_Trade-off:_ not compared against other models yet.
Source: #6.

**D7 · 2026-11-14 · Rubric: Cursor's code-quality review prompt, fetched at a pinned commit and stored with its sha256.**
_Why:_ the report shows exactly which rubric ran. It is fetched, not copied, because that repo has no license.
_Trade-off:_ a review depends on GitHub being reachable to fetch it.
Source: #6.

## Evidence

**D8 · 2026-11-14 · Deterministic scanners run before the AI, and the AI must account for every diagnostic.**
zizmor (workflows), ty (Python) and oxlint (JS/TS) run on Modal. The agent confirms each diagnostic as a finding or dismisses it with a reason. A failed scan never blocks a review; it is listed as not checked.
_Why:_ "what was checked, and by whom or what." Same input, same answer is a stronger base than model judgment.
_Trade-off:_ no scanner for C# yet, and C# is what the sample repo is written in.
Source: #7.

**D9 · 2026-11-14 · A docs gate: the review cannot finish without looking up current documentation.**
`finish_review` refuses up to twice when no docs were consulted. After that the review finishes and says its library claims came from memory. Every lookup is shown on the report.
_Why:_ asking in the prompt did not work (see L2, L3).
_Trade-off:_ adds cost and an outside dependency (Context.dev, Microsoft Learn).
Source: #10.

**D10 · 2026-11-14 · Findings carry severity, class and confidence.**
Severity: `critical`/`high`/`medium`/`low`/`info`, for impact. Class: correctness, security and others. Confidence: `verified` (the agent read the code that proves it), `likely`, `possible`.
_Why:_ the owner must tell a traced bug from a suspicion at a glance. Confidence is separate from severity so a scary guess does not look like a proven bug.
Source: #8.

**D11 · 2026-11-14 · The advisory decision is computed from the findings, not chosen by the agent.**
Any `critical` or `high` finding rated `verified` or `likely` means `changes_requested`. A `possible` one is shown for the owner to check but does not change the decision.
_Why:_ when the agent chose the decision itself, it could contradict its own findings (see L4). A fixed rule can be explained; a model's mood cannot.
Source: #8 (`decisionFor` in `review-bot/src/findings.ts`).

**D12 · 2026-11-14 · Every report lists what was not checked.**
Unread files, tests not run, failed scanners, docs not consulted.
_Why:_ Tieto's sign-off asks for what was not checked and why. Silence would read as "checked".
Source: #6, #7, #10.

## Accountability

**D13 · 2026-11-14 · The bot approves only a clean review and withdraws old approvals.**
A review with zero findings posts a GitHub approval. Findings post a comment review with counts and a report link. Each push dismisses the bot's approvals of older commits.
_Why:_ a stale approval must never outlive a later review that found problems.
_Open question:_ Tieto says "the AI review is advice, never the approval". A GitHub `APPROVE` from the bot may read as the approval itself. See Q1.
Source: #11, #15.

**D14 · 2026-11-14 · Team rule: a human merges, and only after the bot's review of the head commit shows no blockers.**
Fix or dismiss each finding with a reason. A human can override with a stated reason. This is a team rule, not branch protection.
_Why:_ we use our own process on our own repo, so the demo shows it running for real.
Source: `1d7df0c`, `AGENTS.md`.

**D15 · 2026-11-14 · Public reviews from the landing page never write to GitHub.**
Anyone can paste a public PR URL at review.oliinyk.dev. Those reviews run in the same Worker but never get app credentials, never comment and never approve. Limits: 60 files, 4,000 changed lines, hourly and daily budgets.
_Why:_ lets judges try it on any PR without letting an anonymous visitor make the bot act on GitHub.
_Trade-off:_ large PRs are refused outright, and GitHub's anonymous rate limit caps demo use.
Source: #13, `landing/DECISIONS.md`.

## Supply chain

**D16 · 2026-11-14 · Harden our own CI.**
Actions pinned to commit SHAs, `permissions: {}` with per-job `contents: read`, timeouts, `persist-credentials: false`, linted by jactionlint.
_Why:_ a review bot with write access to PRs is a target. Practise what we review for.
Source: #5.

## Open questions

- **Q1. Should the bot approve at all?** D13 uses GitHub approval to signal "no findings", but the brief says the AI must never be the approval. Alternative: a neutral status check, with approval only from the named owner.
- **Q2. Traceability to requirements.** The brief wants evidence tied to a requirement ID. The reviewer does not read or cite requirement IDs yet.
- **Q3. Review depth by risk.** Every PR gets the same review. The 237-file change (`ju26-issue-2297`) would be refused by the landing page and has not been run through the bot.
- **Q4. Measuring trust.** Nobody has checked the bot's findings against a human answer yet, so we cannot say how often it is right or what it misses.
