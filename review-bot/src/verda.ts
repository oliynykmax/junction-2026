// Verda serves Kimi K3.1 Pro over an OpenAI-compatible API. The model entry
// reuses pi-ai's Moonshot catalog entry for the same model, so tool calls,
// reasoning content and thinking levels follow the upstream compat settings.

import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";

const BASE_URL = "https://inference.verda.com/v1";

export function verdaProvider() {
  const kimi = MOONSHOTAI_MODELS["kimi-k3.1-pro"];
  if (!kimi) throw new Error("pi-ai no longer lists moonshotai/kimi-k3.1-pro");
  return createProvider({
    id: "verda",
    name: "Verda",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Verda API key",
        resolve: async ({ ctx }) => {
          const key = await ctx.env("VERDA_API_KEY");
          return key
            ? { auth: { apiKey: key }, source: "VERDA_API_KEY" }
            : undefined;
        },
      },
    },
    models: [
      {
        ...kimi,
        id: "kimi-k3-1-pro",
        provider: "verda",
        baseUrl: BASE_URL,
        // pi-ai lists the whole 1M context as max output. Without the model's
        // real limit a turn asks for nearly all of it, and Verda rejects any
        // input that pi-ai's token estimate undercounts.
        maxTokens: 131_072,
        // Verda's list price, USD per 1M tokens.
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
      },
    ],
    api: openAICompletionsApi(),
  });
}
