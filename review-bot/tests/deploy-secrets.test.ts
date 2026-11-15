import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripts = join(import.meta.dir, "../scripts");

const merge = async (secrets: object, token: string) => {
  const proc = Bun.spawn(
    [
      "jq",
      "-c",
      "--arg",
      "t",
      token,
      "-f",
      join(scripts, "with-executor-token.jq"),
    ],
    { stdin: new Blob([JSON.stringify(secrets)]), stdout: "pipe" },
  );
  return JSON.parse(await new Response(proc.stdout).text());
};

test("the executor token comes from its own secret unless the app secrets already hold one", async () => {
  expect(await merge({ ORIGIN_TOKEN: "o" }, "fresh")).toEqual({
    ORIGIN_TOKEN: "o",
    EXECUTOR_TOKEN: "fresh",
  });
  expect(await merge({ EXECUTOR_TOKEN: null }, "fresh")).toEqual({
    EXECUTOR_TOKEN: "fresh",
  });
  expect(await merge({ EXECUTOR_TOKEN: "" }, "fresh")).toEqual({
    EXECUTOR_TOKEN: "fresh",
  });
  expect(await merge({ EXECUTOR_TOKEN: "own" }, "fresh")).toEqual({
    EXECUTOR_TOKEN: "own",
  });
});

test("celld-deploy.sh stops before any build or SSH when no token survives the merge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deploy-secrets-"));
  try {
    const file = join(dir, "secrets.json");
    await writeFile(
      file,
      JSON.stringify(await merge({ ORIGIN_TOKEN: "o" }, "")),
    );
    const env = Object.fromEntries(
      [
        "CELLD_SSH_HOST",
        "CELLD_BUCKET",
        "S3_ENDPOINT",
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
      ].map((k) => [k, "x"]),
    );
    const proc = Bun.spawn(["bash", join(scripts, "celld-deploy.sh")], {
      env: { PATH: process.env.PATH ?? "", ...env, CELLD_SECRETS_FILE: file },
      stderr: "pipe",
      stdout: "ignore",
    });
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain(
      "must contain a one-line EXECUTOR_TOKEN",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write-celld-secrets.sh writes the merged JSON and fails on malformed app secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deploy-secrets-"));
  try {
    const run = async (appSecrets: string) => {
      const out = join(dir, "out.json");
      const proc = Bun.spawn(
        ["bash", join(scripts, "write-celld-secrets.sh"), out],
        {
          env: {
            PATH: process.env.PATH ?? "",
            APP_SECRETS: appSecrets,
            EXECUTOR_TOKEN: "fresh",
          },
          stderr: "ignore",
          stdout: "ignore",
        },
      );
      return { code: await proc.exited, out };
    };
    const ok = await run('{"ORIGIN_TOKEN":"o"}');
    expect(ok.code).toBe(0);
    expect(JSON.parse(await Bun.file(ok.out).text())).toEqual({
      ORIGIN_TOKEN: "o",
      EXECUTOR_TOKEN: "fresh",
    });
    expect((await run("{not json")).code).not.toBe(0);
    expect((await run("")).code).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
