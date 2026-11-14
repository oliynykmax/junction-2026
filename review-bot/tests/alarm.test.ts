import { expect, test } from "bun:test";
import { alarmWrite, ARM_SLACK_MS, HEARTBEAT_MS } from "../src/alarm";

const now = 1_000_000;
const heartbeat = now + HEARTBEAT_MS;

test("sets a heartbeat while work runs and nothing is issued", () => {
  expect(alarmWrite({ active: true }, now, null)).toEqual({
    op: "set",
    at: heartbeat,
  });
});

test("keeps an issued heartbeat that is only milliseconds earlier", () => {
  expect(alarmWrite({ active: true }, now, heartbeat - 10)).toEqual({
    op: "keep",
  });
});

test("moves the heartbeat once the issued one is a second or more stale", () => {
  expect(alarmWrite({ active: true }, now, heartbeat - ARM_SLACK_MS)).toEqual({
    op: "set",
    at: heartbeat,
  });
});

test("moves an issued alarm earlier for a sooner sleep", () => {
  expect(alarmWrite({ active: true, at: now + 2_000 }, now, heartbeat)).toEqual(
    { op: "set", at: now + 2_000 },
  );
});

test("never keeps an issued alarm later than needed", () => {
  expect(
    alarmWrite({ active: false, at: now + 5_000 }, now, now + 5_001),
  ).toEqual({ op: "set", at: now + 5_000 });
});

test("deletes the alarm when nothing needs a process", () => {
  expect(alarmWrite({ active: false }, now, heartbeat)).toEqual({
    op: "delete",
  });
  expect(alarmWrite({ active: false }, now, null)).toEqual({ op: "delete" });
});
