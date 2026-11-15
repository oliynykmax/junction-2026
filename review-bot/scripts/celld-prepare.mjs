import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const config = Bun.JSONC.parse(await Bun.file(`${root}/wrangler.jsonc`).text());
for (const key of [
  "account_id",
  "build",
  "observability",
  "preview_urls",
  "routes",
  "workers_dev",
])
  delete config[key];
config.main = "src/celld.ts";
config.rules = config.rules.map(({ fallthrough, ...rule }) => rule);
config.assets.directory = ".celld/assets";
config.vars.REVIEW_BASE_URL =
  process.env.REVIEW_BASE_URL ?? config.vars.REVIEW_BASE_URL;
delete config.vars.ORIGIN_URL;
const secretsPath = process.env.CELLD_SECRETS_FILE;
if (secretsPath) {
  const secrets = await Bun.file(secretsPath).json();
  for (const [key, value] of Object.entries(secrets)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string")
      throw new Error("Secrets must be a JSON object of string bindings");
    if (key in config.vars)
      throw new Error(`Secret cannot replace config binding ${key}`);
    config.vars[key] = value;
  }
}
if (process.argv.includes("--production")) {
  for (const key of [
    "APP_ID",
    "PRIVATE_KEY",
    "WEBHOOK_SECRET",
    "SCANNER_TOKEN",
    "ORIGIN_TOKEN",
    "EXECUTOR_TOKEN",
  ])
    if (!config.vars[key]) throw new Error(`Missing production secret ${key}`);
  for (const model of config.vars.MODELS) {
    const key =
      model.provider === "verda" ? "VERDA_API_KEY" : "ANTHROPIC_API_KEY";
    if (!config.vars[key]) throw new Error(`Missing production secret ${key}`);
  }
}
for (const [key, value] of Object.entries(config.vars)) {
  if (typeof value !== "string") config.vars[key] = JSON.stringify(value);
}
await mkdir(`${root}/.celld`, { recursive: true, mode: 0o700 });
await rm(`${root}/.celld/assets`, { recursive: true, force: true });
await cp(resolve(root, "../landing"), `${root}/.celld/assets`, {
  recursive: true,
});
await writeFile(`${root}/celld.json`, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
console.log("Prepared celld.json and .celld/assets");
