# Bumble Bot concept card

## Recommendation

Review a requirement and its evidence before reading the whole diff. An AI reviewer proposes findings. A separate verifier challenges them. A named engineer decides what risk to accept for the exact commit.

This is a reference implementation for Tieto's Earned Trust in AI Code challenge, not a finished product.

## Principles

- **Risk controls attention.** Deterministic rules explain why a change needs a light check, selected full-file reads, or deeper human review. Confidence cannot lower the required depth.
- **Claims need traceable evidence.** Connect the requirement, reviewed commit, affected files, check command, result, assumptions, and limits. Documentation and code reasoning remain distinct from execution.
- **Challenge the reviewer.** A separate verifier writes initial checks from stated requirements and base code before seeing the candidate. It then attempts to reproduce findings. A passing receipt requires a stated broken variant that the check catches.
- **Uncertainty stays visible.** A failed tool, missing check, untested fix, and unverified finding are explicit outcomes. No findings does not mean no defects.
- **Humans remain accountable.** The owner signs what they checked, what remains unchecked, and the residual risk they accept. New commits need new decisions.
- **Trust can be withdrawn.** Humans spot-check and record misses by code area. An escaped defect returns that area to full human review under the proposed policy.

## Trade-offs

| Choice | Benefit | Cost or limit |
|---|---|---|
| Separate reviewer and verifier | Reduces self-grading and implementation-driven tests | Adds latency and cost. Both agents can share a mistaken assumption. |
| Requirement-first checks | Tests intended behavior rather than only the submitted implementation | PR descriptions can omit or misstate requirements. The owner must validate intent. |
| Risk-based human attention | Focuses reading where consequences are greater | Path and patch heuristics miss semantic risks. Owners can always raise the tier. |
| Explicit unrun dispositions | Prevents missing evidence from looking like success | A completed report can still contain substantial unchecked scope. |
| Optional formal methods | Can establish a precise property within stated assumptions | A model proof is not a proof of all production behavior. |

## Limits that stop us trusting our own output

Checker receipts are agent-reported, not authenticated execution artifacts. Verifier blindness is enforced by workflow and instructions, not a network boundary. Missing requirements, unreviewed files, failed checks, unsupported API advice, and changed heads invalidate broad acceptance claims. Independent agents are not independent ground truth.

The implementation has risk routing and commit-specific sign-off. Per-area trust withdrawal and longitudinal outcome measurement are proposed operating policies, not automated features.

## Presentation version

This card can be one slide in the presentation. Use this text and link this page for the details.

> **Review evidence. Own the decision.**
>
> Requirement + pinned commit → reviewer claims → separate verifier checks → evidence and gaps → named human decision.
>
> Risk sets reading depth. Unrun checks stay unverified. A reviewer miss withdraws trust for that area.
>
> Trade-off: more verification time and cost for more inspectable evidence. Limit: two agents can be wrong together, and receipts are still agent-reported.
