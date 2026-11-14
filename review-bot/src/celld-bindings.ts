import type { Env, ModelChoice } from "./review";

export type CelldEnv = Omit<Env, "MODELS" | "MCP_SERVERS"> & {
  MODELS: string;
  MCP_SERVERS?: string;
  ORIGIN_TOKEN?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function celldBindings(env: CelldEnv): Env {
  const models: unknown = JSON.parse(env.MODELS);
  if (!Array.isArray(models) || models.length === 0)
    throw new Error("MODELS must be a nonempty JSON array");
  const choices: ModelChoice[] = models.map((model: unknown) => {
    if (
      !record(model) ||
      (model.provider !== "anthropic" && model.provider !== "verda") ||
      typeof model.id !== "string" ||
      !model.id
    )
      throw new Error("MODELS contains an invalid model");
    return { provider: model.provider, id: model.id };
  });
  const mcp: unknown = env.MCP_SERVERS
    ? JSON.parse(env.MCP_SERVERS)
    : undefined;
  if (mcp !== undefined && !record(mcp))
    throw new Error("MCP_SERVERS must be a JSON object");
  return { ...env, MODELS: choices, MCP_SERVERS: mcp };
}
