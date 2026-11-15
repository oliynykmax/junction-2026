import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  installVerificationSkill,
  VERIFICATION_SKILL,
} from "../src/verification-skill";
import { renderBrief } from "../src/brief";

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

test("the review brief carries both the reviewer rubric and the runtime verification skill", () => {
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
  expect(text).toContain(VERIFICATION_SKILL);
  expect(text).toContain("record_verification");
  expect(text).toContain("not independently authenticated runtime evidence");
});
