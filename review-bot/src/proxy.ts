export interface ProxyEnv {
  ORIGIN_URL: string;
  ORIGIN_TOKEN: string;
}

export function originRequest(request: Request, env: ProxyEnv): Request {
  const origin = new URL(env.ORIGIN_URL);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !env.ORIGIN_TOKEN
  )
    throw new Error("Configure an HTTPS ORIGIN_URL and ORIGIN_TOKEN");
  const incoming = new URL(request.url);
  origin.pathname = incoming.pathname;
  origin.search = incoming.search;
  const upstream = new Request(origin, request);
  upstream.headers.delete("host");
  upstream.headers.set("x-celld-origin-token", env.ORIGIN_TOKEN);
  upstream.headers.set("x-forwarded-host", incoming.host);
  upstream.headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  upstream.headers.delete("forwarded");
  upstream.headers.delete("x-forwarded-for");
  return new Request(upstream, { redirect: "manual" });
}

export default {
  async fetch(request, env) {
    try {
      return await fetch(originRequest(request, env));
    } catch {
      return new Response("Review service temporarily unavailable.\n", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<ProxyEnv>;
