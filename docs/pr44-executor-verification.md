# PR 44 executor isolation verification

Verified locally on 2026-11-14. No VM deployment, live service change, push or PR publication was performed.

## Boundary decision

Two viable shapes were considered. A Node broker on the host could fetch credentials privately and create review containers, but would require provisioning and maintaining the host Node runtime. A manager image with a private Podman API socket can provision Node and Git in the image and create sibling workers through the host engine. This implementation chooses the manager image. It preserves the checkout and shell request/result shapes and the opaque `/tmp/bumble-review-shell/<session-hash>/repo` workspace inside each worker, including writable sibling paths for later skill installation.

The manager is trusted host administration code. Each review gets a credential-free worker with its own filesystem, PID and IPC namespaces and a separate bridge network with `isolate=true`. The Verda host runs netavark 1.4.0, which rejects `isolate=strict` when a worker starts, so `true` is the strongest value it accepts. It keeps workers apart from other bridge networks but does not block services the host listens on at the bridge gateway. Upgrade netavark to 1.9 or later to use `strict`. Workers have root and outbound networking. They receive no host mounts, manager socket, executor token or GitHub token. Fetching runs only in the manager; authentication is in the Git subprocess environment, outside every worker PID namespace. The copied `.git` has a token-free remote and includes the pinned head, optional base and history. Checkout metadata no longer dirties the repository.

## Reproductions and findings

| Finding                  | Disposition and executable evidence                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12, host loopback        | Fixed. A real Podman worker using the old host-network setting reached a synthetic host-loopback control-plane listener. The isolated worker cannot reach that listener. The manager API is published only on host loopback.                                                                                                                                                  |
| 13, credential argv      | Fixed. Git credentials never enter argv, worker environment or worker filesystem. A live worker scans process command lines and environments for broker and authentication markers. Fetching happens in another container/PID namespace.                                                                                                                                      |
| 14, origin token wording | Fixed. The deployment guide explicitly names `ORIGIN_TOKEN` for Caddy and gives `EXECUTOR_TOKEN` a separate scope.                                                                                                                                                                                                                                                            |
| 17, timeout/disconnect   | Fixed. The original Node mechanism exited Bash in 53 ms but did not close inherited pipes until its child exited at 2006 ms. The replacement bounds process groups and removes the entire worker with zero stop grace on timeout or disconnect. Live HTTP tests use `setsid` grandchildren sleeping 300 seconds, require timely settlement, and verify the worker disappears. |
| 18, shared checkouts     | Fixed. One worker writes a root-level private sentinel, while another cannot see it or the broker, socket or credentials. Checkout reset restores a clean pinned tree. Terminal release, idle expiry, restart and shutdown remove execution containers. Cleanup selects an exact deployment label; an unrelated differently labelled container survives.                      |
| 19, resources            | Fixed for CPU, memory, PID and concurrency exhaustion. Live inspection checks 1.5 CPUs, 4 GiB memory and 512 PIDs per worker. At most two sessions are admitted. Manager service budgets are 0.5 CPU, 1 GiB memory and 256 PIDs. Shell deadlines are 15 minutes, idle expiry ten minutes, absolute lifetime 45 minutes. Disk is bounded by the watchdog described below.                |

Same-session concurrent shell and checkout requests fail with `session busy`. A checkout that arrives while the idle reaper is still removing that session's worker waits for the removal and then checks out fresh. The live test reproduced the old `session busy` failure through the manager image before this fix. A third session fails at capacity without starting a fetch. Timeout invalidates the workspace and requires checkout again. Review completion invokes the idempotent release API. Idle and absolute expiry cover failed or abandoned reviews. Durable application state and ledger storage are unchanged.

## Verification commands

Run from `review-bot/`:

```sh
bun install --frozen-lockfile
bun test
bun check
bun lint
bun fmt --check
bun fmt --check ../landing
bun run build
bun run celld:prepare
CELLD_ESBUILD=./node_modules/.bin/esbuild celld deploy celld.json --dry-run --bucket s3://ci-build-only
node --check executor/server.mjs
node --check executor/process.mjs
bash -n scripts/celld-deploy.sh deploy/install.sh
systemd-analyze verify deploy/executor.service
podman build --target worker -t localhost/bumble-worker:latest executor
podman build --target manager -t localhost/bumble-manager:test executor
node tests/integration-executor-live.mjs
```

The integration script requires a local Podman engine and `GITHUB_TOKEN`, or a logged-in `gh`. It uses a real authenticated fetch of the public PR head and base. It never prints the token. To exercise the manager image rather than a host Node broker, start a dedicated local `podman system service --time=0 unix://<absolute-socket-path>` and run the script with `TEST_MANAGER_SOCKET=<absolute-socket-path>`. The socket is mounted only into the manager. The test uses uniquely labelled disposable containers and cleans them up.

The Bun suite passed 231 tests with 727 assertions. Typecheck, lint, formatting, both web builds, CellD prepare and bundle dry-run, JavaScript/shell syntax and systemd unit verification passed. Formatting and `.gitignore` fixes from commit `60db944` were inspected and ported without its branch's prompt changes. No tracked `node_modules` exists at this PR head.

Local runtime was Node 22.23.3 and rootless Podman 6.1.4 with resource controls available. Both image targets built. The manager image provisions Debian's Podman 4.3.1 remote client; its communication with the actual Podman 6.1.4 engine was tested. Host and manager-image integration runs verify root, package installation with apt, outbound HTTPS, writable clean checkout, head/base diffs and history, isolation, resource configuration, request cancellation and cleanup.

## Limits and operator requirements

The local engine is rootless. The systemd deployment uses the rootful engine and socket on the dedicated VM. That exact VM, its firewall, kernel, cgroup delegation and deployed distro versions were not exercised. Deployment must fail if network isolation or resource flags are unsupported. Only the manager mounts the administrative socket; compromising the broker itself would compromise the engine.

## Independent review and cleanup retry

A fresh Codex reviewer reran both live Podman integration paths and the local
checks. It reproduced one transient-failure defect: a failed worker removal
left the session busy, preventing release retries and idle cleanup.

The parent added an HTTP regression test using the actual manager server with
a failing Podman CLI boundary. Before the fix, both release retries returned
400 instead of 200. Cleanup now has its own shared promise, separate from
command execution. Failed workers stay unready and capacity-accounted;
release and idle cleanup can retry. Concurrent release requests await the same
removal. The regression test passes, including the single-removal assertion.
The full suite passes 232 tests with 736 assertions. Type checking, lint and
formatting also pass. A new comment narration line was removed.

Disk use is bounded by a manager watchdog, not a filesystem quota. Each worker is removed once its writable layer passes 8 GiB, and checkout refuses when host free space is below the floor. A write burst between 2-second polls can overshoot. The live test fills a worker past a 600 MiB test limit and confirms its removal. Without the watchdog, the same step wrote 2 GB unchecked. Full Git history is also bounded only by the manager's memory, tmpfs and fetch timeout. Containers share a kernel. These checks do not prove resistance to kernel escapes, unrestricted public-network abuse or every possible host routing configuration. The deliberately unrestricted shell has no command allow-list.

Official API references checked against the installed major versions are [Node 22 child processes](https://nodejs.org/download/release/latest-v22.x/docs/api/child_process.html), [Podman 6.1.4 run](https://docs.podman.io/en/v6.1.4/markdown/podman-run.1.html), and [Podman 6.1.4 network creation](https://docs.podman.io/en/v6.1.4/markdown/podman-network-create.1.html). Runtime checks, rather than flag names alone, establish the evidence above.

## Latest-head bot follow-up

Bumble Bot completed its review of 2dfca71 with no blockers and three findings.
All three received fixes with regression checks:

- Cleanup now catches synchronous setup errors as well as promise rejections.
  The test uses the actual missing-token executor constructor and confirms that
  finish_review still publishes and returns termination control.
- Process results disclose stdout/stderr truncation separately. The tool labels
  truncated streams, and collectors stop copying buffers once full. Real Node
  subprocesses test oversized and exactly-at-cap output, including both streams.
- checkout_pr now says the base was fetched with commit history and makes no
  invented 50-commit claim. The tool-result check covers that message.

The new tests failed before the fixes and pass afterward. These changes do not
alter per-review container isolation, resource limits or deployment topology.

The bot review of f63a22d also reported no blockers, with two medium findings.
The deployment finding is fixed: the upgrade script enables bumble-executor
before restarting it, so its multi-user.target installation survives reboot.
The existing restart remains necessary to apply rebuilt images. Bash syntax
and the enable-before-restart order were checked; no live service changed.

The module-extraction finding is deferred. Moving checkout_pr and shell into
another module could improve navigation, but this review identified no execution
defect from their current location. The tools intentionally reuse the existing
target resolver and review lifecycle. Their contract is covered by actual-tool
tests. Extraction would move the same definitions that dependent PRs #45 and
#46 extend, without improving the isolation fix. This is a follow-up refactor,
not a reason to churn the current stack or weaken the tool behavior.
