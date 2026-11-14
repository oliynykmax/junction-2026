import { expect, test } from "bun:test";
import { celldBindings } from "../src/celld-bindings";

const raw = {
  MODELS: '[{"provider":"verda","id":"kimi-k3-1-pro"}]',
  MCP_SERVERS: '{"docs":{"url":"https://docs.example/mcp"}}',
  SCANNER_TOKEN: "fixture-secret",
};

test("CellD string bindings become the app config without changing secret bindings", () => {
  const decoded = celldBindings(raw);
  expect(decoded.MODELS).toEqual([{ provider: "verda", id: "kimi-k3-1-pro" }]);
  expect(decoded.MCP_SERVERS).toEqual({
    docs: { url: "https://docs.example/mcp" },
  });
  expect(decoded.SCANNER_TOKEN).toBe("fixture-secret");
  expect(raw.MODELS).toBe('[{"provider":"verda","id":"kimi-k3-1-pro"}]');
});

test("invalid model bindings fail before a review starts", () => {
  for (const MODELS of [
    "not json",
    "[]",
    "{}",
    '[{"provider":"unknown","id":"m"}]',
    '[{"provider":"verda","id":""}]',
  ]) {
    expect(() => celldBindings({ ...raw, MODELS })).toThrow();
  }
});

test("MCP configuration must be an object when present", () => {
  for (const MCP_SERVERS of ["null", "[]", '"string"']) {
    expect(() => celldBindings({ ...raw, MCP_SERVERS })).toThrow("MCP_SERVERS");
  }
  expect(celldBindings({ MODELS: raw.MODELS }).MCP_SERVERS).toBeUndefined();
});
