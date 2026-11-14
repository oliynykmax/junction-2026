# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing: Cloudflare Worker `j26-review-bot` (`review-bot/`, TypeScript, Bun, Wrangler), live at https://review.oliinyk.dev. It serves a placeholder at `/r/<owner>/<repo>/<pr>?sha=<head>`, which is where the review view goes.

The review view will use a frontend framework (confirmed with the user). Which one is **undecided**; record the choice here when made.

## Users

Primary user: the **named owner** of an agent-written PR: an engineer whose name goes on the approval, short on time (the brief's example is a 200-line PR landing on Friday afternoon). Their job is to decide whether to accept the change on evidence, without reading the whole diff.

Other readers (Junction judges watching the live walkthrough) are secondary. The view is built for the owner, and judges see it through the owner's eyes.

## Product Purpose

Our entry for Tieto's **Earned Trust in AI Code** challenge at Junction 2026: an AI code review concept plus a reference implementation. The AI reviews code written by AI so a named human can trust and accept it, while staying accountable for every change.

The reference implementation illustrates the concept. It is not a product. Judges weight the concept more than the code. Success means a named human can accept the sample change on evidence rather than a full read, and can see what the AI found, what it refused to decide, and why.

Deliverables: concept card (recommendation, principles, trade-offs, limits), live walkthrough showing where trust comes from, lessons log, demo video or presentation, and a short decision log with named failure modes.

## Positioning

The change opens with its own explanation: what it does, why it was made, what else it touches, and how confident the AI is about each part. The reviewer checks a story and questions the parts that don't add up. Evidence traces to a requirement ID. The AI states what it refused to decide. The owner signs a statement of what was checked and by whom or what, what was not checked and why, and the residual risk they accept.

The AI review is advice with evidence, never the approval. "The AI said it was fine" is explicitly not acceptable.

## Operating Context

- GitHub pull request flow. A GitHub App (`j26-earned-trust-review`, installed only on `oliynykmax/junction26-messagepack-csharp`) posts one comment per PR linking to the review view. Later pushes edit that comment.
- Sample code input is our own copy of `te-industry-tech-office/junction26-messagepack-csharp` (MessagePack-CSharp, C#). Never work on upstream.
- Review depth follows risk: light checks for low-risk changes, a full read for high-risk ones.
- Humans spot-check the AI reviewer and track what it misses. Trust is earned per area from track record and withdrawn after escapes.

## Capabilities and Constraints

- **Walkthrough sample:** branch `ju26-issue-2283`, a bug fix for upstream issue #2283 (1 commit, 4 files), with its requirement ID. Other candidates (`ju26-issue-2234`, `ju26-issue-2129`, `ju26-issue-2297`) are not chosen.
- Synthetic or cleared sample data only.
- A named human is accountable in every design choice. The AI never approves.
- Vendor guidance from Tieto: route human attention by risk, keep reviews fast and low-noise, review with full repo context, verify findings before posting, measure outcomes (reverts, incidents) rather than review activity.
- Judges' questions the product must answer: what would make you not trust your own output, who owns the decision, how would this scale.
- Out of scope: a finished product, model training, vendor selection.
- Terminology: "owner" is the named human who signs. "Refused to decide" means a question the AI explicitly hands back to the owner.
- Undecided: frontend framework; how findings are generated and verified in the reference implementation; where the requirement set lives (Tieto resources: requirements set, sample changes with requirement IDs, quality and security standards).

## Brand Commitments

The bot and GitHub App carry the name "Earned Trust Review" (`j26-earned-trust-review`). A logo and favicons exist in `review-bot/assets/` (`logo.svg`, `logo.png`, `favicon.ico`, `apple-touch-icon.png`). No voice or identity rules beyond these have been set.

## Evidence on Hand

- Full challenge brief: `challenge/earned-trust-in-ai-code.md`.
- Four AI-made branches of MessagePack-CSharp (listed in the brief) in our copy of the sample repo.
- Absent, and not to be fabricated: Tieto's requirements set and requirement IDs for the sample change (not yet in this repo), real track-record or incident data, real confidence calibration data, real reviewer sign-offs. Any such figures in demos must be labelled synthetic.

## Product Principles

1. **AI advises, a named human decides.** Every screen shows the owner's name and what they are signing. No AI output reads as approval.
2. **Evidence over confidence.** A claim without something the owner can check (a test, a line, a requirement ID) does not get a confidence display. No unexplained risk scores.
3. **Say what was not checked.** The AI's refusals and gaps are first-class content, shown alongside findings.
4. **Depth follows risk.** Attention is routed to the parts that need a human and kept off the parts that don't.
5. **Trust is earned per area and can be withdrawn.** Track record and escapes change how much is routed to humans.

## Accessibility & Inclusion

No product-specific requirement established. The owner may be reviewing under time pressure, so the view should be scannable and its key claims readable without color alone. WCAG AA is a reasonable floor but has not been confirmed as a requirement.
