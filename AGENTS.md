# AGENTS.md

Guidance for AI agents working in this repo.

## Project

This is our team's repo for Junction 2026. We are building for Tieto's **Earned Trust in AI Code** challenge: an AI code review concept, plus a reference implementation, that lets a named human accept an agent-written PR on evidence rather than a full read.

Read [`challenge/earned-trust-in-ai-code.md`](challenge/earned-trust-in-ai-code.md) before starting any task. It holds the full brief, deliverables, judging criteria and sample code input.

## Status

- **Current focus:** the AI PR reviewer challenge (above).
- **Dropped:** the Telegram propaganda detector for Hostinger's "Decode the Noise" challenge. `telegram-propaganda-brief.md` and `sources.md` are kept for reference only. Don't build on them.

## Working rules

- Judges weight the concept more than the code. Deliverables are a concept card, a live walkthrough, a lessons log and a demo. The reference implementation illustrates the concept and is not a product.
- Keep a named human accountable in every design choice. AI output is advice with evidence, never the approval.
- Use synthetic or cleared sample data only.
- Sample changes live in a separate repo (`te-industry-tech-office/junction26-messagepack-csharp`). Work on our own copy of it, never upstream.
- Record notable design decisions and failure modes as you go. The challenge requires a decision log.
