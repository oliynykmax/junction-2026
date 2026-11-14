import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "finding-evidence-"));
const copy = join(scratch, "review-bot");
const run = (pattern) =>
  Bun.spawnSync(
    [process.execPath, "test", "tests/changes.test.ts", "-t", pattern],
    { cwd: copy, stdout: "pipe", stderr: "pipe" },
  );

try {
  await mkdir(copy);
  for (const name of ["src", "web", "tests", "package.json", "tsconfig.json"])
    await cp(join(bot, name), join(copy, name), { recursive: true });
  await cp(join(bot, "../.agents"), join(scratch, ".agents"), {
    recursive: true,
  });
  await symlink(join(bot, "node_modules"), join(copy, "node_modules"));
  const path = join(copy, "src/reviewer.ts");
  const original = await readFile(path, "utf8");
  const variants = [
    {
      name: "mandatory changed-file coverage",
      pattern:
        "finish gate rejects every incomplete receipt set in a two-file review",
      before: "if (unverified.length)",
      after: "if (false && unverified.length)",
    },
    {
      name: "required finding reason evidence and fix",
      pattern: "finding evidence boundaries require reason evidence and fix",
      before: "if (problems.length) return;\n        state.findings.push({",
      after:
        "if (false && problems.length) return;\n        state.findings.push({",
    },
    {
      name: "execution confidence requires a counterexample",
      pattern: "unrun or passing receipts cannot promote execution claims",
      before:
        'evidence.kind === "execution" && receipt.outcome !== "counterexample"',
      after: 'evidence.kind === "execution" && false',
    },
  ];
  for (const variant of variants) {
    assert.equal(
      run(variant.pattern).exitCode,
      0,
      `${variant.name} baseline must pass`,
    );
    const escaped = variant.before
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const target = new RegExp(escaped);
    assert(target.test(original), `${variant.name} mutation target must exist`);
    await writeFile(path, original.replace(target, variant.after));
    const broken = run(variant.pattern);
    assert.notEqual(
      broken.exitCode,
      0,
      `${variant.name} broken variant must fail`,
    );
    const output = new TextDecoder().decode(broken.stderr);
    assert(
      output.includes("expect("),
      `${variant.name} must fail an assertion, not fail to load`,
    );
    console.log(
      `${variant.name}: baseline passed; broken variant rejected by an assertion`,
    );
    await writeFile(path, original);
    assert.equal(
      run(variant.pattern).exitCode,
      0,
      `${variant.name} restored check must pass`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
