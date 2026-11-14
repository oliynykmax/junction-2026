import { DurableObject } from "cloudflare:workers";
export type Budget = {
  hour: number;
  day: number;
  hourly: number;
  daily: number;
  clients: Record<string, number>;
};
export function consume(
  previous: Budget | undefined,
  client: string,
  now: number,
): Budget | null {
  const hour = Math.floor(now / 3_600_000),
    day = Math.floor(now / 86_400_000);
  const current: Budget = {
    hour,
    day,
    hourly: previous?.hour === hour ? previous.hourly : 0,
    daily: previous?.day === day ? previous.daily : 0,
    clients: previous?.hour === hour ? { ...previous.clients } : {},
  };
  if (
    current.hourly >= 10 ||
    current.daily >= 50 ||
    (current.clients[client] ?? 0) >= 2
  )
    return null;
  current.hourly++;
  current.daily++;
  current.clients[client] = (current.clients[client] ?? 0) + 1;
  return current;
}
export class ManualGate extends DurableObject {
  async admit(client: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const budget = consume(
        await storage.get<Budget>("budget"),
        client,
        Date.now(),
      );
      if (!budget) return false;
      await storage.put("budget", budget);
      return true;
    });
  }
}
