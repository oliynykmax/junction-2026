---
version: 1
slug: "review-bot-web-app-tsx"
primary_target: "review-bot/web/app.tsx"
related_targets: ["review-bot/src/page.ts"]
---

# Review page

Mode: Operate. The named owner of an agent-written PR opens this from the bot's PR comment to judge the change on evidence. It restyles the live page; every current function stays (status, advisory decision, findings with class/confidence/source/location/suggested fix, scanner diagnostics and dismissals, not checked, docs consulted, cost, rubric, agent activity, polling).

## Direction contract

THESIS: A review read as a technical manual page: strict 12-column grid, one grotesk, flush left. It refuses the code-host card stack with coloured labels everywhere.
OWN-WORLD: White ground, near-black ink, two greys, hairline and 1px ink rules. Red is the only signal colour: critical/high findings, scanner errors, failed runs, changes requested. Tags are flat grey blocks. Hanken Grotesk for all text, JetBrains Mono only for paths, counts, versions, code. Logo yellow stays in the logo.
STORY: The owner sees status and the AI's advice, then what the scanners flagged, then each finding with its evidence, then what the AI did not check. They decide; nothing reads as approval.
FIRST VIEWPORT: Header bar with logo, product name and PR link over a 3px ink rule. Title row: repo#number left (8 cols), facts right (4 cols). Advice row. Scanner band between ink rules, red block for errors, clean tools in grey. Class filter row. Finding rows: title, tags, severity, location, Show fix in cols 1–4; body and fix in cols 5–12.
FORM: Swiss Documentation, safer-register grounded candidate revised over three user steers (no index numerals, refusals as neutral information, red for warnings, no zero counts, show-fix under counts). seed:66677bb010d6f501
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
