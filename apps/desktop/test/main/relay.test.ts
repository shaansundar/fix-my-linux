import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRelay, type BlockedReason, type Upstream } from "../../src/main/relay";

type Seen = { url: string; headers: IncomingHttpHeaders; body: string };

describe("ModelRelay", () => {
  let upstreamServer: Server;
  let upstreamURL: string;
  let seen: Seen[];
  let reply: { status: number; body: string; type?: string; chunks?: string[] };
  let relay: ModelRelay;
  let upstream: Upstream;
  let blocked: BlockedReason[];

  beforeEach(async () => {
    seen = [];
    blocked = [];
    reply = { status: 200, body: "ok" };
    upstreamServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        res.writeHead(reply.status, { "content-type": reply.type ?? "text/plain" });
        if (reply.chunks) {
          let i = 0;
          const tick = () => {
            if (i < reply.chunks!.length) {
              res.write(reply.chunks![i++]);
              setTimeout(tick, 5);
            } else res.end();
          };
          tick();
        } else res.end(reply.body);
      });
    });
    await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
    upstreamURL = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;
    upstream = { baseURL: `${upstreamURL}/zen/v1`, credential: () => "device-token", style: "bearer" };
    relay = new ModelRelay("nonce", () => upstream);
    relay.on("blocked", (b) => blocked.push(b));
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
    upstreamServer.closeAllConnections();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
  });

  const post = (path: string, headers: Record<string, string>, body = "{}") =>
    fetch(`${relay.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("rejects requests without the nonce", async () => {
    const res = await post("/zen/v1/chat/completions", { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("swaps the nonce for the device token and forwards path and body", async () => {
    const res = await post("/zen/v1/chat/completions", { authorization: "Bearer nonce" }, '{"model":"m"}');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen[0]).toMatchObject({ url: "/zen/v1/chat/completions", body: '{"model":"m"}' });
    expect(seen[0]!.headers["authorization"]).toBe("Bearer device-token");
  });

  it.each([
    ["x-api-key", "/zen/v1/messages"],
    ["x-goog-api-key", "/zen/v1/models/gemini-3-flash:streamGenerateContent"],
  ])("accepts the nonce in %s and sends the backend a bearer token", async (header, path) => {
    await post(path, { [header]: "nonce" });
    expect(seen[0]!.headers["authorization"]).toBe("Bearer device-token");
    expect(seen[0]!.headers[header]).toBeUndefined();
  });

  it("preserves the header style when talking to Zen directly", async () => {
    upstream = { ...upstream, credential: () => "zen-key", style: "preserve" };
    await post("/zen/v1/messages", { "x-api-key": "nonce" });
    expect(seen[0]!.headers["x-api-key"]).toBe("zen-key");
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
  });

  it("moves a query-string key into a header", async () => {
    await post("/zen/v1/models/g:streamGenerateContent?alt=sse&key=nonce", {});
    expect(seen[0]!.url).toBe("/zen/v1/models/g:streamGenerateContent?alt=sse");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer device-token");
  });

  it("streams chunks through as they arrive", async () => {
    reply = { status: 200, body: "", type: "text/event-stream", chunks: ["data: 1\n\n", "data: 2\n\n", "data: [DONE]\n\n"] };
    const res = await post("/zen/v1/chat/completions", { authorization: "Bearer nonce" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: 1\n\ndata: 2\n\ndata: [DONE]\n\n");
  });

  it("reports paywall and budget errors and still forwards them", async () => {
    reply = {
      status: 402,
      type: "application/json",
      body: JSON.stringify({ error: { code: "trial_ended", message: "Your free trial has ended." } }),
    };
    const res = await post("/zen/v1/chat/completions", { authorization: "Bearer nonce" });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: { code: "trial_ended", message: "Your free trial has ended." } });
    expect(blocked).toEqual([{ status: 402, code: "trial_ended", message: "Your free trial has ended.", resetsAt: undefined }]);

    reply = {
      status: 429,
      type: "application/json",
      body: JSON.stringify({ error: { code: "budget_exhausted", message: "x", resets_at: "2026-11-01T00:00:00Z" } }),
    };
    await post("/zen/v1/chat/completions", { authorization: "Bearer nonce" });
    expect(blocked[1]).toMatchObject({ status: 429, code: "budget_exhausted", resetsAt: "2026-11-01T00:00:00Z" });
  });

  it("answers signed_out without contacting the backend when there is no token", async () => {
    upstream = { ...upstream, credential: () => null };
    const res = await post("/zen/v1/chat/completions", { authorization: "Bearer nonce" });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(blocked[0]?.code).toBe("signed_out");
  });

  it("only serves /zen/v1", async () => {
    const res = await post("/admin", { authorization: "Bearer nonce" });
    expect(res.status).toBe(404);
  });
});
