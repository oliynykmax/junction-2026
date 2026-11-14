export function reviewKey(t: {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  mode?: "manual" | "webhook";
}) {
  return `${t.mode === "manual" ? "manual:" : ""}${t.owner.toLowerCase()}/${t.repo.toLowerCase()}#${t.number}@${t.headSha}`;
}

/** The review page for one commit of a PR. */
export function reviewLink(
  env: { REVIEW_BASE_URL: string },
  t: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    mode?: "manual" | "webhook";
  },
) {
  return `${env.REVIEW_BASE_URL}/${t.mode === "manual" ? "m" : "r"}/${t.owner}/${t.repo}/${t.number}?sha=${t.headSha}`;
}
