import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

test("failed worker removal stays unready and retries share one cleanup", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "executor-cleanup-"));
  const bin = join(scratch, "bin");
  await mkdir(bin);
  const count = join(scratch, "removals");
  await writeFile(
    join(bin, "podman"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "info")
  console.log(JSON.stringify({ store: { graphRootAllocated: 2 ** 50, graphRootUsed: 0 } }));
if (process.argv[2] === "rm") {
  const path = process.env.TEST_CLEANUP_COUNT;
  const count = fs.existsSync(path) ? Number(fs.readFileSync(path)) + 1 : 1;
  fs.writeFileSync(path, String(count));
  if (count === 1) process.exit(1);
  setTimeout(() => process.exit(0), 100);
}
`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = Bun.spawn(["node", "executor/server.mjs"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_CLEANUP_COUNT: count,
      EXECUTOR_PORT: String(port),
      EXECUTOR_BIND: "127.0.0.1",
      EXECUTOR_TOKEN: "test-only",
      EXECUTOR_WORK_ROOT: join(scratch, "work"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  const call = (path, input) =>
    fetch(`${url}/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
      },
      body: JSON.stringify({ session: "review", ...input }),
      signal: AbortSignal.timeout(3000),
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      ready = await fetch(url).then(
        () => true,
        () => false,
      );
      if (!ready) await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    expect(
      (
        await call("checkout", {
          owner: "test",
          repo: "repo",
          sha: "a".repeat(40),
          githubToken: "synthetic-token",
        })
      ).status,
    ).toBe(200);
    const failed = await call("release");
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toBe("worker cleanup failed");
    expect(
      (await (await call("shell", { command: "true" })).json()).error,
    ).toBe("checkout required");
    const retried = await Promise.all([call("release"), call("release")]);
    expect(retried.map((response) => response.status)).toEqual([200, 200]);
    expect(await readFile(count, "utf8")).toBe("2");
    expect((await call("release")).status).toBe(200);
    expect(await readFile(count, "utf8")).toBe("2");
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(scratch, { recursive: true, force: true });
  }
});
