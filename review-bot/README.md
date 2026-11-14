# Bumble Bot (GitHub App)

Cloudflare Worker `j26-review-bot`, live at https://review.oliinyk.dev. GitHub App: https://github.com/apps/bumble-bot-review, installed only on our copy of the sample repo, `oliynykmax/junction26-messagepack-csharp`.

When a pull request is opened, reopened, marked ready or pushed to, the bot starts an AI review of the head commit. It also posts one comment linking to `https://review.oliinyk.dev/r/<owner>/<repo>/<pr>?sha=<head>`, and later pushes edit that comment, which says so. When a review ends with `no_blockers_found` and no findings, the bot approves the PR at that commit, provided the commit is still the head. Each push dismisses the bot's approvals of older commits, so an approval always belongs to a clean review of the current head. Set `REVIEW_BASE_URL` in `wrangler.jsonc` to send the link elsewhere.

## Review runtime

Each (PR, head commit) gets its own Durable Object, `Review` in `src/review.ts`. It runs a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 Harness on the object's SQLite storage. Model turns, tool calls and findings are committed before they are shown. An alarm heartbeat resumes the run if the object is evicted mid-review. A repeated webhook for the same commit finds the review already started.

Before the agent starts, a durable `review.scan` task picks scanners from the changed files (`src/scanners.ts`). It calls the Modal scanner in `../scanner/`: zizmor for workflows, ty for Python, oxlint for JS and TS. It stores the results and submits the review input in one commit. The agent must confirm each diagnostic as a finding tagged with its tool, or dismiss it with a reason. A failed scan never blocks the review. The agent lists it as not checked.

The agent (`src/reviewer.ts`) has read-only GitHub tools: `pr_overview`, `read_patch`, `read_file` (head or base) and `list_dir`. It has no shell and no checkout. It records each finding with `report_finding`, giving a severity (`critical`, `high`, `medium`, `low` or `info`), a class (`correctness`, `security`, `reliability`, `performance`, `breaking-change`, `maintainability`, `testing` or `docs`) and a confidence (`verified`, `likely` or `possible`). It ends with `finish_review`.

- **Code mode.** pi-durable's `codemode` extension lets the agent run a JavaScript script that calls the other tools, so it can read several patches in one turn. Scripts run in QuickJS inside the Durable Object (`createInlineCodemodeSandbox` from `@earendil-works/pi-codemode/cloudflare`). The model catalog globals are turned off.
- **MCP.** `MCP_SERVERS` in `wrangler.jsonc` lists Streamable HTTP MCP servers, in the usual `mcpServers` shape. `src/mcp.ts` connects to each one with `@earendil-works/pi-mcp` when the object starts, and turns its tools into `mcp__<server>__<tool>`. Those tools can be called only from code mode scripts, so they don't fill the model's tool list. A server that does not answer within 8 s is left out of that run. Stdio servers are refused, because Workers cannot start processes. Header values may name a Worker secret as `${NAME}`, and `tools` limits a server to the listed tool names. The defaults are Context.dev (`web-search` and `web-scrape` only, key in the `CONTEXT_DEV_API_KEY` secret) and Microsoft Learn (.NET and C# docs, no key).
- **Docs gate.** Every MCP call is recorded in the review document and listed on the page under "Docs consulted". `finish_review` refuses, up to twice, while no documentation has been looked up. After that the review finishes, and "Not checked" says the agent's library and platform claims came from memory.

The `finish_review` call holds a summary for the human owner, the dismissed scanner diagnostics and a list of what the agent did not check. The advisory decision is derived from the findings, not chosen by the agent: any `critical` or `high` finding rated `verified` or `likely` makes it `changes_requested`. A `possible` one is shown for the owner to check but does not change the decision. These are stored in the `review.state` document.

- **Rubric.** `REVIEW_PROMPT_URL` points at Cursor's [thermo-nuclear code quality review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) prompt, pinned to a commit. Each review fetches it once and stores the text and its sha256, so the page shows exactly which rubric ran. The prompt is fetched, not copied here, because that repo has no license.
- **Model.** `MODEL_ID` (`claude-sonnet-5-5`) with `THINKING_LEVEL` `medium`, through the Anthropic API.
- **Page.** `/r/<owner>/<repo>/<pr>?sha=<head>` shows the status, the advisory decision, findings by severity with their class and confidence (linked to the line at that commit, tagged by source, with any suggested fix), each scanner's raw diagnostics and the agent's dismissals, what was not checked, cost and the agent's tool calls. It polls `/api/r/<owner>/<repo>/<pr>/<sha>` every 2 s while the review runs.

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

## Public landing and manual reviews

The Worker serves the static landing from `../landing` through `ASSETS`.
`POST /api/reviews` accepts JSON `{ "url": "https://github.com/owner/repo/pull/123" }`
and returns `{ "url": "/m/owner/repo/123?sha=<head>" }`.
Only publicly readable repositories are accepted. Manual reviews use anonymous GitHub
reads and never obtain app tokens, post comments, or approve PRs. Their persisted targets,
Durable Object keys, and report API paths are separate from webhook reviews.

`MANUAL_GATE` limits public start attempts to two per IP per hour, ten globally per
hour, and fifty per day. The demo accepts at most 60 files and 4,000 changed lines.
Anonymous GitHub API quotas can interrupt reviews. Manual report reads recheck repository
visibility before returning stored evidence. See [the decision log](../landing/DECISIONS.md)
for the integration choice and limits. Deploy the scanner's anonymous-read header change
through its separate deployment process as well; no scanner credential is sent to GitHub.

Run `bun test`, `bun lint`, `bun check`, and `bun fmt --check` from `review-bot/`.
