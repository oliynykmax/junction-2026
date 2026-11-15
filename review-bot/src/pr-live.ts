// What the review page shows about the PR that the review does not store:
// its title, author and branches, and the CI on the reviewed commit, read
// from GitHub when the page asks.

import { type CiSource, collectCi } from "./evidence";
import { type AppSecrets, gh, repoToken } from "./github";

export type PrMeta = {
  title: string;
  author: string;
  avatarUrl: string | null;
  base: string;
  head: string;
  updatedAt: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
};

export type PrLive = {
  pr: PrMeta | null;
  checks: CiSource;
  statuses: CiSource;
};

const text = (v: unknown) => (typeof v === "string" ? v : null);
const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)[key]
    : undefined;

export function parsePr(data: unknown): PrMeta | null {
  const title = text(field(data, "title"));
  const author = text(field(field(data, "user"), "login"));
  const base = text(field(field(data, "base"), "ref"));
  const head = text(field(field(data, "head"), "ref"));
  const updatedAt = text(field(data, "updated_at"));
  if (!title || !author || !base || !head || !updatedAt) return null;
  const avatar = text(field(field(data, "user"), "avatar_url"));
  return {
    title,
    author,
    avatarUrl: avatar?.startsWith("https://avatars.githubusercontent.com/")
      ? avatar
      : null,
    base,
    head,
    updatedAt,
    state: field(data, "merged_at")
      ? "merged"
      : field(data, "state") === "closed"
        ? "closed"
        : "open",
    draft: field(data, "draft") === true,
  };
}

export async function prLive(
  app: AppSecrets,
  t: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    mode: "manual" | "webhook";
  },
): Promise<PrLive> {
  // Manual reviews never use app credentials. Public repos the app is not
  // installed on are read anonymously too.
  const token =
    t.mode === "manual"
      ? ""
      : await repoToken(app, t.owner, t.repo).catch(() => "");
  const [pr, ci] = await Promise.all([
    gh(
      token,
      `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}/pulls/${t.number}`,
      { signal: AbortSignal.timeout(10_000) },
    )
      .then((res) => res.json())
      .then(parsePr)
      .catch(() => null),
    collectCi(token, t.owner, t.repo, t.headSha),
  ]);
  return { pr, ...ci };
}
