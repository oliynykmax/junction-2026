# Formal review receipts verification

2026-11-14. Runtime commit `7ddd6854d6e817e9065d0f06df432aa9008e23cc`.

## Integration and decisions

The runtime requires a verification disposition for every changed file so the named owner can inspect bounded evidence and unresolved checks before accepting the change.

- The original staged work, including benchmarks, is preserved on `feat/formal-receipts` at checkpoint `26bc516`. Benchmark files are outside this integration branch.
- The integration starts at fetched `origin/feat/review-prompt-shell`, `60db944c7a653710fb9300ae97f0957268e46c8f`. That base includes the `e0384be` base-fetch fix.
- The receipt implementation comes from historical `274cc27`. The checkpoint's completion verification skill is retained. Its Go-only pilot copy was not adopted because the requested runtime supports multiple verification methods.
- The base protocol intro and steps 1, 3, and 7 match byte-for-byte. The shell remains unrestricted. No executor authentication or base-fetch behavior changed.
- `record_verification` validates concise fields, changed-file membership, assumptions, limits and outcome disclosures. A reported pass requires mutation evidence. The receipt is persisted in `ReviewDoc` and included by the existing review API serialization.
- `finish_review` cannot settle a changed review until receipts cover every changed path. This gate has no retry bypass. A disclosed `not_run` disposition permits completion and remains unverified in the UI.
- Receipt content is agent-reported. The runtime enforces structure and coverage, not checker execution or result authenticity. The UI says this explicitly. A receipt never approves a PR or replaces the named owner.
- The tracked `verify-pr-change` skill runs alongside the existing review rubric. Text imports bundle its instructions and provisioning script into the runtime. `checkout_pr` installs both in a sibling directory outside the external checkout. Installation failures are disclosed. Skill-only edits trigger the review-bot workflow.

## Observed checks

Commands ran from `review-bot/` with Bun `1.4.4-canary.1`, revision `b1305ddc7`, using the current `bun.lock`.

- `bun install --frozen-lockfile` succeeded without lockfile changes.
- `bun test` passed 241 tests across 24 files, with zero failures.
- After the last source cleanup, `bun test tests/changes.test.ts tests/formal.test.ts tests/verification-skill.test.ts tests/reviewer.test.js` passed all 35 relevant tests.
- `bunx tsc --noEmit`, `bun run lint`, and `bun fmt --check` passed.
- `bun run build` and `bun run celld:prepare` passed.
- `CELLD_ESBUILD=./node_modules/.bin/esbuild celld deploy celld.json --dry-run --bucket s3://ci-build-only` bundled the Worker and assets. CellD reported a dry run with nothing written. This did not deploy or upload an artifact.
- `git diff --check` passed. No README or benchmark files changed relative to the integration base.

### Bounded completion property

The test named `finish gate rejects every incomplete receipt set in a two-file review` invokes the actual `finish_review` tool with the empty set, each singleton and the complete set of receipts. Incomplete sets leave the verdict null and return an error. The complete set stores a verdict.

For fault sensitivity, a temporary edit replaced `if (unverified.length)` with `if (false && unverified.length)`. The same test failed because the empty receipt set stored a `no_blockers_found` verdict. The source was restored in a `finally` block. Rerunning the test passed all four subsets with 11 assertions.

Reproduce the normal check with:

```sh
bun test tests/changes.test.ts -t "finish gate rejects every incomplete receipt set in a two-file review"
```

The completion verification skill records the scratch mutation procedure. Additional tests cover repeated incomplete completion attempts, rejection of invalid pass claims, unknown files, empty fields, oversized mutation reports, and persistence of explicit counterexample and unrun outcomes.

### Skill installation and UI evidence

The installation test executes the runtime-generated Bash command in an empty external checkout whose path contains an apostrophe. It compares installed instructions and the provisioning script with the tracked source, checks Bash syntax, and confirms the reviewed checkout remains empty.

The generated command also ran successfully in `docker.io/library/node:22-bookworm-slim` through Podman with networking disabled. `cmp` confirmed byte-for-byte copies of both assets, and `bash -n` passed inside Podman. Temporary test artifacts were removed.

Server-rendered UI tests distinguish reported passes, counterexamples and unverified checks, and include mutation evidence, limits and the result-authenticity disclosure. Vite built the integrated live page and synthetic `?formal-demo=all` view.

## Limits and remaining review

This is bounded testing of the real completion tool with an in-memory transaction harness. It is not a formal proof for arbitrary file counts, concurrent Durable Object transactions, restart persistence, or every path that can terminate an agent run.

No external verifier download or pinned toolchain build was run for this integration. The existing provisioning script remains unchanged and may require additional prerequisites or exceed a shell call's 15-minute limit. Setup failures must become explicit unrun receipts. A successful script installation is not a successful verifier run.

No live model review, public deployment, or browser layout walkthrough was performed. UI evidence consists of rendered markup and a production build. Independent review belongs to the parent before opening the stacked draft. Nothing was pushed, deployed or merged.

The existing Vite landing build emits an `inlineDynamicImports` deprecation warning and still succeeds.
