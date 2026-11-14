// Deterministic checks that run before the agent: which tools apply to a
// pull request, the shape of their results, and how the agent is shown them.

export const SCAN_TOOLS = [
  "zizmor",
  "ty",
  "oxlint",
  "ruff-format",
  "oxfmt",
  "dotnet-ci",
  "dotnet-format",
] as const;
export type ScanTool = (typeof SCAN_TOOLS)[number];

export type Diagnostic = {
  tool: ScanTool;
  rule: string;
  severity: "error" | "warning" | "info";
  path: string;
  line: number | null;
  message: string;
  url: string | null;
};

export type ScanResult = {
  tool: ScanTool;
  version: string;
  status: "ok" | "error";
  durationMs: number;
  paths: string[];
  diagnostics: Diagnostic[];
  error: string | null;
};

export type ScanState = {
  status: "pending" | "done" | "skipped" | "failed";
  results: ScanResult[];
  error: string | null;
};

export type Check = { tool: ScanTool; paths: string[] };

const MATCHERS: Record<ScanTool, RegExp> = {
  zizmor: /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)action\.ya?ml$/,
  ty: /\.pyi?$/,
  oxlint: /\.[cm]?[jt]sx?$/,
  "ruff-format": /\.pyi?$/,
  oxfmt: /\.[cm]?[jt]sx?$/,
  "dotnet-ci":
    /\.(?:cs|csx|csproj|sln|props|targets)$|(^|\/)(?:global\.json|nuget\.config|packages\.lock\.json)$/i,
  "dotnet-format":
    /\.(?:cs|csx|csproj|sln|props|targets)$|(^|\/)(?:global\.json|nuget\.config|packages\.lock\.json)$/i,
};

export function planChecks(
  files: readonly { filename: string; status: string }[],
): Check[] {
  const present = files
    .filter((f) => f.status !== "removed")
    .map((f) => f.filename);
  return SCAN_TOOLS.map((tool) => ({
    tool,
    paths: present.filter((p) => MATCHERS[tool].test(p)),
  })).filter((c) => c.paths.length > 0);
}

export function renderScan(scan: ScanState | null): string | undefined {
  if (!scan || scan.status === "pending") return undefined;
  if (scan.status === "skipped")
    return "No scanner applies to the files this pull request changes.";
  if (scan.status === "failed")
    return `The scanners did not run: ${scan.error}. List this under not_checked.`;
  return scan.results
    .map((r) => {
      const head = `${r.tool} ${r.version} on ${r.paths.join(", ")}`;
      if (r.status === "error") return `${head}\nfailed: ${r.error}`;
      if (!r.diagnostics.length)
        return `${head}\ncompleted successfully with no diagnostics`;
      const lines = r.diagnostics.map(
        (d) =>
          `- [${d.severity}] ${d.rule} ${d.path}${d.line ? `:${d.line}` : ""}: ${d.message}`,
      );
      return `${head}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
