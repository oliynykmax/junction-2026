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
  limits = { hourly: 10, daily: 50, client: 2 },
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
    current.hourly >= limits.hourly ||
    current.daily >= limits.daily ||
    (current.clients[client] ?? 0) >= limits.client
  )
    return null;
  current.hourly++;
  current.daily++;
  current.clients[client] = (current.clients[client] ?? 0) + 1;
  return current;
}
export class ManualGate extends DurableObject {
  async admitLookup(client: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const budget = consume(
        await storage.get<Budget>("lookups"),
        client,
        Date.now(),
        { hourly: 30, daily: 100, client: 10 },
      );
      if (!budget) return false;
      await storage.put("lookups", budget);
      return true;
    });
  }
  async admit(client: string, reviewKey: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      if (await storage.get(`admitted:${reviewKey}`)) return true;
      const budget = consume(
        await storage.get<Budget>("budget"),
        client,
        Date.now(),
      );
      if (!budget) return false;
      await storage.put("budget", budget);
      await storage.put(`admitted:${reviewKey}`, true);
      return true;
    });
  }
}
