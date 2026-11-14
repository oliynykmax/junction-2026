# Run Bumble on Verda

Bumble can run its Worker, Durable Objects, D1 ledger, cron, and static assets on CellD 0.6.2. Cloudflare keeps the public `review.oliinyk.dev` endpoint as an HTTPS gateway. GitHub keeps the same webhook URL. The scanner continues using its existing Modal endpoint.

## Prepare the runtime

Use a dedicated Linux amd64 VM with at least 4 vCPUs, 16 GB RAM, and a 50 GB boot volume. Check availability and costs with the Verda CLI before creating it. The tested `CPU.4V.16G` instance in FIN-01 costs $0.048/hour plus $10/month for the boot volume, about $1.48/day combined at the November 14, 2026 rates.

Copy `review-bot/deploy/` to the VM and run `bash install.sh` as root. It installs Podman and Caddy and pins the CellD container by digest. It does not start the app until credentials and a deployment exist.

Create a private object-storage bucket and a dedicated access key. The tested endpoint is `https://objects.eu-north-3.verda.storage`, region `eu-north-3`. Store credentials only in private files or GitHub secrets. Every key in a Verda project can access all its buckets, so use a dedicated project when isolation is needed.

Create `/etc/bumble/runtime.env` from `deploy/runtime.env.example`. Give it mode `600`. The single-node configuration binds both CellD listeners to loopback. Caddy is the only public app listener.

Create `/etc/bumble/caddy.env` with mode `600`:

```dotenv
CELLD_DOMAIN=your-origin-hostname
CELLD_ORIGIN_TOKEN=your-random-origin-token
```

The origin hostname must resolve to the VM and permit Caddy to obtain an HTTPS certificate on ports 80 and 443. The gateway connects over HTTPS and sends the origin token. Caddy and the app reject requests without it. Keep ports 8080 and 8081 inaccessible from the internet. Caddy's admin port stays on loopback.

Run `systemctl enable bumble-celld caddy`. After publishing the first deployment, start Caddy with `systemctl restart caddy`.

## Deploy the app

Install Bun and the pinned CellD 0.6.2 CLI on your deployment machine. The GitHub action installs CellD with a pinned binary checksum. In `review-bot/`, run `bun install --frozen-lockfile`.

Create a private JSON file with string values for `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `VERDA_API_KEY`, `SCANNER_TOKEN`, `CONTEXT_DEV_API_KEY`, and `ORIGIN_TOKEN`. The last value must match Caddy's origin token. Add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` to enable owner sign-off. Without them the review page says sign-in is not configured. `PRIVATE_KEY` is the GitHub App's PKCS#8 PEM with actual newlines encoded as JSON string escapes. The Verda inference key is separate from the Cloud API credentials used by the CLI.

Set these environment variables:

```dotenv
CELLD_SSH_HOST=root@your-verified-host
CELLD_BUCKET=s3://your-private-bucket
S3_ENDPOINT=https://objects.eu-north-3.verda.storage
AWS_REGION=eu-north-3
AWS_ACCESS_KEY_ID=your-storage-access-key
AWS_SECRET_ACCESS_KEY=your-storage-secret-key
CELLD_SECRETS_FILE=/absolute/path/to/private-app-secrets.json
```

Verify the VM's SSH host key and add it to `known_hosts` before deploying. Run `bun run celld:deploy`. This builds both web clients, generates a private `celld.json`, uploads the deployment, reloads the node, and applies the existing ledger migrations. The generated config and copied assets are ignored by Git. Production preparation fails if an enabled model lacks its credential.

CellD stores application bindings, including secrets, in the private deployment bucket. Anyone with bucket credentials can read them and control the fleet. The generated config and remote migration config also contain those bindings and must remain private.

Migrations must remain compatible with the deployment that is already serving. Do not rename the Worker or Durable Object classes. CellD derives object identities from those names.

## Verify before switching traffic

Run these commands with the storage credentials above:

```sh
celld diagnose --json
uv run --with boto3 python scripts/celld-storage-probe.py
CELLD_ORIGIN_TOKEN_FILE=/absolute/path/to/private-origin-token bun run celld:verify https://your-origin-hostname
```

The storage probe creates and deletes one uniquely named test object. It checks conditional writes, stale-writer rejection, exact ranged reads, and immediate listing. Verda is not listed as a qualified provider by CellD. Passing these checks and the live app tests is evidence for this deployment, not a provider-wide durability guarantee.

To spend model tokens on a real review, add `PR_URL=https://github.com/owner/repo/pull/123` to the verification command. It verifies a completed, persisted verdict. Manual rate limits still apply.

For a recovery test, start a fresh review, confirm its status is `running` or `scanning`, and kill the `bumble-celld` container on the test VM. Systemd starts a replacement. Query the same review after restart, check that its captured state persists, and wait for a final verdict. Check the dashboard's recovery record separately from the verdict. A completed review that survives a restart proves persistence but does not prove interrupted-task recovery.

## Configure automatic deployment

Set these GitHub repository secrets:

- `CELLD_APP_SECRETS` contains the private JSON app bindings.
- `CELLD_S3_ACCESS_KEY_ID` and `CELLD_S3_SECRET_ACCESS_KEY` contain the storage credentials.
- `CELLD_SSH_KEY` contains a dedicated deployment SSH private key for the dedicated VM.
- `CELLD_SSH_KNOWN_HOSTS` contains the verified SSH host key line.
- `CLOUDFLARE_API_TOKEN` remains the existing Worker deployment credential.

Set repository variables `CELLD_SSH_HOST`, `CELLD_BUCKET`, `CELLD_S3_ENDPOINT`, and `CELLD_S3_REGION` to the deployment values above. Set `CELLD_ORIGIN_URL` to the verified HTTPS origin URL last. On the next main deployment, CI deploys CellD, checks the live origin, installs the gateway token, and deploys Cloudflare with `ORIGIN_URL`. The gateway switch does not run when origin verification fails. Review these settings before merging the port.

## Roll back or inspect old reviews

With `ORIGIN_URL` unset, `src/gateway.ts` runs the original Cloudflare app. Remove the `CELLD_ORIGIN_URL` repository variable and redeploy main to return to that mode. Its Durable Objects quota still applies. Cloudflare secrets and DO bindings remain in place; the port declares no class deletions.

CellD starts a separate state store. Existing Cloudflare reviews and dashboard history are not copied. Returning to Cloudflare shows its old state; moving back to CellD shows its new state. Do not promise continuous history across these two stores. Exporting or merging old review state is outside this deployment port.

One VM has downtime while it restarts. A second node needs a trusted private network or encrypted overlay for its internal listener and shared bucket access. Never expose the internal API publicly to add a peer. The single-node deployment does not claim multi-node failover.
