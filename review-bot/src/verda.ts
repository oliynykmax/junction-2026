// Verda serves Kimi K3.1 Pro over an OpenAI-compatible API. The model entry
// reuses pi-ai's Moonshot catalog entry for the same model, so tool calls,
// reasoning content and thinking levels follow the upstream compat settings.

import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";

const BASE_URL = "https://inference.verda.com/v1";

export function verdaProvider() {
  const kimi = MOONSHOTAI_MODELS["kimi-k3.1-pro"];
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
        // Verda's per-token price is not published to us, so cost stays unpriced.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: openAICompletionsApi(),
  });
}
