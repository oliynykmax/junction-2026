// The reviewer agent: its stored review document, its GitHub-backed tools and
// its system prompt, as one pi-durable extension.

import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord/context";
import { gh, ghJson } from "./github";

export type Target = {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  installationId: number;
};

export type Severity = "blocker" | "major" | "minor";

export type Finding = {
  id: string;
  path: string;
  line: number | null;
  severity: Severity;
  title: string;
  body: string;
};

export type Verdict = {
  decision: "no_blockers_found" | "changes_requested";
  summary: string;
  notChecked: string[];
};

export type ReviewState = {
  target: Target | null;
  prompt: { url: string; sha256: string; text: string } | null;
  model: string | null;
  startedAt: number | null;
  findings: Finding[];
  verdict: Verdict | null;
};

export const EMPTY_REVIEW: ReviewState = {
  target: null,
  prompt: null,
  model: null,
  startedAt: null,
  findings: [],
  verdict: null,
};

export const ReviewDoc = defineDoc<ReviewState>({
  kind: "review.state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => structuredClone(EMPTY_REVIEW),
  checkpointWhen: () => false,
});

type Token = (installationId: number) => Promise<string>;

type PrFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

const MAX_FILE_LINES = 400;

export function reviewerExtension(token: Token) {
  async function target(api: ToolExecutionApi, context: Context) {
    const state = await api.snapshot(ReviewDoc, api.conversationId, context);
    if (!state?.target) throw new Error("review has no target");
    return { t: state.target, tok: await token(state.target.installationId) };
  }

  async function prFiles(t: Target, tok: string): Promise<PrFile[]> {
    const files: PrFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await ghJson<PrFile[]>(
        tok,
        `/repos/${t.owner}/${t.repo}/pulls/${t.number}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  const text = (s: string) => ({
    output: [{ type: "text" as const, text: s }],
  });

  const prOverview = defineTool({
    name: "pr_overview",
    description:
      "Title, description, base and head of the pull request, and every changed file with its line counts.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const { t, tok } = await target(api, context);
      const [pr, files] = await Promise.all([
        ghJson<{
          title: string;
          body: string | null;
          user: { login: string };
          base: { ref: string; sha: string };
          head: { ref: string; sha: string };
        }>(tok, `/repos/${t.owner}/${t.repo}/pulls/${t.number}`),
        prFiles(t, tok),
      ]);
      const list = files
        .map(
          (f) =>
            `${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.filename}`,
        )
        .join("\n");
      return text(
        `#${t.number} ${pr.title} (by ${pr.user.login})\n` +
          `base ${pr.base.ref} ${pr.base.sha}\nhead ${pr.head.ref} ${t.headSha}\n\n` +
          `${pr.body ?? "(no description)"}\n\n${files.length} files changed:\n${list}`,
      );
    },
  });

  const readPatch = defineTool({
    name: "read_patch",
    description: "The unified diff of one changed file in the pull request.",
    parameters: obj({ path: str() }),
    replay: "safe",
    execute: async ({ path }, api, context) => {
      const { t, tok } = await target(api, context);
      const file = (await prFiles(t, tok)).find((f) => f.filename === path);
      if (!file) throw new Error(`${path} is not changed in this pull request`);
      return text(file.patch ?? "(no textual diff: binary or too large)");
    },
  });

  const readFile = defineTool({
    name: "read_file",
    description: `A file at the PR head (or base) with line numbers. At most ${MAX_FILE_LINES} lines per call; page with start_line.`,
    parameters: obj({
      path: str(),
      ref: opt(oneOf(["head", "base"])),
      start_line: opt(int()),
    }),
    replay: "safe",
    execute: async ({ path, ref, start_line }, api, context) => {
      const { t, tok } = await target(api, context);
      const sha =
        ref === "base"
          ? (
              await ghJson<{ base: { sha: string } }>(
                tok,
                `/repos/${t.owner}/${t.repo}/pulls/${t.number}`,
              )
            ).base.sha
          : t.headSha;
      const res = await gh(
        tok,
        `/repos/${t.owner}/${t.repo}/contents/${encodeURI(path)}?ref=${sha}`,
        { accept: "application/vnd.github.raw+json" },
      );
      const lines = (await res.text()).split("\n");
      const from = Math.max(1, start_line ?? 1);
      const to = Math.min(lines.length, from + MAX_FILE_LINES - 1);
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");
      const more =
        to < lines.length ? `\n... ${lines.length - to} more lines` : "";
      return text(
        `${path}@${sha.slice(0, 7)} (${lines.length} lines)\n${body}${more}`,
      );
    },
  });

  const listDir = defineTool({
    name: "list_dir",
    description:
      "Entries of a directory at the PR head. Use '' for the repo root.",
    parameters: obj({ path: str() }),
    replay: "safe",
    execute: async ({ path }, api, context) => {
      const { t, tok } = await target(api, context);
      const entries = await ghJson<{ name: string; type: string }[]>(
        tok,
        `/repos/${t.owner}/${t.repo}/contents/${encodeURI(path)}?ref=${t.headSha}`,
      );
      return text(
        entries
          .map((e) => `${e.type === "dir" ? "d" : "f"} ${e.name}`)
          .join("\n"),
      );
    },
  });

  const reportFinding = defineTool({
    name: "report_finding",
    description:
      "Record one review finding. Call once per finding, as soon as you are sure of it. Findings are shown to the human owner of the change.",
    parameters: obj({
      path: str(),
      line: opt(int()),
      severity: oneOf(["blocker", "major", "minor"]),
      title: str(),
      body: str(),
    }),
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        const state = await tx.doc(ReviewDoc, api.conversationId);
        if (state.findings.some((f) => f.id === api.callId)) return;
        state.findings.push({
          id: api.callId,
          path: args.path,
          line: args.line ?? null,
          severity: args.severity,
          title: args.title,
          body: args.body,
        });
      }, context);
      return text("recorded");
    },
  });

  const finishReview = defineTool({
    name: "finish_review",
    description:
      "End the review. Call exactly once, after every finding is recorded. Your decision is advice to the human owner, never an approval.",
    parameters: obj({
      decision: oneOf(["no_blockers_found", "changes_requested"]),
      summary: str(),
      not_checked: arr(str()),
    }),
    execute: async ({ decision, summary, not_checked }, api, context) => {
      await api.commit(async (tx) => {
        const state = await tx.doc(ReviewDoc, api.conversationId);
        state.verdict = { decision, summary, notChecked: not_checked };
      }, context);
      return { ...text("review finished"), control: { terminate: true } };
    },
  });

  return defineExtension({
    name: "reviewer",
    tools: [
      prOverview,
      readPatch,
      readFile,
      listDir,
      reportFinding,
      finishReview,
    ],
    sections: [
      section(
        "review_rubric",
        async (input, context) =>
          (await input.read.snapshot(ReviewDoc, input.conversationId, context))
            ?.prompt?.text,
      ),
      section("review_protocol", () => PROTOCOL),
    ],
  });
}

const PROTOCOL = `You are running as an automated reviewer on a GitHub pull request, with read-only access through tools. There is no shell and no checkout.

1. Start with pr_overview. Read each changed file's patch with read_patch, and read surrounding code with read_file or list_dir where the diff alone is not enough to judge.
2. Apply the review rubric above to the pull request's changes.
3. Record every finding with report_finding as soon as you are sure of it: the file, the line at the PR head when one applies, a severity (blocker, major or minor), a one-line title and a body that says what is wrong, why it matters and the better structure.
4. Finish with finish_review exactly once. Give your decision, a short summary for the human owner, and in not_checked everything you did not read or could not judge (files skipped, behaviour you could not run, missing context), with the reason.

Your output is advice to a named human who owns the merge. Never claim the change is approved. Prefer a few high-conviction findings over many nits. Do not invent code you have not read through a tool.`;
