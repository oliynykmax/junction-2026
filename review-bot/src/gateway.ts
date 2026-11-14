import worker from "./index";
import proxy from "./proxy";
import type { Env } from "./review";
import type { ProxyEnv } from "./proxy";

export { Review, ManualGate, Hive } from "./index";

type GatewayEnv = Env & Partial<ProxyEnv>;

export default {
  fetch(request, env) {
    if (!env.ORIGIN_URL) return worker.fetch(request, env);
    if (!env.ORIGIN_TOKEN)
      return new Response("Review service temporarily unavailable.\n", {
        status: 503,
      });
    return proxy.fetch(request, {
      ORIGIN_URL: env.ORIGIN_URL,
      ORIGIN_TOKEN: env.ORIGIN_TOKEN,
    });
  },
  scheduled(controller, env, ctx) {
    if (!env.ORIGIN_URL) return worker.scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<GatewayEnv>;
