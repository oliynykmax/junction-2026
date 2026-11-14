import type { Wake } from "@earendil-works/pi-durable";

export const HEARTBEAT_MS = 60_000;

export const ARM_SLACK_MS = 1_000;

export type AlarmWrite =
  { op: "set"; at: number } | { op: "delete" } | { op: "keep" };

export function alarmWrite(
  wake: Wake,
  now: number,
  issued: number | null,
): AlarmWrite {
  const heartbeat = wake.active ? now + HEARTBEAT_MS : undefined;
  const at =
    heartbeat === undefined || wake.at === undefined
      ? (heartbeat ?? wake.at)
      : Math.min(heartbeat, wake.at);
  if (at === undefined) return { op: "delete" };
  if (issued !== null && issued <= at && at - issued < ARM_SLACK_MS)
    return { op: "keep" };
  return { op: "set", at };
}
