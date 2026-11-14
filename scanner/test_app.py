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


if __name__ == "__main__":
    unittest.main()
