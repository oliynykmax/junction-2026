export function reviewKey(t: {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  mode?: "manual" | "webhook";
}) {
  return `${t.mode === "manual" ? "manual:" : ""}${t.owner.toLowerCase()}/${t.repo.toLowerCase()}#${t.number}@${t.headSha}`;
}
