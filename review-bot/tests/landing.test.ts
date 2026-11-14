import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync("../landing/index.html", "utf8");
const client = readFileSync("web/landing.ts", "utf8");
const shell = readFileSync("src/page.ts", "utf8");

const keyIn = (source: string, pattern: RegExp) => {
  const match = source.match(pattern);
  if (!match) throw new Error(`No storage key found for ${pattern}`);
  return match[1];
};

test("the inline pre-paint scripts and the bundle use the same theme storage key", () => {
  const inline = keyIn(html, /localStorage\.getItem\("([^"]+)"\)/);
  const bundled = keyIn(client, /createLocalStorage\("([^"]+)"\)/);
  expect(inline).toBe(bundled);
  expect(keyIn(shell, /localStorage\.getItem\("([^"]+)"\)/)).toBe(bundled);
});

test("the SDK stores the theme choice as a bare value the inline script reads", async () => {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const had = {
    window: g.window,
    document: g.document,
    localStorage: g.localStorage,
  };
  g.window = g;
  g.document = {};
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    const { createColorScheme, createLocalStorage } =
      await import("@ui-sdk/core");
    const key = keyIn(client, /createLocalStorage\("([^"]+)"\)/);
    const scheme = createColorScheme({ storage: createLocalStorage(key) });
    scheme.set("dark");
    expect(store.get(key)).toBe("dark");
    scheme.set("light");
    expect(store.get(key)).toBe("light");
  } finally {
    g.window = had.window;
    g.document = had.document;
    g.localStorage = had.localStorage;
  }
});
