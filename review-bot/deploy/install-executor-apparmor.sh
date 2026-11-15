#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! test -r /sys/module/apparmor/parameters/enabled || ! grep -q Y /sys/module/apparmor/parameters/enabled; then
  exit 0
fi

label=$(podman run --rm --security-opt no-new-privileges localhost/bumble-worker:latest cat /proc/self/attr/current)
profile=${label%% *}
profile=${profile%%//*}
if test "$profile" != containers-default-0.57.4-apparmor1; then
  printf 'Review the AppArmor template for the installed container profile: %s\n' "$profile" >&2
  exit 1
fi

policy=$(mktemp)
trap 'rm -f "$policy"' EXIT
sed "s/@PROFILE@/$profile/g" executor-apparmor.template > "$policy"
apparmor_parser --skip-kernel-load "$policy"
install -m 644 "$policy" /etc/apparmor.d/bumble-executor-containers
apparmor_parser --replace /etc/apparmor.d/bumble-executor-containers
