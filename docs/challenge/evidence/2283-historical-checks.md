# Issue 2283 feasibility: can the validated-check demo run this weekend?

Date: 2026-11-14. Scope: inspect only. No tracked file changed, no commit, no push. The sample checkout's `git status --porcelain` was empty before and after, and it stayed on `ju26-issue-2283` at `9df83c38` (measured).

Labels: **[M]** measured this session, **[I]** inferred from code or output, not run.

## Verdict

The live demo is buildable this weekend [I, based on the measurements below]. The reproducer works. F1 and P1 both separate the broken variants from the reviewed repair. P2 separates a targeted mutant from the repair. Each revision runs in 10 to 25 s once the NuGet cache is warm [M]. The one real trap is a compiler version mismatch that makes a consumer build look green for the wrong reason. It has a one-line workaround (see Blockers).

## Revisions

| Label | Commit | What it is |
|---|---|---|
| base | `32258fdb` | Parent of the sponsor change, before any 2283 work |
| head | `9df83c38` | `ju26-issue-2283`, sponsor's agent-written "implementation for #2283" (2026-11-12) |
| mid | `2d7b802b` | First local fix commit, "Decide diagnostic ownership per type" (2026-11-14) |
| fix | `8c146e4e` | `local/2283-ownership-fix` tip, "Route MsgPack003 through the per-type reporter too" (2026-11-14) |
| mutp2 | head + 1-line mutant | `ReportIfLocatedInCompilation` guard replaced by `if (true)`, so metadata-located diagnostics are reported again |

The fix commits are dated at the event (2026-11-14), so they satisfy the "code written at the event" rule [M, from `git log`]. Note that `fix` adds one test, `ClosedGenericStruct_FromMetadataReference_TypeArgumentNotMessagePackObject`, which is the P1 check. Head's three metadata-reference tests are the F1/P2 checks.

## Environment

- Host `dotnet` 10.0.13 host with runtimes 9.0.21 and 10.0.13, but **no SDK installed** [M]. `dotnet --version` fails with "A compatible .NET SDK was not found. Requested SDK version: 8.0.402".
- `global.json` pins `8.0.402` with `rollForward: patch` [M].
- Podman image `mcr.microsoft.com/dotnet/sdk:8.0` (image id `45d16602f24a`, already pulled, 877 MB) ships SDK **8.0.428** [M]. That satisfies the pin, since `patch` roll-forward allows any 8.0.4xx at or above 402 [I, from documented SDK roll-forward rules].
- The repo builds analyzers against Roslyn **4.12.0** (`Directory.Packages.props`, `MicrosoftCodeAnalysisVersion`) [M]. SDK 8.0.428 runs compiler **4.11.0** [M, from CS9057 text].
- NuGet restore needs network. The fresh cache grew to 709 MB [M].

## Method

Each revision got a detached `git worktree` under `/tmp/claude-1000/j26-2283-feasibility/<label>`. For base, head, mid and mutp2, the test file `tests/MessagePack.SourceGenerator.Tests/GenericsFormatterTests.cs` was overwritten (untracked, in the worktree only) with the version from `8c146e4e`. That file is a superset of head's test file, so every revision runs the identical checks. All worktrees were removed afterwards with `git worktree remove --force` and `git worktree prune` [M].

Runner (the main repo `.git` is mounted read-only because Nerdbank.GitVersioning reads git history through the worktree's gitdir link):

```sh
# run.sh <label> [filter]
R=/tmp/claude-1000/j26-2283-feasibility; S=/home/kort/Work/j26/samples/junction26-messagepack-csharp
podman run --rm --userns=keep-id -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 -e NUGET_PACKAGES=$R/nuget \
  -v $S/.git:$S/.git:ro -v $R:$R -w $R/$1 mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet test tests/MessagePack.SourceGenerator.Tests/MessagePack.SourceGenerator.Tests.csproj \
    --filter "FullyQualifiedName~FromMetadataReference" \
    --logger "console;verbosity=normal" --logger "trx;LogFileName=$R/logs/$1.trx"
```

The full-suite runs dropped `--filter`. Test classes have no namespace, so a `FullyQualifiedName~MessagePack` filter matches only 5 tests [M]. Do not use it.

Consumer build (a real two-assembly build, the shape the issue describes). It used `tests/Ju2283Lib`, which defines `[MessagePackObject] public struct MyGenericStruct<T> { [Key(0)] public T Content {get;set;} }` and references only `src/MessagePack`. It also used `tests/Ju2283App`, which imports `tests/SourceGeneratorConsumer.props`, references the lib, declares `MyObject` with a `MyGenericStruct<int>` member and a `[GeneratedMessagePackResolver] partial class MyResolver`, and whose `Main` returns 0 only if reflection finds the generated `MyResolver.Instance` field. The command was `dotnet build --no-incremental` then `dotnet run --no-build`, in the same container. The sources are in `/tmp/claude-1000/-home-kort-Work-j26/b5b8f989-9960-469b-ad08-a15fc93744e2/scratchpad/consumer/`, which is temporary, so recreate them from this description if it is gone.

Logs and TRX files are in `/tmp/claude-1000/j26-2283-feasibility/logs/`. That folder is temporary too.

## Results per revision

### Unit checks (filtered run, 4 metadata-reference tests)

| Test | base | head | mid | fix | mutp2 |
|---|---|---|---|---|---|
| `ClosedGenericStruct_FromMetadataReference` (F1) | Fail | Pass | Pass | Pass | Pass |
| `ClosedGenericRecordStruct_FromMetadataReference` (F1) | Fail | Pass | Pass | Pass | Pass |
| `ClosedGenericStruct_FromMetadataReference_UnkeyedMember` (P2) | Fail | Pass | Pass | Pass | **Fail** |
| `..._TypeArgumentNotMessagePackObject` (P1) | Fail | **Fail** | Pass | Pass | Fail |

All cells are [M]. The mid and mutp2 columns come from full-suite runs, the others from both the filtered and the full runs.

Observed failure reasons [M]:

- **base.** Every test fails with `CS8785: Generator 'MessagePackGenerator' failed to generate source ... IndexOutOfRangeException` plus `AD0001` from `MsgPack00xMessagePackAnalyzer`. The stack is at `TypeCollector.GetObjectInfo`, `TypeCollector.cs:1075`, which is `item.DeclaringSyntaxReferences[0]` on a member that exists only in metadata. This is issue 2283 reproduced.
- **head, P1.** `Mismatch between number of diagnostics returned, expected "1" actual "0"`. MsgPack003 for the user type `Foo` is suppressed. This matches the project-log claim that the agent patch drops MsgPack003. The cause [I] is that head picks `callerSymbol.Locations[0]`, which is the metadata property `MyGenericStruct<T>.Content`, and then `ReportIfLocatedInCompilation` drops the diagnostic because that location is not in source.
- **mutp2, P2.** `expected "0" actual "2"`, with two `MsgPack004` diagnostics for `MyGenericStruct<T>.Unkeyed` and `MyGenericStruct<int>.Unkeyed` that have no source location. **mutp2, P1.** `Expected diagnostic to be in file "/0/Test0.cs" was actually in file ""`. MsgPack003 is reported, but at the metadata location.

### Full source-generator suite (171 tests)

| Revision | Passed | Failed | Exit | Wall |
|---|---|---|---|---|
| base | 167 | 4 (the four above) | 1 | 11 s |
| head | 170 | 1 (P1) | 1 | 13 s |
| mid | 171 | 0 | 0 | 24 s |
| fix | 171 | 0 | 0 | 12 s |
| mutp2 | 169 | 2 (P2, P1) | 1 | 22 s |

All [M]. No test outside the four metadata-reference tests changes outcome across revisions, so this run shows no regression from either fix commit. Runs of 22 to 24 s include a first build of a new worktree.

### Consumer build (real `dotnet build` of two assemblies)

| Revision | Build exit | Generator diagnostics | Resolver file in `obj/.../generated` | `MyResolver.Instance` at runtime |
|---|---|---|---|---|
| base (Roslyn 4.11, default) | 0 | CS9057 only | none | missing (exit 2) |
| fix (Roslyn 4.11, default) | 0 | CS9057 only | none | missing (exit 2) |
| base (Toolset 4.12) | **0** | `AD0001` and `CS8785` (`IndexOutOfRangeException`), warnings only | none | **missing (exit 2)** |
| head (Toolset 4.12) | 0 | none | `Formatters.TempProject.MyResolver.TempProject.MyGenericStructFormatter`1.g.cs` | present (exit 0) |
| fix (Toolset 4.12) | 0 | none | same file | present (exit 0) |

All [M]. Wall time was 16 to 21 s per revision. The base row with Toolset 4.12 is the issue's exact symptom: the build is green with 0 errors, while the resolver is absent.

## Which candidate checks discriminate

| Check | Broken variant it fails on | Reviewed repair it passes on | Verdict |
|---|---|---|---|
| **Weak, build exit code** | none, exit 0 on base | exit 0 | Does **not** discriminate [M]. This is the "weak generated check" for walkthrough step 3. |
| **F1** (no AD0001/CS8785, resolver hint generated) | base | head, mid, fix | Discriminates base from every repair [M]. Cannot separate head from fix, and should not, because head does fix the crash. |
| **F1-consumer** (real build plus runtime `Instance` probe) | base | head, fix | Discriminates [M], **only with Roslyn 4.12 in the build**. Under the stock 8.0.4xx compiler it fails on the repair too (false alarm). |
| **P1** (MsgPack003 kept for user type reached via metadata generic) | head, mutp2 (also base, by crash) | mid, fix | Discriminates head from fix [M]. This is the check that catches the agent's regression. It does not separate mid from fix, because `8c146e4e` is a refactor with the same behaviour on this case [M for the test outcome, I for "refactor", from the 3-line diff]. |
| **P2** (no diagnostics at metadata-only locations) | mutp2 (also base, by crash) | head, mid, fix | Discriminates the targeted fault [M]. On base it fails only through the crash, so base alone does not validate P2. The mutant is what validates it. |

## Blockers and risks

1. **Roslyn mismatch (real, solved).** Under the pinned SDK band, the generator never loads in a consumer build: `CS9057: The analyzer assembly ... references version '4.12.0.0' of the compiler, which is newer than the currently running version '4.11.0.0'` [M]. The build stays green and the resolver is missing even on the fixed code. That would turn F1-consumer into a false alarm on the repair. The fix is `<PackageReference Include="Microsoft.Net.Compilers.Toolset" VersionOverride="4.12.0" PrivateAssets="all" />` in the consumer csproj, because CPM is on [M, worked]. An SDK 9 image is an alternative [I, not tried]. The unit-test checks are not affected, since they load Roslyn 4.12 in-process [M, they pass on fix].
2. **Network for restore.** The cache holds 709 MB of packages [M]. Pre-warm it before the demo, and keep `NUGET_PACKAGES` on a persistent path. `/tmp` is cleared on reboot [I].
3. **Test overlay provenance.** The P1 test lives only on `local/2283-ownership-fix`. The runner must take check files from a frozen location outside the candidate's workspace, as the concept's step 5 requires. Today it is a `git show 8c146e4e:<path>` overlay [M], which works.
4. **mid versus fix.** No check here separates them. That is fine for the demo, but do not present `8c146e4e` as a behaviour change [I].
5. **Nerdbank.GitVersioning** needs the repo's `.git` visible inside the container [M, the worktree build works only with the main `.git` mounted]. A runner that copies sources without git would need `/p:NBGV_...` tweaks or a full clone [I].

## Time estimate for a repeatable runner

All [I], from the timings above.

- Script that runs worktree, overlay, `dotnet test` with TRX, consumer build and probe, cleanup, for N revisions, and emits one JSON per revision with outcome per check ID, distinguishing build failure, no assertion reached and assertion failure: **2 to 3 hours**.
- Mutant set (mutp2 plus a P1 mutant, for example head itself) kept outside the workspace: **30 minutes**.
- Importing the report into the existing review page: not measured here. The size of that task depends on the page's import format.
- Demo runtime with a warm cache: about 15 s per revision for the unit checks, plus about 16 s for the consumer check. That is about 2 minutes for base, head and fix together [M per run, I for the sum].
