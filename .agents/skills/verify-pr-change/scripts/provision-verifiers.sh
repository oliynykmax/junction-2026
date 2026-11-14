#!/usr/bin/env bash
set -euo pipefail

tool_root="${J26_FORMAL_TOOLS_DIR:-/var/tmp/j26-formal-tools}"
mkdir -p "$tool_root"/{dafny,gobra-tools,gobra-src,kani,sbt,tla,downloads}

download() {
  local url="$1" destination="$2"
  if [ ! -s "$destination" ]; then
    curl --fail --location --retry 3 --retry-delay 2 --output "$destination" "$url"
  fi
}

download \
  "https://github.com/dafny-lang/dafny/releases/download/v4.11.0/dafny-4.11.0-x64-ubuntu-22.04.zip" \
  "$tool_root/downloads/dafny-4.11.0-x64-ubuntu-22.04.zip"
if ! find "$tool_root/dafny" -path '*/dafny/dafny' -type f -print -quit | grep -q .; then
  unzip -q "$tool_root/downloads/dafny-4.11.0-x64-ubuntu-22.04.zip" -d "$tool_root/dafny"
fi

download \
  "https://github.com/viperproject/gobra-ide/releases/download/v2.0.5/GobraToolsLinux.zip" \
  "$tool_root/downloads/GobraToolsLinux-v2.0.5.zip"
if [ ! -x "$tool_root/gobra-tools/z3/bin/z3" ]; then
  unzip -q "$tool_root/downloads/GobraToolsLinux-v2.0.5.zip" -d "$tool_root/gobra-tools"
fi

download \
  "https://github.com/sbt/sbt/releases/download/v1.10.11/sbt-1.10.11.tgz" \
  "$tool_root/downloads/sbt-1.10.11.tgz"
if [ ! -x "$tool_root/sbt/bin/sbt" ]; then
  tar -xzf "$tool_root/downloads/sbt-1.10.11.tgz" -C "$tool_root"
fi
if [ ! -d "$tool_root/gobra-src/.git" ]; then
  rm -rf "$tool_root/gobra-src"
  git clone --depth 1 --branch v26.09 --recurse-submodules \
    https://github.com/viperproject/gobra.git "$tool_root/gobra-src"
fi
if ! find "$tool_root/gobra-src/target" -type f -name gobra.jar -print -quit | grep -q .; then
  (
    cd "$tool_root/gobra-src"
    COURSIER_CACHE="$tool_root/gobra-coursier" \
    SBT_OPTS="-Dsbt.global.base=$tool_root/gobra-sbt -Dsbt.ivy.home=$tool_root/gobra-ivy" \
    "$tool_root/sbt/bin/sbt" -Dsbt.supershell=false assembly
  )
fi

download \
  "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar" \
  "$tool_root/tla/tla2tools.jar"

if [ ! -x "$tool_root/kani/bin/cargo-kani" ]; then
  CARGO_HOME="$tool_root/kani/cargo-home" \
    cargo install --locked --version 0.68.0 --root "$tool_root/kani" kani-verifier
fi
# `cargo-kani setup` invokes the user's rustup to install Kani's pinned nightly.
# Keep the plugin installation isolated, but do not override CARGO_HOME here:
# an isolated CARGO_HOME would hide the host rustup installation on reruns.
env -u CARGO_HOME "$tool_root/kani/bin/cargo-kani" setup

dafny_bin="$(find "$tool_root/dafny" -path '*/dafny/dafny' -type f -print -quit)"
gobra_jar="$(find "$tool_root/gobra-src/target" -name gobra.jar -type f -print -quit)"
z3_exe="$tool_root/gobra-tools/z3/bin/z3"
boogie_exe="$tool_root/gobra-tools/boogie/Binaries/Boogie"
[ -n "$dafny_bin" ] && [ -n "$gobra_jar" ] && [ -x "$z3_exe" ] && [ -x "$boogie_exe" ]
printf 'J26_FORMAL_TOOLS_DIR=%s\n' "$tool_root"
printf 'DAFNY=%s\n' "$dafny_bin"
printf 'GOBRA_JAR=%s\n' "$gobra_jar"
printf 'Z3_EXE=%s\n' "$z3_exe"
printf 'BOOGIE_EXE=%s\n' "$boogie_exe"
printf 'TLA2TOOLS=%s\n' "$tool_root/tla/tla2tools.jar"
printf 'CARGO_KANI=%s\n' "$tool_root/kani/bin/cargo-kani"
printf '\nObserved artifact checksums:\n'
sha256sum "$tool_root/downloads"/* "$tool_root/tla/tla2tools.jar"
