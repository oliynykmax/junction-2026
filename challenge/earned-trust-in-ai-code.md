# Challenge: Earned Trust in AI Code (Tieto)

Source: https://hackjunction.app/participate/45/challenges/351
Captured from the Junction platform on 2026-11-13. This is the challenge our team is building for.

## The question

How can AI review code written by AI so that humans can trust it, while a named human stays accountable for every change?

Picture a 200-line PR from an agent landing on Friday afternoon, with your name on the approval. Instead of digging through the diff, the change opens with its own explanation: what it does, why it was made, what else it touches, and how confident the AI is about each part. The reviewer checks a story and questions the parts that don't add up.

Background: agent tokens passed human tokens in February 2026 and reached 7.3 trillion by August (OpenRouter data). Reviewing every change by hand does not scale.

## What we must build

Design an AI code review concept and show it works. Cover the concept, principles, reference implementation and technology considerations across frontend, backend and security. Question whether line-by-line review is still the right way to ensure quality. Balance risk, hallucination, transparency, confidence and quality.

The reference implementation illustrates the concept. It is **not a product**. Judges weight the concept more than the technical implementation.

Each team must:

1. Define the concept: what the "PR review factory" should follow.
2. State its key principles, including how it balances risk, hallucination, transparency, confidence and quality.
3. Illustrate it on one sample agent-written change with its requirement ID.
4. Show what the AI found, what it refused to decide, and why.
5. Show how the evidence lets a named human accept the change without a full read.
6. Name the failure modes we saw, and keep a short decision log.

Use synthetic or cleared sample data only.

## Deliverables

- **Concept card:** recommendation, principles, trade-offs, limits.
- **Live walkthrough** showing where the trust comes from.
- **Lessons log** and a demo video or presentation.

Out of scope: a finished product, model training, vendor selection.

## Code input

Fork or copy this repo before working on it: https://github.com/te-industry-tech-office/junction26-messagepack-csharp

Branches with AI-made changes to MessagePack-CSharp:

| Branch | Upstream issue | Size |
|---|---|---|
| `ju26-issue-2283` | bug [#2283](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2283) | 1 commit, 4 files |
| `ju26-issue-2234` | bug [#2234](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2234) | 1 commit, 4 files |
| `ju26-issue-2129` | issue [#2129](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2129) | 1 commit, 28 files |
| `ju26-issue-2297` | issue [#2297](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2297) | 1 commit, 237 files |

We may use other inputs too ("inspired but not limited").

## Tieto's stated principles

AI reviews, humans stay accountable. Trust comes from evidence a person can check and own, not from the AI being confident.

- A named engineer owns each change and signs off on it.
- The AI review is advice with evidence, never the approval itself.
- Evidence is traceable to a requirement, so the owner can check it quickly.
- Review depth follows risk: low-risk changes get light checks, high-risk ones get a full read.
- Humans spot-check the AI reviewer and track what it misses.
- Trust is earned per area from track record, and withdrawn after escapes.

**What the owner signs:** what was checked and by whom or what; what was not checked and why; the residual risk they accept.

**Not acceptable:** "The AI said it was fine." An unowned merge. Confidence without evidence, or a risk score nobody can explain.

**Vendor recommendations:** route human attention by risk; keep reviews fast and low-noise; review with full repo context; verify findings before posting; measure outcomes (reverts, incidents), not review activity.

## Possible directions (options, not requirements)

- **Generalist reviewer:** one reviewer covering frontend, backend, security and performance. How to prompt or train for that breadth is part of the work.
- **Classifier:** flag code that genuinely needs human review and separate it from code that meets the standard.

Every option must keep a named human accountable.

## Questions judges will ask

- What would make you not trust your own output?
- Who owns the decision?
- How would this scale?

## Judging criteria

| Criterion | Weight | What they look for |
|---|---|---|
| Clarity | 30% | A clear recommendation with stated principles, explicit trade-offs and limits. |
| Practicality | 25% | Works in a real PR flow and scales, with a named human owning each decision. |
| Measurement | 25% | How trust is measured: reverts and incidents don't rise as review time falls; AI findings are real and accepted; time to merge; share routed to humans. |
| Evidence | 20% | Evidence traceable to a requirement lets a named human accept a change without a full read, including what the AI found, what it refused to decide, and why. |

## Resources from Tieto

- Background on what good code means at Tieto: standards, security, quality.
- A requirements set: intent, functional and non-functional.
- Sample agent-written changes, each with its requirement ID.
- Model access through partner credits on the Junction Platform.

## Prizes

1st €2,000 · 2nd €1,000 · 3rd €500.
