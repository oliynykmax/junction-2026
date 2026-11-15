"""Static-analysis scanner for the review bot, deployed as a Modal web endpoint.

POST a repo, a commit and the tools to run with their paths. The endpoint
downloads that commit from GitHub, runs each tool with JSON output and
returns every diagnostic in one shape.
"""

import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

import modal
from pydantic import BaseModel

ZIZMOR = "1.32.0"
TY = "0.0.104"
OXLINT = "1.93.0"
RUFF = "0.17.5"
OXFMT = "0.78.0"
DOTNET_SDK = "8.0.402"
NODE = "22.12.0"
DOTNET_CONFIGURATION = "Debug"
VERSIONS = {
    "zizmor": ZIZMOR,
    "ty": TY,
    "oxlint": OXLINT,
    "ruff-format": RUFF,
    "oxfmt": OXFMT,
    "dotnet-ci": DOTNET_SDK,
    "dotnet-format": DOTNET_SDK,
}
TIMEOUT_S = 120
DOTNET_TIMEOUT_S = 300
DOTNET_MAX_TARGETS = 2
DOTNET_MAX_PACKAGES = 100
DOTNET_MAX_PACKAGE_BYTES = 20 * 1024 * 1024
DOTNET_MAX_TOTAL_PACKAGE_BYTES = 64 * 1024 * 1024
DOTNET_PACKAGE_TIMEOUT_S = 10
DOTNET_FUNCTION_TIMEOUT_S = DOTNET_TIMEOUT_S * 4 * DOTNET_MAX_TARGETS + TIMEOUT_S + 60
WEB_TIMEOUT_S = (
    DOTNET_FUNCTION_TIMEOUT_S + DOTNET_MAX_PACKAGES * DOTNET_PACKAGE_TIMEOUT_S + 120
)

scanner_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("curl", "ca-certificates", "libicu-dev", "xz-utils")
    .uv_pip_install(
        f"zizmor=={ZIZMOR}",
        f"ty=={TY}",
        f"ruff=={RUFF}",
        "fastapi[standard]",
    )
    .run_commands(
        f"curl -fsSL https://github.com/oxc-project/oxc/releases/download/oxlint_v{OXLINT}/"
        "oxlint-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /usr/local/bin",
        "mv /usr/local/bin/oxlint* /usr/local/bin/oxlint 2>/dev/null || true",
        "oxlint --version",
        f"curl -fsSL https://nodejs.org/dist/v{NODE}/node-v{NODE}-linux-x64.tar.xz "
        "| tar -xJ -C /usr/local --strip-components=1",
        f"npm install --global oxfmt@{OXFMT}",
        "oxfmt --version",
    )
)

dotnet_image = scanner_image.run_commands(
    "mkdir -p /usr/local/dotnet",
    f"curl -fsSL https://dotnetcli.azureedge.net/dotnet/Sdk/{DOTNET_SDK}/"
    f"dotnet-sdk-{DOTNET_SDK}-linux-x64.tar.gz | tar -xz -C /usr/local/dotnet",
    "ln -s /usr/local/dotnet/dotnet /usr/local/bin/dotnet",
    "dotnet --info",
)

app = modal.App("j26-review-scanner", image=scanner_image)

Tool = Literal[
    "zizmor",
    "ty",
    "oxlint",
    "ruff-format",
    "oxfmt",
    "dotnet-ci",
    "dotnet-format",
]
Severity = Literal["error", "warning", "info"]
DOTNET_TOOLS = frozenset({"dotnet-ci", "dotnet-format"})


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


def download_archive(req: ScanRequest) -> bytes:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{req.owner}/{req.repo}/tarball/{req.sha}",
        headers={
            **({"authorization": f"Bearer {req.token}"} if req.token else {}),
            "accept": "application/vnd.github+json",
            "user-agent": "earned-trust-review-scanner",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as res:
        return res.read()


def extract_archive(data: bytes, into: str) -> None:
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
    severity: dict[str, Severity] = {"High": "error", "Medium": "warning"}
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
    severity: dict[str, Severity] = {
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


def ruff_format(paths: list[str], cwd: str) -> list[Diagnostic]:
    run(["ruff", "format", "--check", *paths], cwd, ok={0})
    return []


def oxfmt(paths: list[str], cwd: str) -> list[Diagnostic]:
    with tempfile.TemporaryDirectory() as config_dir:
        config = Path(config_dir, "oxfmt.json")
        config.write_text("{}")
        run(["oxfmt", "--check", "--config", str(config), *paths], cwd, ok={0})
    return []


def dotnet_targets(cwd: str) -> list[str]:
    root = Path(cwd)
    ignored = {".git", "bin", "obj", "node_modules"}

    def paths(pattern: str) -> list[str]:
        return sorted(
            path.relative_to(root).as_posix()
            for path in root.rglob(pattern)
            if not ignored.intersection(path.relative_to(root).parts)
        )

    targets = paths("*.sln") or paths("*.csproj")
    if len(targets) > DOTNET_MAX_TARGETS:
        raise RuntimeError(
            f"dotnet checks support at most {DOTNET_MAX_TARGETS} targets"
        )
    return targets


def dotnet_ci(_: list[str], cwd: str) -> list[Diagnostic]:
    targets = dotnet_targets(cwd)
    if not targets:
        raise RuntimeError("no .sln or .csproj file found for dotnet CI")
    for target in targets:
        run(
            [
                "dotnet",
                "build",
                target,
                "--configuration",
                DOTNET_CONFIGURATION,
                "--nologo",
                "--no-restore",
            ],
            cwd,
            ok={0},
            timeout=DOTNET_TIMEOUT_S,
        )
        run(
            [
                "dotnet",
                "test",
                target,
                "--configuration",
                DOTNET_CONFIGURATION,
                "--no-build",
                "--nologo",
                "--no-restore",
            ],
            cwd,
            ok={0},
            timeout=DOTNET_TIMEOUT_S,
        )
    return []


def dotnet_format(paths: list[str], cwd: str) -> list[Diagnostic]:
    targets = dotnet_targets(cwd)
    if not targets:
        raise RuntimeError("no .sln or .csproj file found for dotnet format")
    source_paths = [path for path in paths if path.endswith((".cs", ".csx"))]
    for target in targets:
        command = [
            "dotnet",
            "format",
            target,
            "--verify-no-changes",
            "--no-restore",
            "--verbosity",
            "minimal",
        ]
        if source_paths:
            command.extend(["--include", *source_paths])
        run(command, cwd, ok={0}, timeout=DOTNET_TIMEOUT_S)
    return []


RUNNERS = {
    "zizmor": zizmor,
    "ty": ty,
    "oxlint": oxlint,
    "ruff-format": ruff_format,
    "oxfmt": oxfmt,
    "dotnet-ci": dotnet_ci,
    "dotnet-format": dotnet_format,
}


def run(cmd: list[str], cwd: str, ok: set[int], timeout: int = TIMEOUT_S) -> str:
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env={
            **os.environ,
            "CI": "true",
            "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
            "DOTNET_NOLOGO": "1",
        },
    )
    if proc.returncode not in ok:
        output = "\n".join(part for part in (proc.stderr, proc.stdout) if part).strip()
        raise RuntimeError(f"{cmd[0]} exited {proc.returncode}: {output[-800:]}")
    return proc.stdout


def scan_one(check: Check, cwd: str) -> ScanResult:
    started = time.monotonic()
    existing_paths = [
        path for path in check.paths if os.path.isfile(os.path.join(cwd, path))
    ]
    try:
        run_check = bool(existing_paths) or check.tool in DOTNET_TOOLS
        diagnostics = RUNNERS[check.tool](existing_paths, cwd) if run_check else []
        status, error = "ok", None
    except Exception as e:  # noqa: BLE001 - one failing tool must not fail the scan
        diagnostics, status, error = [], "error", str(e)
    return ScanResult(
        tool=check.tool,
        version=VERSIONS[check.tool],
        status=status,
        durationMs=int((time.monotonic() - started) * 1000),
        paths=check.paths if check.tool in DOTNET_TOOLS else existing_paths,
        diagnostics=diagnostics,
        error=error,
    )


def dotnet_packages(archive: bytes) -> dict[str, bytes]:
    """Fetch locked packages from a fixed feed without evaluating repository code."""
    packages: set[tuple[str, str]] = set()
    with tempfile.TemporaryDirectory() as cwd:
        extract_archive(archive, cwd)
        for lock in Path(cwd).rglob("packages.lock.json"):
            for framework in json.loads(lock.read_text())["dependencies"].values():
                for name, dependency in framework.items():
                    if dependency.get("type", "").lower() == "project":
                        continue
                    version = dependency["resolved"].lower()
                    name = name.lower()
                    if not all(
                        re.fullmatch(r"[a-z0-9][a-z0-9_.+-]*", value)
                        for value in (name, version)
                    ):
                        raise ValueError("invalid locked NuGet package name or version")
                    packages.add((name, version))
    if len(packages) > DOTNET_MAX_PACKAGES:
        raise ValueError(
            f"dotnet checks support at most {DOTNET_MAX_PACKAGES} packages"
        )
    result = {}
    total_bytes = 0
    for name, version in sorted(packages):
        filename = f"{name}.{version}.nupkg"
        url = f"https://api.nuget.org/v3-flatcontainer/{name}/{version}/{filename}"
        with urllib.request.urlopen(url, timeout=DOTNET_PACKAGE_TIMEOUT_S) as response:
            data = response.read(DOTNET_MAX_PACKAGE_BYTES + 1)
        if len(data) > DOTNET_MAX_PACKAGE_BYTES:
            raise ValueError("locked NuGet package exceeds 20 MiB")
        total_bytes += len(data)
        if total_bytes > DOTNET_MAX_TOTAL_PACKAGE_BYTES:
            raise ValueError("locked NuGet packages exceed 64 MiB total")
        result[filename] = data
    return result


def failed_checks(checks: list[Check], error: str) -> list[ScanResult]:
    return [
        ScanResult(
            tool=check.tool,
            version=VERSIONS[check.tool],
            status="error",
            durationMs=0,
            paths=check.paths,
            diagnostics=[],
            error=error,
        )
        for check in checks
    ]


def scan_archive(
    archive: bytes, checks: list[dict[str, object]], packages: dict[str, bytes]
) -> list[dict[str, object]]:
    """Restore and execute repository code only inside the network-blocked runner."""
    validated = [Check.model_validate(check) for check in checks]
    if len(validated) > len(DOTNET_TOOLS) or len({c.tool for c in validated}) != len(
        validated
    ):
        raise ValueError("at most one request per dotnet check is supported")
    with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryDirectory() as feed:
        extract_archive(archive, cwd)
        for name, data in packages.items():
            Path(feed, name).write_bytes(data)
        try:
            targets = dotnet_targets(cwd)
            # Let the SDK resolver apply global.json, including rollForward.
            try:
                run(["dotnet", "--version"], cwd, ok={0})
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
                raise RuntimeError(
                    f"SDK not available (installed {DOTNET_SDK}): {e}"
                ) from e
            for target in targets:
                run(
                    [
                        "dotnet",
                        "restore",
                        target,
                        "--locked-mode",
                        "--source",
                        feed,
                        "--nologo",
                    ],
                    cwd,
                    ok={0},
                    timeout=DOTNET_TIMEOUT_S,
                )
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
            return [
                result.model_dump()
                for result in failed_checks(
                    validated,
                    f"Offline .NET preparation failed: {e}. "
                    "Only packages in packages.lock.json from nuget.org are prefetched; "
                    "all repository code runs with networking blocked.",
                )
            ]
        return [scan_one(check, cwd).model_dump() for check in validated]


@app.function(
    image=dotnet_image,
    timeout=DOTNET_FUNCTION_TIMEOUT_S,
    restrict_modal_access=True,
    single_use_containers=True,
    block_network=True,
)
def run_dotnet_checks(
    archive: bytes, checks: list[dict[str, object]], packages: dict[str, bytes]
) -> list[dict[str, object]]:
    if any(check.get("tool") not in DOTNET_TOOLS for check in checks):
        raise ValueError("restricted runner only accepts dotnet checks")
    return scan_archive(archive, checks, packages)


def scan_dotnet(archive: bytes, checks: list[Check]) -> list[ScanResult]:
    if not checks:
        return []
    try:
        packages = dotnet_packages(archive)
        call = run_dotnet_checks.spawn(
            archive, [check.model_dump() for check in checks], packages
        )
        return [ScanResult.model_validate(result) for result in call.get()]
    except Exception as e:  # noqa: BLE001 - preserve static evidence on remote failures
        return failed_checks(checks, f".NET runner failed: {e}")


@app.function(
    secrets=[modal.Secret.from_name("j26-review-scanner")], timeout=WEB_TIMEOUT_S
)
@modal.asgi_app()
def web():
    import hmac

    from fastapi import FastAPI, Header, HTTPException

    api = FastAPI()

    @api.post("/scan")
    def scan(req: ScanRequest, authorization: str = Header("")) -> list[ScanResult]:
        if not hmac.compare_digest(
            authorization, f"Bearer {os.environ['SCANNER_TOKEN']}"
        ):
            raise HTTPException(401, "bad token")
        archive = download_archive(req)
        dotnet_checks = [check for check in req.checks if check.tool in DOTNET_TOOLS]
        static_checks = [
            check for check in req.checks if check.tool not in DOTNET_TOOLS
        ]
        with tempfile.TemporaryDirectory() as cwd:
            extract_archive(archive, cwd)
            with ThreadPoolExecutor() as pool:
                dotnet_call = pool.submit(scan_dotnet, archive, dotnet_checks)
                static = list(
                    pool.map(lambda check: scan_one(check, cwd), static_checks)
                )
                dotnet = dotnet_call.result()
        static_results = iter(static)
        dotnet_results = iter(dotnet)
        return [
            next(dotnet_results) if check.tool in DOTNET_TOOLS else next(static_results)
            for check in req.checks
        ]

    return api
