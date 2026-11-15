#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CELLD_SSH_HOST:?Set a host from your verified SSH known_hosts}"
: "${CELLD_BUCKET:?Set CELLD_BUCKET}"
: "${S3_ENDPOINT:?Set S3_ENDPOINT}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"
: "${CELLD_SECRETS_FILE:?Set a private JSON secrets file}"
executor_env="$(mktemp)"
trap 'rm -f "$executor_env"' EXIT
bun -e '
  const secrets = await Bun.file(process.argv[1]).json();
  const token = secrets.EXECUTOR_TOKEN;
  if (typeof token !== "string" || !token || /[\r\n\0]/.test(token))
    throw new Error("CELLD_SECRETS_FILE must contain a one-line EXECUTOR_TOKEN");
  process.stdout.write(`EXECUTOR_TOKEN=${token}\n`);
' "$CELLD_SECRETS_FILE" > "$executor_env"
export CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild"
bun run build
bun scripts/celld-prepare.mjs --production
celld deploy celld.json
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$CELLD_SSH_HOST" 'install -d -m 700 /opt/bumble/migrations /opt/bumble/executor'
scp -o BatchMode=yes -o StrictHostKeyChecking=yes celld.json "$CELLD_SSH_HOST:/opt/bumble/wrangler.jsonc"
scp -o BatchMode=yes -o StrictHostKeyChecking=yes migrations/*.sql "$CELLD_SSH_HOST:/opt/bumble/migrations/"
scp -o BatchMode=yes -o StrictHostKeyChecking=yes deploy/executor.service "$CELLD_SSH_HOST:/etc/systemd/system/bumble-executor.service"
scp -o BatchMode=yes -o StrictHostKeyChecking=yes executor/Containerfile executor/server.mjs executor/process.mjs "$CELLD_SSH_HOST:/opt/bumble/executor/"
scp -o BatchMode=yes -o StrictHostKeyChecking=yes "$executor_env" "$CELLD_SSH_HOST:/etc/bumble/executor.env"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$CELLD_SSH_HOST" 'set -eu; chmod 600 /opt/bumble/wrangler.jsonc /etc/bumble/executor.env; systemctl daemon-reload; systemctl enable --now podman.socket; podman build --target worker --tag localhost/bumble-worker:latest /opt/bumble/executor; podman build --target manager --tag bumble-executor:latest /opt/bumble/executor; systemctl enable bumble-executor; systemctl restart bumble-executor; systemctl is-active --quiet bumble-executor; systemctl start bumble-celld; timeout 120 bash -c '\''until curl -fsS http://127.0.0.1:8080/.well-known/celld/health > /dev/null; do sleep 2; done'\''; curl -fsS -X POST http://127.0.0.1:8081/reload > /dev/null; set -a; . /etc/bumble/runtime.env; set +a; CELLD_WATCH=/var/lib/bumble/cells celld d1 migrations apply bumble-review-ledger /opt/bumble'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$CELLD_SSH_HOST" 'set -eu; net=bumble-smoke-$$; trap "podman network rm -f $net >/dev/null 2>&1 || true" EXIT; podman network create --opt isolate=true "$net" >/dev/null; podman run --rm --network "$net" --entrypoint /bin/true localhost/bumble-worker:latest'
