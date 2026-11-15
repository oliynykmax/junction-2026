#!/usr/bin/env bash
set -euo pipefail
: "${APP_SECRETS:?Set APP_SECRETS to the app secrets JSON}"
out="${1:?Usage: write-celld-secrets.sh <output file>}"
jq --arg t "${EXECUTOR_TOKEN:-}" -f "$(dirname "$0")/with-executor-token.jq" <<<"$APP_SECRETS" > "$out"
