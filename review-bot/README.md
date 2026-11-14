# Review bot (GitHub App)

Cloudflare Worker `j26-review-bot`, live at https://review.oliinyk.dev. GitHub App: https://github.com/apps/j26-earned-trust-review, installed only on our copy of the sample repo, `oliynykmax/junction26-messagepack-csharp`.

When a pull request is opened, reopened, marked ready or pushed to, the bot starts an AI review of the head commit. It also posts one comment linking to `https://review.oliinyk.dev/r/<owner>/<repo>/<pr>?sha=<head>`, and later pushes edit that comment. Set `REVIEW_BASE_URL` in `wrangler.jsonc` to send the link elsewhere.

## Review runtime

Each (PR, head commit) gets its own Durable Object, `Review` in `src/review.ts`. It runs a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 Harness on the object's SQLite storage. Model turns, tool calls and findings are committed before they are shown. An alarm heartbeat resumes the run if the object is evicted mid-review. A repeated webhook for the same commit finds the review already started.

Before the agent starts, a durable `review.scan` task picks scanners from the changed files (`src/scanners.ts`). It calls the Modal scanner in `../scanner/`: zizmor for workflows, ty for Python, oxlint for JS and TS. It stores the results and submits the review input in one commit. The agent must confirm each diagnostic as a finding tagged with its tool, or dismiss it with a reason. A failed scan never blocks the review. The agent lists it as not checked.

The agent (`src/reviewer.ts`) has read-only GitHub tools: `pr_overview`, `read_patch`, `read_file` (head or base) and `list_dir`. It has no shell and no checkout. It records each finding with `report_finding` and ends with `finish_review`. That call holds an advisory decision, a summary for the human owner, and a list of what it did not check. These are stored in the `review.state` document.

- **Rubric.** `REVIEW_PROMPT_URL` points at Cursor's [thermo-nuclear code quality review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) prompt, pinned to a commit. Each review fetches it once and stores the text and its sha256, so the page shows exactly which rubric ran. The prompt is fetched, not copied here, because that repo has no license.
- **Model.** `MODEL_ID` (`claude-sonnet-5-5`) with `THINKING_LEVEL` `medium`, through the Anthropic API.
- **Page.** `/r/<owner>/<repo>/<pr>?sha=<head>` shows the status, the advisory decision, findings by severity (linked to the line at that commit, tagged by source, with any suggested fix), each scanner's raw diagnostics and the agent's dismissals, what was not checked, cost and the agent's tool calls. It polls `/api/r/<owner>/<repo>/<pr>/<sha>` every 2 s while the review runs.

## Develop

```sh
bun install
bun fmt        # format
bun lint
bun check      # type check
bunx wrangler dev   # local run; secrets go in .dev.vars (gitignored)
```

CI (`.github/workflows/review-bot.yml`) runs `bun fmt --check`, `bun lint` and `bun check` on Bun canary for every PR and push that touches `review-bot/`. A push to `main` then deploys with `wrangler deploy`, using the repo secret `CLOUDFLARE_API_TOKEN`.

## Secrets

`APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY` (PKCS#8 PEM), `ANTHROPIC_API_KEY` and `SCANNER_TOKEN` are Worker secrets, set with `bunx wrangler secret put <NAME>`. Deploys keep them. Max holds local copies outside git.
