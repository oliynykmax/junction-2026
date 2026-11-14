import { expect, test } from "bun:test";
import type { PrLive } from "../src/pr-live";
import { keepPolling } from "../web/app";

const snapshot = (states: ("pending" | "success")[]): PrLive => ({
  pr: null,
  checks: {
    kind: "available",
    items: states.map((state, id) => ({
      id,
      name: `check ${id}`,
      state,
      detail: state,
      url: null,
      source: "GitHub Actions",
    })),
  },
  statuses: { kind: "available", items: [] },
});

test("a failed read is retried whether or not the review is running", () => {
  expect(keepPolling(null, true)).toBe(true);
  expect(keepPolling(null, false)).toBe(true);
});

test("an empty first snapshot keeps polling while the review runs", () => {
  expect(keepPolling(snapshot([]), true)).toBe(true);
});

test("polling stops only once the review is done and no check is pending", () => {
  expect(keepPolling(snapshot(["pending"]), false)).toBe(true);
  expect(keepPolling(snapshot(["success"]), false)).toBe(false);
  expect(keepPolling(snapshot([]), false)).toBe(false);
});
