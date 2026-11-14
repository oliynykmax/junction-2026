# Landing and manual review decisions

## Integration shape, 2026-11-14

We compared two shapes before implementation.

- A separate Worker owns the landing and public API, then calls the existing review Worker. This isolates deployment but needs a new service boundary, public-read credentials, duplicated routing, and a way to persist manual mode across that boundary.
- The existing Worker serves static assets and starts isolated manual reviews. This reuses the engine and report without a second deployment. Its main risk is accidentally inheriting webhook write permissions.

We chose the same Worker. `POST /api/reviews` accepts `{url}` and resolves a public PR to its current head and base. The durable target is a union: manual targets carry mode and pinned base, webhook targets carry an installation ID. Manual keys start `manual:` and reports use `/m/` and `/api/m/`. Completion checks the persisted mode before approval, and manual reads never obtain an installation token. Existing webhook keys remain unchanged.

## Safety and cost

Public resolution and report reads check repository visibility through unauthenticated GitHub API requests. A private or inaccessible repository is rejected even if the app is installed there. Manual reports cannot address webhook objects. GitHub's anonymous quota can stop reviews; errors explain this without exposing upstream bodies or credentials.

A separate durable admission object serializes starts, with two attempts per IP per hour, ten globally per hour and fifty per day. IPs are hashed before storage. Failed resolution consumes a slot. Requests have a 2 KiB body limit, same-origin enforcement when Origin is present, and PRs above 60 files or 4,000 changed lines are rejected. These are demo safeguards, not a production abuse service or a hard dollar ceiling. Distributed clients can exhaust the shared budget. Report polling also consumes anonymous GitHub reads.

Manual diffs use pinned base and head comparisons. The original PR metadata can change while work runs; head changes cause review tools to fail rather than mislabel a newer patch. Scanners download only the pinned head, with no GitHub credential for manual reviews.

## Design

The physical reference is a bright engineering review desk: clear white sheets, orange annotation marks, and an accountable reviewer. Voice: direct, precise, assured. Public Sans comes from the USWDS tradition of readable public information. The existing orange robot mark preserves identity. A clearly labeled report anatomy illustration explains evidence and unknowns without inventing findings, scores, customers, or approval claims.

## Verification checkpoint

First verify server validation, public access, namespace separation, durable mode and completion behavior. Then verify the static form and responsive layout locally. Parent owns browser screenshots, PR creation and any deployment. No merge or deploy is part of this implementation.

## Results and remaining limits

Thirteen Bun behavior tests cover URL validation, unauthenticated resolution, private-repository rejection, change-size limits, safe errors, namespace isolation, durable target restoration, manual completion without approval or token access, webhook approval preservation, pinned comparisons, and admission budgets. Formatting, oxlint, TypeScript checks, Python compilation, and a Wrangler dry-run pass. Local HTTP checks serve the actual landing, CSS, manual report shell, and validation errors. Browser screenshots and a live model review remain the parent's verification work.

Manual report polling is fifteen seconds to reduce anonymous GitHub quota pressure; webhook reports keep their existing interval. The anonymous quota still limits practical demo use. No live model review was run during implementation. The scanner's optional authorization-header change must be deployed with its normal separate deployment process for anonymous public scans to work. Without that scanner update, scanner failures remain visible in the report rather than silently claiming checks ran.

## Parent verification

Desktop and mobile Chromium screenshots were captured at 1440×1000 and 390×844. The browser loaded all assets without errors. Invalid PR input produced the server validation message and re-enabled submission. A simulated successful API response navigated to its pinned manual report route. Mobile and desktop document widths matched their viewports. All 13 tests, formatting, lint, and type checks passed again. CI now runs the behavior suite.

A live model review remains unverified because this checkout has no deployment secrets. Independent Claude review was attempted but failed at the provider API rate limit. Independent review remains blocked; this PR is not represented as independently approved or merge-ready. The team review-bot gate still applies before any human merge.

## Branding synchronization

The landing branch originally forked before Bumble Bot branding landed on main. Pulled that update into this branch and replaced the landing's copied logo with the Worker's shared favicon route. The title, home link label, header, and footer now use Bumble Bot. Icon URLs carry a branding version to avoid the older cached robot icon. Tieto's challenge retains its proper name.
