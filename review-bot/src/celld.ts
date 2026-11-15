import worker from "./index";
import { Review as WorkerReview } from "./review";
import { Hive as WorkerHive } from "./chat";
import { celldBindings, type CelldEnv } from "./celld-bindings";

export { ManualGate } from "./manual-gate";

export class Review extends WorkerReview {
  constructor(state: DurableObjectState, env: CelldEnv) {
    super(state, celldBindings(env));
  }
}

export class Hive extends WorkerHive {
  constructor(state: DurableObjectState, env: CelldEnv) {
    super(state, celldBindings(env));
  }
}

export default {
  fetch(request, env) {
    if (
      env.ORIGIN_TOKEN &&
      request.headers.get("x-celld-origin-token") !== env.ORIGIN_TOKEN
    )
      return new Response("Forbidden\n", { status: 403 });
    return worker.fetch(request, celldBindings(env));
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled(controller, celldBindings(env), ctx);
  },
} satisfies ExportedHandler<CelldEnv>;
