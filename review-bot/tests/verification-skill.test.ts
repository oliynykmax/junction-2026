import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  installVerificationSkill,
  VERIFICATION_SKILL,
} from "../src/verification-skill";
import { renderBrief } from "../src/brief";
import { reviewerExtension } from "../src/reviewer";

test("the bundled skill installs outside an external checkout with exact script contents", async () => {
  const scratch = await mkdtemp(join(import.meta.dir, ".verification-skill-"));
  try {
    const workspace = join(scratch, "owner's external repo");
    await mkdir(workspace);
    const skill = installVerificationSkill(workspace);
    const result = Bun.spawnSync(["bash", "-c", skill.command], {
      cwd: workspace,
    });
    expect(result.exitCode).toBe(0);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(join(skill.directory, "SKILL.md"), "utf8")).toBe(
      VERIFICATION_SKILL,
    );
    expect(
      await readFile(
        join(skill.directory, "scripts/provision-verifiers.sh"),
        "utf8",
      ),
    ).toBe(
      await readFile(
        new URL(
          "../../.agents/skills/verify-pr-change/scripts/provision-verifiers.sh",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      Bun.spawnSync([
        "bash",
        "-n",
        join(skill.directory, "scripts/provision-verifiers.sh"),
      ]).exitCode,
    ).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the verifier's prompt carries the verification skill and the reviewer's brief does not", () => {
  const text = renderBrief({
    target: {
      mode: "manual",
      owner: "other",
      repo: "external",
      number: 2,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    },
    brief: null,
    files: [],
    rubric: "EXISTING REVIEW RUBRIC",
  });
  expect(text).toContain("EXISTING REVIEW RUBRIC");
  expect(text).toContain("call verify");
  expect(text).not.toContain(VERIFICATION_SKILL);
  expect(text).not.toContain("record_verification");
  const { verifier } = reviewerExtension({
    token: async () => "token",
    scan: async () => [],
    publish: async () => {},
    finished: () => {},
  });
  const protocol = verifier.sections.find(
    (s) => s.key === "verifier_protocol",
  )!;
  expect(String(protocol.render({} as never, {} as never))).toContain(
    VERIFICATION_SKILL,
  );
});
