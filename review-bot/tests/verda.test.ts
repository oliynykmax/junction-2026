import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { verdaProvider } from "../src/verda";

test("Verda serves Kimi K3.1 Pro with Moonshot's compat and Verda's price", () => {
  const models = createModels();
  models.setProvider(verdaProvider());
  const kimi = models.getModel("verda", "kimi-k3-1-pro");
  expect(kimi?.baseUrl).toBe("https://inference.verda.com/v1");
  expect(kimi?.reasoning).toBe(true);
  expect(kimi?.maxTokens).toBe(65_536);
  expect(kimi?.cost).toEqual({
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 0,
  });
});
