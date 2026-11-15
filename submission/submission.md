# Bumble Bot submission copy

- **Project name:** Bumble Bot.
- **Punchline:** Review evidence. Own the decision.
- **Challenge:** Tieto, Earned Trust in AI Code.
- **Demo:** https://review.oliinyk.dev/
- **Source:** https://github.com/oliynykmax/junction-2026
- **License:** MIT.

## Description

Bumble Bot is a reference implementation of evidence-based review for agent-written code. A reviewer proposes findings, and a separate verifier writes initial checks from the requirement before seeing the change. Reports pin the exact commit and expose evidence, counterexamples, failed checks, and remaining gaps. Deterministic risk rules tell the human where deeper reading is required. A named engineer owns the final decision and can record what they checked and what risk they accept.

We demonstrate the concept on the four supplied MessagePack-CSharp changes in our own fork. Issue #2283 illustrates why fixing the reported crash is insufficient when the patch suppresses another required diagnostic. Our lessons include unsupported API advice, mistaken diagnostic claims, and compiler failures that undermine apparently green evidence.

The reference does not claim whole-PR correctness. Checker receipts remain agent-reported, and two agents can share a blind spot. Per-area trust withdrawal is a proposed operating policy. We do not yet claim measured reductions in human review time or production incidents.

## Deliverables

- [Concept card and slide copy](../docs/challenge/concept-card.md).
- [Live walkthrough](../docs/challenge/walkthrough-2283.md).
- [Four sample PRs and pinned review links](../docs/challenge/sample-reviews.md).
- [Measurements and evaluation limits](../docs/challenge/measurement.md).
- [Lessons and decisions](../docs/challenge/lessons-log.md).
- [Human review and trust policy](../docs/challenge/review-policy.md).

## Technologies

TypeScript, Bun, Cloudflare gateway, CellD, Verda compute and private storage, Podman execution containers, Modal scanners, GitHub App, Context.dev, Microsoft Learn, and requirement-driven executable checks. Formal methods are optional and scoped to the property actually checked.

## Platform-only fields to verify

The existing team demo and presentation remain the presentation assets. Add their actual public video or presentation URL in the platform form. No public upload URL was found in the local submission record. Confirm team contacts, selected challenge, and FINAL status on the platform. These documents do not establish platform submission status.
