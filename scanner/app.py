"""Static-analysis scanner for the review bot, deployed as a Modal web endpoint.

POST a repo, a commit and the tools to run with their paths. The endpoint
downloads that commit from GitHub, runs each tool with JSON output and
returns every diagnostic in one shape.
"""

import io
import json
import os
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from typing import Literal

import modal
from pydantic import BaseModel

ZIZMOR = "1.32.0"
TY = "0.0.104"
OXLINT = "1.93.0"
VERSIONS = {"zizmor": ZIZMOR, "ty": TY, "oxlint": OXLINT}
TIMEOUT_S = 120

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("curl", "ca-certificates")
    .uv_pip_install(f"zizmor=={ZIZMOR}", f"ty=={TY}", "fastapi[standard]")
    .run_commands(
        f"curl -fsSL https://github.com/oxc-project/oxc/releases/download/oxlint_v{OXLINT}/"
        "oxlint-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /usr/local/bin",
        "mv /usr/local/bin/oxlint* /usr/local/bin/oxlint 2>/dev/null || true",
        "oxlint --version",
    )
)

app = modal.App("j26-review-scanner", image=image)

Tool = Literal["zizmor", "ty", "oxlint"]
Severity = Literal["error", "warning", "info"]


class Check(BaseModel):
    tool: Tool
    paths: list[str]


class ScanRequest(BaseModel):
    owner: str
    repo: str
    sha: str
    token: str
    checks: list[Check]


class Diagnostic(BaseModel):
    tool: Tool
    rule: str
    severity: Severity
    path: str
    line: int | None
    message: str
    url: str | None


class ScanResult(BaseModel):
    tool: Tool
    version: str
    status: Literal["ok", "error"]
    durationMs: int
    paths: list[str]
    diagnostics: list[Diagnostic]
    error: str | None


def checkout(req: ScanRequest, into: str) -> None:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{req.owner}/{req.repo}/tarball/{req.sha}",
        headers={
            **({"authorization": f"Bearer {req.token}"} if req.token else {}),
            "accept": "application/vnd.github+json",
            "user-agent": "earned-trust-review-scanner",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as res:
        data = res.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            member.name = member.name.split("/", 1)[1] if "/" in member.name else ""
        tar.extractall(
            into, members=[m for m in tar.getmembers() if m.name], filter="data"
        )


def zizmor(paths: list[str], cwd: str) -> list[Diagnostic]:

    out = run(
        ["zizmor", "--offline", "--format", "json", *paths],
        cwd,
        ok={0, 10, 11, 12, 13, 14},
    )
    severity = {"High": "error", "Medium": "warning"}
    diagnostics = []
    for finding in json.loads(out or "[]"):
        loc = next(
            (l for l in finding["locations"] if l["symbolic"]["kind"] == "Primary"),
            finding["locations"][0],
        )
        key = loc["symbolic"]["key"]
        diagnostics.append(
            Diagnostic(
                tool="zizmor",
                rule=finding["ident"],
                severity=severity.get(finding["determinations"]["severity"], "info"),
                path=key.get("Local", {}).get("verbatim_path", "?"),
                line=loc["concrete"]["location"]["start_point"]["row"] + 1,
                message=f"{finding['desc']}: {loc['symbolic']['annotation']}",
                url=finding.get("url"),
            )
        )
    return diagnostics


def ty(paths: list[str], cwd: str) -> list[Diagnostic]:

    out = run(["ty", "check", "--output-format", "gitlab", *paths], cwd, ok={0, 1})
    severity = {
        "blocker": "error",
        "critical": "error",
        "major": "error",
        "minor": "warning",
    }
    return [
        Diagnostic(
            tool="ty",
            rule=d["check_name"],
            severity=severity.get(d["severity"], "info"),
            path=d["location"]["path"],
            line=d["location"]["positions"]["begin"]["line"],
            message=d["description"],
            url=f"https://docs.astral.sh/ty/reference/rules/#{d['check_name']}",
        )
        for d in json.loads(out or "[]")
    ]


def oxlint(paths: list[str], cwd: str) -> list[Diagnostic]:

    out = run(["oxlint", "-f", "json", *paths], cwd, ok={0, 1})
    return [
        Diagnostic(
            tool="oxlint",
            rule=d.get("code") or "oxlint",
            severity="error" if d.get("severity") == "error" else "warning",
            path=d["filename"],
            line=d["labels"][0]["span"]["line"] if d.get("labels") else None,
            message=d["message"] + (f" ({d['help']})" if d.get("help") else ""),
            url=d.get("url"),
        )
        for d in json.loads(out)["diagnostics"]
    ]


RUNNERS = {"zizmor": zizmor, "ty": ty, "oxlint": oxlint}


def run(cmd: list[str], cwd: str, ok: set[int]) -> str:
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT_S, check=False
    )
    if proc.returncode not in ok:
        raise RuntimeError(
            f"{cmd[0]} exited {proc.returncode}: {proc.stderr.strip()[-800:]}"
        )
    return proc.stdout


def scan_one(check: Check, cwd: str) -> ScanResult:
    started = time.monotonic()
    paths = [p for p in check.paths if os.path.isfile(os.path.join(cwd, p))]
    try:
        diagnostics = RUNNERS[check.tool](paths, cwd) if paths else []
        status, error = "ok", None
    except Exception as e:  # noqa: BLE001 - one failing tool must not fail the scan
        diagnostics, status, error = [], "error", str(e)
    return ScanResult(
        tool=check.tool,
        version=VERSIONS[check.tool],
        status=status,
        durationMs=int((time.monotonic() - started) * 1000),
        paths=paths,
        diagnostics=diagnostics,
        error=error,
    )


@app.function(secrets=[modal.Secret.from_name("j26-review-scanner")], timeout=600)
@modal.asgi_app()
def web():
    import hmac
    from concurrent.futures import ThreadPoolExecutor

    from fastapi import FastAPI, Header, HTTPException

    api = FastAPI()

    @api.post("/scan")
    def scan(req: ScanRequest, authorization: str = Header("")) -> list[ScanResult]:
        if not hmac.compare_digest(
            authorization, f"Bearer {os.environ['SCANNER_TOKEN']}"
        ):
            raise HTTPException(401, "bad token")
        with tempfile.TemporaryDirectory() as cwd:
            checkout(req, cwd)
            with ThreadPoolExecutor() as pool:
                return list(pool.map(lambda c: scan_one(c, cwd), req.checks))

    return api
