#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0 || { echo "Run as root on the dedicated Verda VM" >&2; exit 1; }
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y podman caddy curl ca-certificates
install -d -m 700 /etc/bumble /var/lib/bumble /opt/bumble
install -m 644 celld.service /etc/systemd/system/bumble-celld.service
install -m 644 executor.service /etc/systemd/system/bumble-executor.service
install -d -m 700 /opt/bumble/executor
install -m 644 Caddyfile /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/bumble.conf <<'EOF'
[Service]
EnvironmentFile=/etc/bumble/caddy.env
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
EOF
podman pull ghcr.io/denoland/celld@sha256:6ae0e0b453f8d85dae969fbef44c3ba12806989f43f69bdc6094205662018334
podman run --rm --entrypoint cat ghcr.io/denoland/celld@sha256:6ae0e0b453f8d85dae969fbef44c3ba12806989f43f69bdc6094205662018334 /usr/local/bin/celld > /usr/local/bin/celld
chmod 755 /usr/local/bin/celld
systemctl daemon-reload
echo "Install /etc/bumble/runtime.env, /etc/bumble/executor.env and /etc/bumble/caddy.env with mode 600, then start bumble-executor, bumble-celld and caddy."
