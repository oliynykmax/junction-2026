# AGENTS.md

Guidance for AI agents working in this repo.

## Project

This is our team's repo for Junction 2026. We are building for Tieto's **Earned Trust in AI Code** challenge: an AI code review concept, plus a reference implementation, that lets a named human accept an agent-written PR on evidence rather than a full read.

Read [`challenge/earned-trust-in-ai-code.md`](challenge/earned-trust-in-ai-code.md) before starting any task. It holds the full brief, deliverables, judging criteria and sample code input.

## Status

- **Current focus:** the AI PR reviewer challenge (above).
- **Dropped:** the Telegram propaganda detector for Hostinger's "Decode the Noise" challenge. Its files were removed from the repo (see git history). Don't build on it.

## Working rules

- Judges weight the concept more than the code. Deliverables are a concept card, a live walkthrough, a lessons log and a demo. The reference implementation illustrates the concept and is not a product.
- Keep a named human accountable in every design choice. AI output is advice with evidence, never the approval.
- Use synthetic or cleared sample data only.
- Sample changes live in a separate repo (`te-industry-tech-office/junction26-messagepack-csharp`). Work on our own copy of it, never upstream.
- Record notable design decisions and failure modes as you go. The challenge requires a decision log.
- Do not edit any `README.md` (root or `review-bot/`). A human maintains them. Put notes for agents in `AGENTS.md` instead.
- Before merging a PR, get a review from our review bot (`bumble-bot-review`). The bot never approves; a named human does. Its comment on the PR links to the review page for the head commit. Fix or dismiss with a reason each finding there, push, and merge only once the page for the new head says no blockers found. This is a team rule, not a branch protection, so a human can still override it with a stated reason.
- Write PR descriptions with the repo-local [pr skill](.agents/skills/pr/SKILL.md). Make behavior changes and visible UI changes explicit.

## Public review authentication

Manual reviews mint read-only installation tokens using `APP_ID`, `PRIVATE_KEY`, and the nonsecret `PUBLIC_INSTALLATION_ID` from Wrangler config. Both initial PR lookup and reviewer/scanner reads use those tokens. Public-repository validation and the no-publication rule still apply. Keep these reads authenticated; the shared VM IP has only 60 anonymous GitHub requests per hour.
