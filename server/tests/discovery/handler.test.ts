import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerDiscovery } from "../../src/discovery/handler.js";

describe("GET /discover", () => {
  it("returns the configured primary WS URL", async () => {
    const app = Fastify();
    registerDiscovery(app, { publicWsUrl: "wss://example/ws" });
    const res = await app.inject({ method: "GET", url: "/discover" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-cache/);
    expect(res.json()).toEqual({ primary: "wss://example/ws" });
  });
});
