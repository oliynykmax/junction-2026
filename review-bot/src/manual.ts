import { gh } from "./github";
import type { Env } from "./review";
import type { Target } from "./reviewer";

export class ManualError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function parsePrUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 512)
    throw new ManualError("Enter a public GitHub pull request URL.");
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,8})\/?$/.exec(
      value.trim(),
    );
  if (!match || match[2] === "." || match[2] === "..")
    throw new ManualError(
      "Use https://github.com/owner/repository/pull/123 without a query or fragment.",
    );
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    number: Number(match[3]),
  };
}

export async function requirePublic(owner: string, repo: string) {
  try {
    const data: unknown = await (
      await gh("", `/repos/${owner}/${repo}`)
    ).json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("private" in data) ||
      data.private !== false ||
      !("visibility" in data) ||
      data.visibility !== "public"
    )
      throw new Error("not public");
  } catch {
    throw new ManualError(
      "This repository is not publicly accessible, or GitHub's public API limit has been reached. Try again later.",
      422,
    );
  }
}

export async function resolveManual(
  value: unknown,
): Promise<Target & { mode: "manual" }> {
  const pr = parsePrUrl(value);
  await requirePublic(pr.owner, pr.repo);
  try {
    const data: unknown = await (
      await gh("", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`)
    ).json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("head" in data) ||
      !("base" in data) ||
      !("changed_files" in data) ||
      !("additions" in data) ||
      !("deletions" in data)
    )
      throw new Error("invalid PR");
    const { head, base } = data;
    if (
      typeof head !== "object" ||
      head === null ||
      !("sha" in head) ||
      typeof head.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(head.sha) ||
      typeof base !== "object" ||
      base === null ||
      !("sha" in base) ||
      typeof base.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(base.sha)
    )
      throw new Error("invalid commit");
    if (
      typeof data.changed_files !== "number" ||
      typeof data.additions !== "number" ||
      typeof data.deletions !== "number"
    )
      throw new Error("invalid size");
    if (data.changed_files > 60 || data.additions + data.deletions > 4000)
      throw new ManualError(
        "This demo supports PRs with at most 60 files and 4,000 changed lines.",
        422,
      );
    return { ...pr, headSha: head.sha, baseSha: base.sha, mode: "manual" };
  } catch (error) {
    if (error instanceof ManualError) throw error;
    throw new ManualError(
      "Could not read that public pull request. Check the link, or try again after GitHub's API limit resets.",
      422,
    );
  }
}

export function manualKey(
  t: Pick<Target, "owner" | "repo" | "number" | "headSha">,
) {
  return `manual:${t.owner}/${t.repo}#${t.number}@${t.headSha}`;
}

export async function startManual(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new ManualError("Start reviews from this website.", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new ManualError("Send a JSON request.", 415);
    const reader = request.body?.getReader();
    if (!reader) throw new ManualError("Enter a pull request URL.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new ManualError("Request is too large.", 413);
      }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(await new Blob(chunks).text());
    if (typeof data !== "object" || data === null || !("url" in data))
      throw new ManualError("Enter a pull request URL.");
    parsePrUrl(data.url);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        request.headers.get("cf-connecting-ip") ?? "local",
      ),
    );
    const client = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (!(await env.MANUAL_GATE.getByName("public-starts").admit(client)))
      throw new ManualError(
        "The demo review limit has been reached. Try again later. Shared hourly and daily limits apply.",
        429,
      );
    const target = await resolveManual(data.url);
    await env.REVIEWS.getByName(manualKey(target)).start(target);
    return Response.json(
      {
        url: `/m/${target.owner}/${target.repo}/${target.number}?sha=${target.headSha}`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const known = error instanceof ManualError;
    return Response.json(
      {
        error: known
          ? error.message
          : error instanceof SyntaxError
            ? "Send valid JSON with a pull request URL."
            : "The review could not start. Please try again later.",
      },
      {
        status: known ? error.status : error instanceof SyntaxError ? 400 : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
