import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const isolateOption = async (file: string) =>
  (await readFile(join(import.meta.dir, file), "utf8")).match(
    /isolate=(\w+)/,
  )?.[1];

test("the deploy smoke check starts a worker on a network with the executor's isolate option", async () => {
  const used = await isolateOption("../executor/server.mjs");
  expect(used).toBeDefined();
  expect(await isolateOption("../scripts/celld-deploy.sh")).toBe(used);
});
