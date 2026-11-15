#!/usr/bin/env bash
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

for tool in uv uvx bun bunx python3 pip3 rg jq file pkg-config ps node npm; do
  command -v "$tool" || { printf 'Missing worker tool: %s\n' "$tool" >&2; exit 1; }
done
uv --version
bun --version
python3 -m venv system-venv
system-venv/bin/python -m pip --version

cat > test_python.py <<'PY'
import sys

def test_python_version():
    assert sys.version_info[:2] == (3, 13)
PY
UV_PYTHON_DOWNLOADS=never uv run --python 3.13 --with pytest==9.2.0 pytest -q test_python.py

cat > package.json <<'JSON'
{"name":"worker-toolchain-check","private":true,"type":"module","dependencies":{"is-number":"7.0.0"}}
JSON
cat > tools.test.js <<'JS'
import { expect, test } from "bun:test";
import isNumber from "is-number";

test("installed packages run in Bun", () => {
  expect(isNumber(42)).toBe(true);
  expect(isNumber("no")).toBe(false);
});
JS
cat > check.ts <<'TS'
const answer: number = 42;
if (answer !== 42) throw new Error("wrong answer");
TS
bun install
bun test
bun check check.ts
bun fmt package.json
bun fmt --check package.json
bunx --bun oxfmt@0.78.0 --version
printf 'PASS worker package installs, Python 3.13 pytest, Bun tests/check/fmt and bunx\n'
