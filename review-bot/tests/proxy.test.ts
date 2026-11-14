import { expect, test } from "bun:test";
import { originRequest } from "../src/proxy";

const env = {
  ORIGIN_URL: "https://origin.example.com",
  ORIGIN_TOKEN: "gateway-token",
};

test("gateway preserves webhook bytes and signature while replacing forwarding headers", async () => {
  const request = new Request(
    "https://review.oliinyk.dev/webhook?delivery=123",
    {
      method: "POST",
      body: '{"action":"opened"}\n',
      headers: {
        "x-hub-signature-256": "sha256=signature",
        "cf-connecting-ip": "192.0.2.1",
        "x-celld-origin-token": "spoofed",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "spoofed",
        forwarded: "host=evil.example",
      },
    },
  );
  const upstream = originRequest(request, env);
  expect(upstream.url).toBe("https://origin.example.com/webhook?delivery=123");
  expect(await upstream.text()).toBe('{"action":"opened"}\n');
  expect(upstream.headers.get("x-hub-signature-256")).toBe("sha256=signature");
  expect(upstream.headers.get("cf-connecting-ip")).toBe("192.0.2.1");
  expect(upstream.headers.get("x-celld-origin-token")).toBe("gateway-token");
  expect(upstream.headers.get("x-forwarded-host")).toBe("review.oliinyk.dev");
  expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
  expect(upstream.headers.has("forwarded")).toBe(false);
  expect(upstream.headers.has("x-forwarded-for")).toBe(false);
  expect(upstream.redirect).toBe("manual");
});

test("gateway rejects insecure or ambiguous origins", () => {
  for (const ORIGIN_URL of [
    "http://origin.example.com",
    "https://user:pass@origin.example.com",
    "https://origin.example.com/path",
    "https://origin.example.com/?token=secret",
  ]) {
    expect(() =>
      originRequest(new Request("https://review.oliinyk.dev"), {
        ...env,
        ORIGIN_URL,
      }),
    ).toThrow();
  }
});
