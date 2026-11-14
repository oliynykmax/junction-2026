import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PREPAINT_SCRIPT, THEME_KEY } from "../src/theme";

const html = readFileSync("../landing/index.html", "utf8");
const bare = (s: string) => s.replace(/\s+/g, "");

test("landing/index.html inlines the shared pre-paint script", () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) =>
    bare(m[1]),
  );
  expect(inline).toContain(bare(PREPAINT_SCRIPT));
});

test("the review shell inlines the shared pre-paint script", () => {
  const shell = readFileSync("src/page.ts", "utf8");
  expect(shell).toContain("<script>${PREPAINT_SCRIPT}</script>");
});

test("the SDK stores the theme choice as a bare value the pre-paint script reads", async () => {
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
    const scheme = createColorScheme({
      storage: createLocalStorage(THEME_KEY),
    });
    scheme.set("dark");
    expect(store.get(THEME_KEY)).toBe("dark");
    scheme.set("light");
    expect(store.get(THEME_KEY)).toBe("light");
  } finally {
    g.window = had.window;
    g.document = had.document;
    g.localStorage = had.localStorage;
  }
});
