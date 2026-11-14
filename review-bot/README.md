# Bumble Bot (GitHub App)

Cloudflare Worker `j26-review-bot`, live at https://review.oliinyk.dev. GitHub App: https://github.com/apps/bumble-bot-review, installed only on our copy of the sample repo, `oliynykmax/junction26-messagepack-csharp`.

When a pull request is opened, reopened, marked ready or pushed to, the bot starts an AI review of the head commit. It maintains one comment linking to the full report for that commit. On completion, it posts a GitHub comment review with a short count summary such as `2 findings · 1 medium · 1 low`, the risk tier with the review depth it asks for, and a full-report link pinned to the reviewed commit. The bot never approves a PR, even one with no findings: its review is advice, and a named human approves the merge. Publication skips stale heads and retries skip an existing marked review for that commit. Each push dismisses any approval the bot posted before it stopped approving. Set `REVIEW_BASE_URL` in `wrangler.jsonc` to send the link elsewhere.

## Review runtime

Each (PR, head commit) gets its own Durable Object, `Review` in `src/review.ts`. It runs a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 Harness on the object's SQLite storage. Model turns, tool calls and findings are committed before they are shown. An alarm heartbeat resumes the run if the object is evicted mid-review. A repeated webhook for the same commit finds the review already started.

Before the agent starts, a durable `review.scan` task picks scanners from the changed files (`src/scanners.ts`). It calls the Modal scanner in `../scanner/`: zizmor for workflows, ty for Python, oxlint for JS and TS. It stores the results and submits the review input in one commit. The agent must confirm each diagnostic as a finding tagged with its tool, or dismiss it with a reason. A failed scan never blocks the review. The agent lists it as not checked.

In the same task, `src/signals.ts` computes deterministic signals from the full patches, with no model involved:

- **Test-change lane.** For every changed test file it counts tests and assertions added and removed and skip markers added (xUnit, NUnit, MSTest, Jest/Vitest, pytest, Go). A deleted test file, a net loss of tests or assertions, or a new skip marks the file as weakened. Coding agents most often cheat by editing tests, and LLM monitors miss much of it, so this is a diff count rather than a judgement. It counts net per file, so it cannot see a loosened assertion that keeps the same count, or tests removed from a file that gained as many unrelated ones.
- **Risk tier.** Plain rules set `low`, `medium` or `high`, each with a stated reason and the files it names: weakened tests, serializer formatters or resolvers, unsafe or raw-memory code, CI workflows and security paths (high); source generator and analyzer code, public API files, build and dependency files, production code with no test change, more than 500 changed lines or 25 files, and files GitHub sent no diff for (medium). The tier sets how deeply the named owner reads, and the files named by rules at that tier are listed to read in full. It routes attention and never changes the decision. The path rules are tuned for this repo and MessagePack-CSharp and live in one table, `RULES`.

The agent sees both in a `risk_signals` section, cannot change the tier, and must either report a finding for each weakened test file or say in its summary why the requirement made the old test wrong.

The agent (`src/reviewer.ts`) has read-only GitHub tools: `pr_overview`, `read_patch`, `read_file` (head or base) and `list_dir`. It has no shell and no checkout. It records each finding with `report_finding`, giving a severity (`critical`, `high`, `medium`, `low` or `info`), a class (`correctness`, `security`, `reliability`, `performance`, `breaking-change`, `maintainability`, `testing` or `docs`) and a confidence (`verified`, `likely` or `possible`). It describes the PR for the owner with `describe_change`, once per logical change: a title, one to three tags, one sentence each for Situation, Task, Action and Result, and the changed files it covers. It ends with `finish_review`.

- **Code mode.** pi-durable's `codemode` extension lets the agent run a JavaScript script that calls the other tools, so it can read several patches in one turn. Scripts run in QuickJS inside the Durable Object (`createInlineCodemodeSandbox` from `@earendil-works/pi-codemode/cloudflare`). The model catalog globals are turned off.
- **MCP.** `MCP_SERVERS` in `wrangler.jsonc` lists Streamable HTTP MCP servers, in the usual `mcpServers` shape. `src/mcp.ts` connects to each one with `@earendil-works/pi-mcp` when the object starts, and turns its tools into `mcp__<server>__<tool>`. Those tools can be called only from code mode scripts, so they don't fill the model's tool list. A server that does not answer within 8 s is left out of that run. Stdio servers are refused, because Workers cannot start processes. Header values may name a Worker secret as `${NAME}`, and `tools` limits a server to the listed tool names. The defaults are Context.dev (`web-search` and `web-scrape` only, key in the `CONTEXT_DEV_API_KEY` secret) and Microsoft Learn (.NET and C# docs, no key).
- **Docs gate.** Every MCP call is recorded in the review document and listed on the page under "Docs consulted". `finish_review` refuses, up to twice, while no documentation has been looked up. After that the review finishes, and "Not checked" says the agent's library and platform claims came from memory.
- **Change gate.** The scan task stores every changed file with its line counts and patch (patches over 20 KB, or past 200 KB in total, are dropped). `finish_review` also refuses, up to twice, while a changed file belongs to no described change; after that the uncovered files are listed under "Not checked".

The `finish_review` call holds a summary for the human owner, the dismissed scanner diagnostics and a list of what the agent did not check. The advisory decision is derived from the findings, not chosen by the agent: any `critical` or `high` finding rated `verified` or `likely` makes it `changes_requested`. A `possible` one is shown for the owner to check but does not change the decision. These are stored in the `review.state` document.

- **Rubric.** `REVIEW_PROMPT_URL` points at Cursor's [thermo-nuclear code quality review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) prompt, pinned to a commit. Each review fetches it once and stores the text and its sha256, so the page shows exactly which rubric ran. The prompt is fetched, not copied here, because that repo has no license.
- **Model.** `MODEL_ID` (`claude-sonnet-5-5`) with `THINKING_LEVEL` `medium`, through the Anthropic API.
- **Page.** `/r/<owner>/<repo>/<pr>?sha=<head>` (and `/m/...` for manual reviews) is a Preact + Vite client in `web/`, built into `../landing/review/` and served from the Worker's assets. It shows the status, the advisory decision, a review-depth band with the risk tier, its reasons, the files to read in full and the test-change lane, and a scanner band with each scanner's diagnostics and the agent's dismissals. The **Changes** view lists each described change with its tags, line counts, STAR sentences and the findings in its files; "Show diff" opens the change's patches inline, and selecting a finding's location dims every other line. The **Full diff** view shows every file with finding lines marked. Findings outside any change, what was not checked, docs consulted, cost and the agent's tool calls follow. Reviews stored before changes existed keep a plain findings list. It polls `/api/r/<owner>/<repo>/<pr>/<sha>` every 2 s (manual reviews every 15 s) while the review runs.

## Develop

```sh
bun install
bun fmt        # format
bun lint
bun check      # type check
bun test       # GitHub publication behavior
bunx wrangler dev   # local run; secrets go in .dev.vars (gitignored)
```

CI (`.github/workflows/review-bot.yml`) runs `bun fmt --check`, `bun lint`, `bun check` and `bun test` on Bun canary for every PR and push that touches `review-bot/`. A push to `main` then deploys with `wrangler deploy`, using the repo secret `CLOUDFLARE_API_TOKEN`.

## Secrets

`APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY` (PKCS#8 PEM), `ANTHROPIC_API_KEY` and `SCANNER_TOKEN` are Worker secrets, set with `bunx wrangler secret put <NAME>`. Deploys keep them. Max holds local copies outside git.

## Public landing and manual reviews

The Worker serves the static landing from `../landing` through `ASSETS`.
`POST /api/reviews` accepts JSON `{ "url": "https://github.com/owner/repo/pull/123" }`
and returns `{ "url": "/m/owner/repo/123?sha=<head>" }`.
Only publicly readable repositories are accepted. Manual reviews use anonymous GitHub
reads and never obtain app tokens, post comments, or approve PRs. Their persisted targets,
Durable Object keys, and report API paths are separate from webhook reviews.

`MANUAL_GATE` limits new public reviews to two per IP per hour, ten globally per
hour, and fifty per day. The demo accepts at most 60 files and 4,000 changed lines.
Failed resolutions and stored reviews do not spend review slots. Duplicate concurrent
admissions are charged once per pinned review key. A separate lookup budget limits
resolution attempts to ten per IP per hour, thirty globally per hour and one hundred
per day before any GitHub calls. Anonymous GitHub API quotas can still interrupt reviews.
Manual report reads use only the stored manual target verified public at admission;
historical public evidence remains readable if a repository later becomes private. See [the decision log](../landing/DECISIONS.md)
for the integration choice and limits. Deploy the scanner's anonymous-read header change
through its separate deployment process as well; no scanner credential is sent to GitHub.

Run `bun test`, `bun lint`, `bun check`, and `bun fmt --check` from `review-bot/`.
