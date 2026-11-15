import ast
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class DotnetChecksTest(unittest.TestCase):
    def test_dotnet_targets_prefer_solutions_and_skip_build_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as cwd:
            root = Path(cwd)
            (root / "src").mkdir()
            (root / "obj").mkdir()
            (root / "MessagePack.sln").touch()
            (root / "src" / "MessagePack.csproj").touch()
            (root / "obj" / "generated.sln").touch()

            self.assertEqual(app.dotnet_targets(cwd), ["MessagePack.sln"])

    @patch.object(app, "run")
    def test_dotnet_ci_reproduces_build_then_test_ci_for_each_target(self, run) -> None:
        with tempfile.TemporaryDirectory() as cwd:
            Path(cwd, "App.csproj").touch()

            app.dotnet_ci([], cwd)

        self.assertEqual(
            run.call_args_list,
            [
                (
                    (
                        [
                            "dotnet",
                            "build",
                            "App.csproj",
                            "--configuration",
                            "Debug",
                            "--nologo",
                            "--no-restore",
                        ],
                        cwd,
                    ),
                    {"ok": {0}, "timeout": app.DOTNET_TIMEOUT_S},
                ),
                (
                    (
                        [
                            "dotnet",
                            "test",
                            "App.csproj",
                            "--configuration",
                            "Debug",
                            "--no-build",
                            "--nologo",
                            "--no-restore",
                        ],
                        cwd,
                    ),
                    {"ok": {0}, "timeout": app.DOTNET_TIMEOUT_S},
                ),
            ],
        )

    @patch.object(app, "run")
    def test_dotnet_format_checks_only_changed_source_files(self, run) -> None:
        with tempfile.TemporaryDirectory() as cwd:
            Path(cwd, "App.csproj").touch()

            app.dotnet_format(["src/Foo.cs", "Directory.Build.props"], cwd)

        run.assert_called_once_with(
            [
                "dotnet",
                "format",
                "App.csproj",
                "--verify-no-changes",
                "--no-restore",
                "--verbosity",
                "minimal",
                "--include",
                "src/Foo.cs",
            ],
            cwd,
            ok={0},
            timeout=app.DOTNET_TIMEOUT_S,
        )

    def test_run_keeps_a_ci_failure_from_standard_output(self) -> None:
        with patch("app.subprocess.run") as process:
            process.return_value.returncode = 1
            process.return_value.stdout = "compile error at Project.cs:10"
            process.return_value.stderr = ""

            with self.assertRaisesRegex(RuntimeError, "compile error at Project.cs:10"):
                app.run(["dotnet", "test"], "/tmp", ok={0})

    def test_dotnet_ci_runs_when_the_changed_file_was_deleted(self) -> None:
        runner = Mock(return_value=[])
        with tempfile.TemporaryDirectory() as cwd:
            Path(cwd, "App.csproj").touch()
            with patch.dict(app.RUNNERS, {"dotnet-ci": runner}):
                result = app.scan_one(
                    app.Check(tool="dotnet-ci", paths=["src/Removed.cs"]), cwd
                )

        runner.assert_called_once_with([], cwd)
        self.assertEqual(result.paths, ["src/Removed.cs"])

    def archive(self, files: dict[str, str]) -> bytes:
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for name, content in files.items():
                data = content.encode()
                info = tarfile.TarInfo(f"repo-head/{name}")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return stream.getvalue()

    def test_dotnet_function_blocks_network_and_reuse(self) -> None:
        module = ast.parse(Path(app.__file__).read_text())
        function = next(
            node
            for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "run_dotnet_checks"
        )
        decorator = function.decorator_list[0]
        assert isinstance(decorator, ast.Call)
        options = {kw.arg: kw.value for kw in decorator.keywords}
        for name in ("block_network", "restrict_modal_access", "single_use_containers"):
            self.assertTrue(ast.literal_eval(options[name]))

    @patch.object(app.urllib.request, "urlopen")
    def test_prefetch_only_downloads_locked_packages_from_nuget(self, urlopen) -> None:
        urlopen.return_value.__enter__.return_value.read.return_value = b"package"
        archive = self.archive(
            {
                "packages.lock.json": json.dumps(
                    {
                        "dependencies": {
                            "net8.0": {
                                "Example": {"type": "Direct", "resolved": "1.0.0"},
                                "Local": {"type": "Project"},
                            }
                        }
                    }
                )
            }
        )
        self.assertEqual(
            app.dotnet_packages(archive), {"example.1.0.0.nupkg": b"package"}
        )
        urlopen.assert_called_once_with(
            "https://api.nuget.org/v3-flatcontainer/example/1.0.0/example.1.0.0.nupkg",
            timeout=app.DOTNET_PACKAGE_TIMEOUT_S,
        )

    @patch.object(app.urllib.request, "urlopen")
    def test_prefetch_rejects_package_path_injection(self, urlopen) -> None:
        archive = self.archive(
            {
                "packages.lock.json": json.dumps(
                    {
                        "dependencies": {
                            "net8.0": {
                                "../../attacker": {
                                    "type": "Direct",
                                    "resolved": "1.0.0",
                                }
                            }
                        }
                    }
                )
            }
        )
        with self.assertRaisesRegex(ValueError, "invalid locked NuGet"):
            app.dotnet_packages(archive)
        urlopen.assert_not_called()

    @patch.object(app, "run")
    def test_offline_restore_precedes_build_test_and_format(self, run) -> None:
        archive = self.archive({"App.csproj": "", "App.cs": ""})
        checks = [
            app.Check(tool=tool, paths=["App.cs"]).model_dump()
            for tool in ("dotnet-ci", "dotnet-format")
        ]
        results = app.scan_archive(archive, checks, {"example.1.0.0.nupkg": b"package"})
        self.assertEqual([result["status"] for result in results], ["ok", "ok"])
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(
            [command[1] for command in commands],
            ["--version", "restore", "build", "test", "format"],
        )
        self.assertIn("--source", commands[1])
        for command in commands[2:]:
            self.assertIn("--no-restore", command)

    @patch.object(
        app, "run", side_effect=RuntimeError("requested SDK 10.0.100 unavailable")
    )
    def test_unavailable_sdk_is_explicit_for_every_check(self, run) -> None:
        archive = self.archive(
            {
                "App.csproj": "",
                "global.json": json.dumps(
                    {"sdk": {"version": "10.0.100", "rollForward": "latestFeature"}}
                ),
            }
        )
        results = app.scan_archive(
            archive,
            [
                app.Check(tool=tool, paths=["global.json"]).model_dump()
                for tool in ("dotnet-ci", "dotnet-format")
            ],
            {},
        )
        self.assertEqual(len(results), 2)
        for result in results:
            self.assertEqual(result["status"], "error")
            self.assertIn("SDK not available", str(result["error"]))
            self.assertIn("10.0.100", str(result["error"]))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ["dotnet", "--version"])

    def test_timeout_covers_bounded_serial_workload(self) -> None:
        self.assertGreater(
            app.DOTNET_FUNCTION_TIMEOUT_S,
            4 * app.DOTNET_MAX_TARGETS * app.DOTNET_TIMEOUT_S + app.TIMEOUT_S,
        )
        with tempfile.TemporaryDirectory() as cwd:
            for index in range(app.DOTNET_MAX_TARGETS + 1):
                Path(cwd, f"App{index}.csproj").touch()
            with self.assertRaisesRegex(RuntimeError, "at most"):
                app.dotnet_targets(cwd)

    @patch.object(app, "dotnet_packages", return_value={})
    @patch.object(app.run_dotnet_checks, "spawn")
    def test_remote_timeout_becomes_per_check_errors(self, spawn, packages) -> None:
        spawn.return_value.get.side_effect = TimeoutError("function timed out")
        checks = [
            app.Check(tool=tool, paths=["App.cs"])
            for tool in ("dotnet-ci", "dotnet-format")
        ]
        results = app.scan_dotnet(b"archive", checks)
        self.assertEqual([result.tool for result in results], [c.tool for c in checks])
        for result in results:
            self.assertEqual(result.status, "error")
            self.assertIn("function timed out", result.error or "")

    @patch.object(app, "dotnet_packages", side_effect=RuntimeError("feed unavailable"))
    def test_package_failure_becomes_per_check_error(self, packages) -> None:
        result = app.scan_dotnet(
            b"archive", [app.Check(tool="dotnet-ci", paths=["App.cs"])]
        )[0]
        self.assertEqual(result.status, "error")
        self.assertIn("feed unavailable", result.error or "")

    @patch.object(app, "dotnet_packages", return_value={})
    @patch.object(app.run_dotnet_checks, "spawn")
    @patch.object(app, "download_archive")
    def test_endpoint_retains_static_results_after_remote_timeout(
        self, download, spawn, packages
    ) -> None:
        download.return_value = self.archive({"app.py": "", "App.cs": ""})
        spawn.return_value.get.side_effect = TimeoutError("function timed out")
        api = app.web.local()
        scan = next(route.endpoint for route in api.routes if route.path == "/scan")
        request = app.ScanRequest(
            owner="owner",
            repo="repo",
            sha="sha",
            token="",
            checks=[
                app.Check(tool="dotnet-ci", paths=["App.cs"]),
                app.Check(tool="ty", paths=["app.py"]),
                app.Check(tool="dotnet-format", paths=["App.cs"]),
            ],
        )
        with (
            patch.dict(os.environ, {"SCANNER_TOKEN": "test"}),
            patch.dict(app.RUNNERS, {"ty": Mock(return_value=[])}),
        ):
            results = scan(request, authorization="Bearer test")
        self.assertEqual(
            [result.tool for result in results],
            [check.tool for check in request.checks],
        )
        self.assertEqual(
            [result.status for result in results], ["error", "ok", "error"]
        )
        self.assertIn("function timed out", results[0].error or "")
        self.assertIn("function timed out", results[2].error or "")


if __name__ == "__main__":
    unittest.main()
