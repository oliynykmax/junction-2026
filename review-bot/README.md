# Bumble Bot (GitHub App)

Cloudflare Worker `j26-review-bot`, live at https://review.oliinyk.dev. GitHub App: https://github.com/apps/bumble-bot-review, installed only on our copy of the sample repo, `oliynykmax/junction26-messagepack-csharp`.

When a pull request is opened, reopened, marked ready or pushed to, the bot starts an AI review of the head commit. It maintains one comment linking to the full report for that commit. On completion, it posts a formal GitHub review with a short count summary such as `2 findings · 1 medium · 1 low` and a full-report link pinned to the reviewed commit. A review with no findings approves the PR only when its CI snapshot shows explicit success and its team standard is available or genuinely absent. Missing, pending, failed, or unreadable evidence produces a comment review instead. Any findings produce a comment review, regardless of the advisory decision. Publication skips stale heads and retries skip an existing marked review for that commit. Each push dismisses the bot's approvals of older commits. The review remains advice; a named human owns the merge. Set `REVIEW_BASE_URL` in `wrangler.jsonc` to send the link elsewhere.

## Review runtime

Each (PR, head commit) gets its own Durable Object, `Review` in `src/review.ts`. It runs a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2 Harness on the object's SQLite storage. Model turns, tool calls and findings are committed before they are shown. An alarm heartbeat resumes the run if the object is evicted mid-review. A repeated webhook for the same commit finds the review already started.

Before the agent starts, a durable `review.scan` task picks scanners from the changed files (`src/scanners.ts`). It calls the Modal scanner in `../scanner/`: zizmor for workflows, ty for Python, oxlint for JS and TS. It stores the results and submits the review input in one commit. The agent must confirm each diagnostic as a finding tagged with its tool, or dismiss it with a reason. A failed scan never blocks the review. The agent lists it as not checked.

The agent (`src/reviewer.ts`) has read-only GitHub tools: `pr_overview`, `read_patch`, `read_file` (head or base) and `list_dir`. It has no shell and no checkout. It records each finding with `report_finding`, giving a severity (`critical`, `high`, `medium`, `low` or `info`), a class (`correctness`, `security`, `reliability`, `performance`, `breaking-change`, `maintainability`, `testing` or `docs`) and a confidence (`verified`, `likely` or `possible`). It describes the PR for the owner with `describe_change`, once per logical change: a title, one to three tags, one sentence each for Situation, Task, Action and Result, and the changed files it covers. It ends with `finish_review`.

- **Code mode.** pi-durable's `codemode` extension lets the agent run a JavaScript script that calls the other tools, so it can read several patches in one turn. Scripts run in QuickJS inside the Durable Object (`createInlineCodemodeSandbox` from `@earendil-works/pi-codemode/cloudflare`). The model catalog globals are turned off.
- **MCP.** `MCP_SERVERS` in `wrangler.jsonc` lists Streamable HTTP MCP servers, in the usual `mcpServers` shape. `src/mcp.ts` connects to each one with `@earendil-works/pi-mcp` when the object starts, and turns its tools into `mcp__<server>__<tool>`. Those tools can be called only from code mode scripts, so they don't fill the model's tool list. A server that does not answer within 8 s is left out of that run. Stdio servers are refused, because Workers cannot start processes. Header values may name a Worker secret as `${NAME}`, and `tools` limits a server to the listed tool names. The defaults are Context.dev (`web-search` and `web-scrape` only, key in the `CONTEXT_DEV_API_KEY` secret) and Microsoft Learn (.NET and C# docs, no key).
- **Docs gate.** Every MCP call is recorded in the review document and listed on the page under "Docs consulted". `finish_review` refuses, up to twice, while no documentation has been looked up. After that the review finishes, and "Not checked" says the agent's library and platform claims came from memory.
- **Change gate.** The scan task stores every changed file with its line counts and patch (patches over 20 KB, or past 200 KB in total, are dropped). `finish_review` also refuses, up to twice, while a changed file belongs to no described change; after that the uncovered files are listed under "Not checked".

The `finish_review` call holds a summary for the human owner, the dismissed scanner diagnostics and a list of what the agent did not check. The advisory decision is derived from the findings, not chosen by the agent: any `critical` or `high` finding rated `verified` or `likely` makes it `changes_requested`. A `possible` one is shown for the owner to check but does not change the decision. These are stored in the `review.state` document.

- **Rubric.** `REVIEW_PROMPT_URL` points at Cursor's [thermo-nuclear code quality review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) prompt, pinned to a commit. Each review fetches it once and stores the text and its sha256, so the page shows exactly which rubric ran. The prompt is fetched, not copied here, because that repo has no license.
- **Model.** `MODEL_ID` (`claude-sonnet-5-5`) with `THINKING_LEVEL` `medium`, through the Anthropic API.
- **Page.** `/r/<owner>/<repo>/<pr>?sha=<head>` (and `/m/...` for manual reviews) is a Preact + Vite client in `web/`, built into `../landing/review/` and served from the Worker's assets. It shows the status, the advisory decision and a scanner band with each scanner's diagnostics and the agent's dismissals. The **Changes** view lists each described change with its tags, line counts, STAR sentences and the findings in its files; "Show diff" opens the change's patches inline, and selecting a finding's location dims every other line. The **Full diff** view shows every file with finding lines marked. Findings outside any change, what was not checked, docs consulted, cost and the agent's tool calls follow. Reviews stored before changes existed keep a plain findings list. It polls `/api/r/<owner>/<repo>/<pr>/<sha>` every 2 s (manual reviews every 15 s) while the review runs.

## Recovery logs

`src/lifecycle.ts` logs one structured object per lifecycle event to the Worker console, which Workers Logs indexes by field. It never writes to storage and never logs prompts, tool arguments or secrets. Every event carries `objectId` (the Durable Object id) and `bootId` (new on each instance start), so one review can be followed across restarts.

- `review.boot`: every instance start, with `interruptedTasks`. An idle cold open, such as a report read of a finished review, logs `0`.
- `review.recovery_detected`: tasks still `running` in storage when the instance started, read with `scanTasks` before `Harness.open`. Only a process that died mid-phase leaves one. Each task has its `taskId`, `taskName`, `taskPhase` and earlier `restarts`.
- `review.recovery_phase`: an interrupted task ran its phase again in this boot, with the phase `outcome`.
- `review.recovery_task_ended`: an interrupted task reached `done`, `faulted` or `aborted`.
- `review.alarm`: an alarm fired. `workActive` is the wake before the heartbeat is re-armed. A heartbeat on a healthy run logs this with no detection.
- `review.finished`: `finish_review` committed a verdict, with the decision and finding count. A replayed tool call can log it again.

A task recovery is confirmed when `recovery_detected` is followed by `recovery_task_ended` with `done` for the same `objectId` and `taskId`. To count reviews that completed after recovery, also require a later `review.finished` for that object. Count distinct `objectId` values for reviews, and `objectId` plus `bootId` for interrupted boots. Detection alone does not prove success. The scan reads one page of 50 running tasks, and `scanComplete: false` says more existed. The logs do not see a process that dies before `review.boot` is written. They also do not see work that was queued but never started, because that work loses nothing.

In the Worker's Observability tab, filter `event` to `review.recovery_detected`, then filter by `objectId` to follow the task outcomes and verdict across boots. These counts start after deployment and cannot establish past recoveries.

Task endings are observed through phase spans. A failure settled without a phase, such as a restart-limit failure or a cascaded abort, may have no `review.recovery_task_ended` event. A missing terminal event means the outcome is unknown, not success.

`observability.enabled` keeps the default head sampling rate of 1, so every invocation is logged. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) keeps logs 3 days on Workers Free and 7 days on Workers Paid. Free accounts get 200,000 log events per day, and oversized lines are truncated. Query older history before it expires.

## Operations dashboard

`/dashboard` (also `/dashbaord`, which redirects) is a public page that lists every review since the ledger was deployed. It shows each review's status, decision and estimated model cost. It also shows prompt-cache use per model, Modal scan and MCP call counts with latency, recoveries and a newest-first event log. It polls `/api/dashboard` every 15 s while the tab is visible. Responses are `no-store`. The client is `web/dashboard.tsx`, a second Vite input built to `/review/dashboard.js` beside the review page.

The data comes from a D1 ledger, binding `LEDGER`, database `bumble-review-ledger`, schema in `migrations/`. Each `Review` object writes its own rows at a few boundaries (`src/ledger.ts`):

- The run row is upserted after `start()` commits, when `finish_review` commits a verdict, and when work stops (`onWake` reports inactive after the boot saw it active). Each upsert holds the status, decision, finding count, failure class and a per-model usage snapshot from `harness.usage()`. Updates apply only to changed values, so a repeat or a cold reopen writes no rows.
- Events are typed rows: `modal` (wall time, HTTP status, check count), `mcp` (server and tool, ok, wall time), `mcp_connect`, `github_token` (cache hit or miss) and `lifecycle` (status changes, `finished`, recovery detection and task ends). They buffer in memory, up to 200 per boot and 500 written per boot. They flush at 20, on each alarm, after a Modal scan and with each run upsert. Drops are counted and shown.
- A boot that finds interrupted tasks writes a `recoveries` row. When the run ends it resolves to `recovered` (scan complete, every interrupted task ended `done`, verdict committed), `failed` or `unverified`. An open row followed by a later detection on the same object is shown as superseded.

The ledger never holds prompts, tool arguments or output, failure text, tokens or secrets. A failure is one of `model_error`, `no_finish`, `scanner`, `github`, `aborted` or `other` (`src/status.ts`). Every ledger call is synchronous, never throws and writes through `waitUntil`, so a D1 outage only logs `ledger.write_failed`. Without the binding (as in the write profile) the ledger does nothing. The write profile's Durable Object row counts are unchanged with the ledger bound.

Limits stated on the page. Runs before the migration are not collected. A run last seen running more than 15 minutes ago is `stale`, outcome unknown. Events buffered in an evicted object are lost, so call counts are a lower bound. Model cost is pi's list-price estimate. Cloudflare, Modal and MCP billing are unavailable. A daily cron (`17 3 * * *`) deletes events older than 30 days. Run rows are kept.

Set up once, then deploy:

```sh
bunx wrangler d1 migrations apply bumble-review-ledger --remote
```

## Write profile

`node scripts/profile-writes.mjs --repeats 5 --out profile.json` runs the `Review` object on local workerd with every outbound request answered by fixtures (`scripts/profile-writes/worker.ts`): no model, GitHub, scanner or MCP traffic. It runs a scripted five-turn review, repeat starts, warm and cold report reads and alarms after completion, and an eviction while a model request hangs. For each phase it reports SQLite cursor `rowsWritten` by table and statement, split into pi-durable records and the `review.state` document. It also reports `setAlarm` and `deleteAlarm` calls, which Cloudflare bills as row writes. It asserts the review's work and the recovery logs, and exits nonzero when a check fails. It runs on Node, because wrangler cannot forward requests to a local Worker under Bun. Results from 2026-11-14 are in `scripts/profile-writes/results/`.

## CI and team standards

Before the agent starts, the review stores one evidence snapshot alongside the scanner workflow. Both the prompt and report use that same snapshot. Replays keep the committed snapshot.

CI evidence includes check runs and legacy commit statuses for the exact reviewed head SHA. The collector follows pagination and keeps the newest legacy status per context. Permission errors, timeouts, malformed responses, and incomplete pagination remain visible alongside any usable results. Empty, pending, failed, unavailable, and successful evidence stay distinct. Skipped and neutral checks do not count as explicit success. The report shows the capture time and links to the original results. A snapshot does not track later CI changes or establish that branch-protection requirements are satisfied.

The GitHub App needs **Checks: read** and **Commit statuses: read**, in addition to its existing contents permission. Installations must accept those permissions. Actions access is not required. Until access is granted, reviews still run and disclose the evidence gap, but they cannot approve.

The collector reads root `CODING_STANDARDS.md` from the base repository at the base SHA captured in the signed PR webhook. A PR that edits, removes, or introduces the file cannot change its own review criteria. The report records the base repository, commit, Git blob SHA, SHA-256 digest, and exact text. Standards must be UTF-8 and no larger than 32 KiB. An inaccessible, invalid, or oversized standard is disclosed and prevents approval. A confirmed absent file falls back to the existing rubric. Standard text supplies review criteria and cannot override the review protocol or grant tool permissions.

Older reviews retain their original findings. Their report shows that no evidence snapshot was captured. New publication attempts without complete evidence produce comments.

## Develop

```sh
bun install
bun fmt        # format
bun lint
bun check      # type check
bun test       # evidence, review flow, report rendering, and publication
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
