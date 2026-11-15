# Landing and manual review decisions

## Integration shape, 2026-11-14

We compared two shapes before implementation.

- A separate Worker owns the landing and public API, then calls the existing review Worker. This isolates deployment but needs a new service boundary, public-read credentials, duplicated routing, and a way to persist manual mode across that boundary.
- The existing Worker serves static assets and starts isolated manual reviews. This reuses the engine and report without a second deployment. Its main risk is accidentally inheriting webhook write permissions.

We chose the same Worker. `POST /api/reviews` accepts `{url}` and resolves a public PR to its current head and base. The durable target is a union: manual targets carry mode and pinned base, webhook targets carry an installation ID. Manual keys start `manual:` and reports use `/m/` and `/api/m/`. Completion checks the persisted mode before approval, and manual reads never obtain an installation token. Existing webhook keys remain unchanged.

## Safety and cost

Public resolution checks repository visibility through unauthenticated GitHub API requests. Report reads rely on stored manual state verified public at admission. A private or inaccessible repository is rejected even if the app is installed there. Manual reports cannot address webhook objects. GitHub's anonymous quota can stop reviews; errors explain this without exposing upstream bodies or credentials.

A separate durable admission object serializes starts, with two attempts per IP per hour, ten globally per hour and fifty per day. IPs are hashed before storage. Failed resolution consumes only a separate lookup attempt, not a review slot. Requests have a 2 KiB body limit, same-origin enforcement when Origin is present, and there is no PR size limit, so one large PR costs a full review. These are demo safeguards, not a production abuse service or a hard dollar ceiling. Distributed clients can exhaust the shared budget. Report polling does not call GitHub.

Manual diffs use pinned base and head comparisons. The original PR metadata can change while work runs; head changes cause review tools to fail rather than mislabel a newer patch. Scanners download only the pinned head, with no GitHub credential for manual reviews.

## Design

The physical reference is a bright engineering review desk: clear white sheets, orange annotation marks, and an accountable reviewer. Voice: direct, precise, assured. Public Sans comes from the USWDS tradition of readable public information. The shared Bumble Bot bee icon preserves identity. A clearly labeled report anatomy illustration explains evidence and unknowns without inventing findings, scores, customers, or approval claims.

## Verification checkpoint

First verify server validation, public access, namespace separation, durable mode and completion behavior. Then verify the static form and responsive layout locally. Parent owns browser screenshots, PR creation and any deployment. No merge or deploy is part of this implementation.

## Results and remaining limits

Thirteen Bun behavior tests cover URL validation, unauthenticated resolution, private-repository rejection, large changes, safe errors, namespace isolation, durable target restoration, manual completion without approval or token access, webhook approval preservation, pinned comparisons, and admission budgets. Formatting, oxlint, TypeScript checks, Python compilation, and a Wrangler dry-run pass. Local HTTP checks serve the actual landing, CSS, manual report shell, and validation errors. Browser screenshots and a live model review remain the parent's verification work.

Manual report polling is fifteen seconds to reduce anonymous GitHub quota pressure; webhook reports keep their existing interval. The anonymous quota still limits practical demo use. No live model review was run during implementation. The scanner's optional authorization-header change must be deployed with its normal separate deployment process for anonymous public scans to work. Without that scanner update, scanner failures remain visible in the report rather than silently claiming checks ran.

## Parent verification

Desktop and mobile Chromium screenshots were captured at 1440×1000 and 390×844. The browser loaded all assets without errors. Invalid PR input produced the server validation message and re-enabled submission. A simulated successful API response navigated to its pinned manual report route. Mobile and desktop document widths matched their viewports. All 13 tests, formatting, lint, and type checks passed again. CI now runs the behavior suite.

A live model review remains unverified because this checkout has no deployment secrets. Independent Claude review was attempted but failed at the provider API rate limit. Independent review remains blocked; this PR is not represented as independently approved or merge-ready. The team review-bot gate still applies before any human merge.

## Branding synchronization

The landing branch originally forked before Bumble Bot branding landed on main. Pulled that update into this branch and replaced the landing's copied logo with the Worker's shared favicon route. The title, home link label, header, and footer now use Bumble Bot. Icon URLs carry a branding version to avoid the older cached robot icon. Tieto's challenge retains its proper name.

## Bot review fixes

The bot identified repeated anonymous GitHub visibility checks during report polling and review slots charged for failed or duplicate submissions. Regression tests reproduced both. Report reads now require stored manual-mode state from a public admission and make no GitHub calls. This preserves historical public evidence even if the repository later becomes private; anonymous review tools cannot fetch subsequent private content.

Resolution attempts have a separate durable budget of ten per client per hour, thirty globally per hour, and one hundred per day. Missing and private PRs spend only lookup attempts. Existing reports bypass the model budget. New review admissions record the pinned key in the same transaction as the budget so concurrent retries cannot double-charge it.

The low-severity context-abstraction suggestion is deferred. The target union and completion tests enforce anonymous reads and no manual approvals; a broader refactor is not needed to fix either quota bug. Explicit approval guards remain intentional safety checks. The bot's two medium reliability and correctness findings are fixed, with regression coverage.

## Conflict resolution and second bot pass

Main now publishes compact GitHub reviews for findings as well as clean approvals. The conflict resolution keeps that publication for webhook reviews and suppresses all publication in manual mode. Completion tests now exercise the publication callback.

The second bot pass suggested reducing anonymous reads further and canonicalizing manual report paths. Resolution now verifies base repository visibility from the PR response in one GitHub request, and a shared review-key function lowercases repository paths for both modes. The duplicated manual-key function was removed. The remaining schema/context refactor suggestions are deferred; they describe maintainability preferences rather than observed behavior defects.

## Theme switch and UI SDK, 2026-11-14

The landing was light-only while the review page follows `prefers-color-scheme`, so anyone on a dark OS saw a white landing hand off to a black report. The landing now follows the OS by default and has a Dark mode switch in the header that pins light or dark. The choice is saved in `localStorage` (`bumble-color-scheme`) and applied by a small inline script before first paint, so there is no flash.

The landing's controls are now `@ui-sdk/web` elements (vercel-labs/ui, 0.1.0-beta.2, pinned): `ui-switch` for the theme, `ui-field` with `ui-input` and `ui-button` for the form (native validation messages, server errors through the field's `invalid` state, pending submit), and `ui-preferences` with `createColorScheme` for the theme state. We chose the SDK's behaviors with our own styles because it is headless: no stylesheet comes with it, so the look stays ours. Colours are one `light-dark()` pair per token.

`web/landing.ts` replaces `landing/assets/app.js` and is bundled with the SDK by `vite.landing.config.ts` into `landing/assets/landing.js` (git-ignored build output, made by `bun run build`, which Wrangler runs on deploy). The package is a beta, which is the main risk; the pin and the bundled copy mean a release cannot change the page under us.

The review page honours the same saved choice: the key and the pre-paint script live once in `src/theme.ts`; the review shell and the bundle import them, and `tests/landing.test.ts` asserts that the static `landing/index.html` inlines the same script and that the SDK stores a bare `light` or `dark` value, so drift fails a test instead of flashing the wrong theme. `web/styles.css` now defines each review-page colour once as a `light-dark()` pair, with `color-scheme` set from `data-color-scheme`.

## Reviewer read budget and codemode output cap, 2026-11-14

Kimi K3.1 Pro reviews cost about $1.30 each, against about $0.08 on Sonnet 5.5. On the same 13-file PR, Kimi made 45 tool calls to Sonnet's 13: 25 `read_file` and 5 `list_dir` calls, mostly on files outside the diff, plus codemode scripts that raised `max_output_tokens` to 30,000–40,000 to dump whole files. Every result stays in the context that the agent resends each turn, so prompt tokens reached about 1.08M per review, against about 100k on Sonnet. 83% of the Kimi spend was uncached input.

`read_file` and `list_dir` now share a budget of 10 calls plus one per changed file, counted in the review document. Calls made from inside codemode scripts count too. Past the budget, the tools refuse and tell the agent to finish with what it has read and list the rest in `not_checked`, so the named owner sees what went unread. `read_patch` is outside the budget, because every changed patch must be read. A wrap on the codemode tool lowers any `max_output_tokens` above 10,000 to 10,000, the tool's default. The protocol now says to review the change rather than the repository, and to read version-pinning manifests rather than whole lock files.

A replayed `read_file` after a restart spends a second read. That makes the budget slightly stricter after a crash, which is acceptable for a cost guard. Verda's prompt caching (49% hit rate, against 78% on Sonnet) is a separate cost and is not addressed here.

## Practical landing, 2026-11-14

The landing now leads with the task. The header keeps only the brand and the theme switch; its "How it works" and "Review a PR" links pointed at content a few pixels away. The report anatomy illustration is gone: it described a report instead of showing one. The headline, form and examples sit in one centred column that fills the first screen.

Under the form, four small muted chips open finished reviews: our own PR #27 and agent-written PRs #1, #3 and #4 on our MessagePack-CSharp copy. They use report routes pinned to a head SHA, so the linked reports cannot change underneath the page. We picked them to cover the range: a feature PR with three findings, an agent-written fix with one, a new CI workflow whose scanner failed (the report shows the limit instead of hiding it), and a docs-only typo fix with no findings. The chips are deliberately quieter than the form, so pasting a PR stays the main action. If the deployment's review storage is reset, these links show "not started" and need replacing.
