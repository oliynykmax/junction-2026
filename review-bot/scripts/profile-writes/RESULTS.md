# Review write profile, 2026-11-14

The local worker runs the production Review class with a scripted five-turn model, two findings, two documentation lookups, scanners, report reads, and a forced eviction during model inference. All outbound requests resolve through fixtures.

## Measurement

The comparison starts from remote main at `b1ca509`. Both arms include the findings snapshot fix and recovery logs. The baseline restores the original alarm scheduler and the alarm handler that forces `active: true`. The treatment coalesces nearby alarm deadlines and respects the actual wake state after an alarm fires.

Five alternating baseline and treatment pairs run with the same fixtures and dependency versions. The saved summary records each run. Workerd SQLite cursor counters include index writes. Alarm calls are counted separately as one row-write equivalent each. These are local measurements, not Cloudflare invoices. There is no latency claim.

The baseline permits a remaining alarm after completion so its known bug does not invalidate the write measurement. The treatment requires no remaining alarm. Both arms require a completed review with two findings and two lookups, no unexpected outbound requests, and successful recovery of an interrupted task after eviction. Warm and cold report reads must produce no recovery detections.

## Interpretation

The full lifecycle uses 936 row-write equivalents before and 930 after. The forced-restart scenario uses 983 before and 976 after. All five runs per side have these exact totals. SQL totals remain 920 and 969 respectively; only alarm mutations change. The completed review leaves an alarm in the baseline and none in the treatment. A cold report read falls from 5 to 3 row-write equivalents; warm reads write nothing.

The review itself writes 918 SQLite rows in the treatment. The tasks table accounts for 446. Writes solely to `review.state` account for 28 rows, with another 6 in statements that mix application and framework documents. The remaining SQL includes framework records, schema setup, and local worker metadata. The profile does not separate each task update's index overhead from its base row.

The task table accounts for the largest share of SQL writes. Saving a task also updates indexes. This profile does not justify changing pi-durable internals or removing checkpoints.

The alarm scheduler skips equivalent deadlines up to one second earlier, while preserving earlier sleep deadlines and the recovery heartbeat. The alarm handler also clears an idle alarm instead of forcing another heartbeat after completion. The profile covers deliberately delivered stray alarms, not a claim that production had an infinite alarm loop.

The findings snapshot fix copies primitive finding fields before pi-durable revokes its transaction draft. The regression test exercises webhook publication after the draft closes.

Recovery logs read running tasks before Harness.open resets their state. They emit structured objects with object and boot identifiers. A detected interruption, a successfully resumed task, and a completed review are separate observations. Failed endings without a phase span can remain unobserved. The README states scan, retention, and sampling limits.

## Reproduce

From review-bot, run `node scripts/profile-writes.mjs --repeats 5 --out profile.json` to capture the current implementation. Use `--allow-idle-alarm` only when measuring the original alarm handler. The full raw local traces and comparison driver are retained under `/home/kort/Work/j26/notes/write-profile/`.

The committed summary is [results/2026-11-14-ab.json](results/2026-11-14-ab.json). It cannot attribute historical production writes or count recoveries before deployment.
