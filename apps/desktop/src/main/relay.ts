import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * Loopback relay between opencode and the model backend. opencode only knows
 * this URL and a per-launch nonce; the relay checks the nonce, swaps in the
 * real credential (the device token, or a Zen key in development) and streams
 * the response back unbuffered. The long-lived token never enters opencode's
 * process or environment.
 */

const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"] as const;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export type Upstream = {
  /** e.g. https://api.fixmylinux.dev/zen/v1 or https://opencode.ai/zen/v1 */
  baseURL: string;
  /** Returns null when signed out. */
  credential: () => string | null;
  /**
   * "bearer": always send Authorization: Bearer (our backend picks the right
   * header for Zen). "preserve": put the credential in whichever header
   * opencode used (talking to Zen directly in development).
   */
  style: "bearer" | "preserve";
};

export type BlockedReason = {
  status: number;
  /** Backend error code, e.g. "trial_ended", "budget_exhausted", "signed_out". */
  code: string;
  message: string;
  resetsAt?: string;
};

export type RelayEvents = { blocked: [BlockedReason]; error: [Error] };

export class ModelRelay extends EventEmitter<RelayEvents> {
  private server: Server | null = null;
  private origin = "";

  constructor(
    private readonly nonce: string,
    private readonly upstream: () => Upstream,
  ) {
    super();
  }

  get url(): string {
    return this.origin;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorized(req: IncomingMessage, url: URL): { header: (typeof AUTH_HEADERS)[number] | "query"; ok: boolean } {
    for (const name of AUTH_HEADERS) {
      const raw = req.headers[name];
      if (typeof raw !== "string") continue;
      const value = name === "authorization" ? raw.replace(/^Bearer\s+/i, "") : raw;
      return { header: name, ok: safeEqual(value, this.nonce) };
    }
    const key = url.searchParams.get("key");
    if (key !== null) return { header: "query", ok: safeEqual(key, this.nonce) };
    return { header: "authorization", ok: false };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (!url.pathname.startsWith("/zen/v1/")) return json(res, 404, { error: "not_found" });

    const auth = this.authorized(req, url);
    if (!auth.ok) return json(res, 401, { error: "bad_nonce" });

    const upstream = this.upstream();
    const credential = upstream.credential();
    if (!credential) {
      const reason = { status: 401, code: "signed_out", message: "Sign in to continue." };
      this.emit("blocked", reason);
      return json(res, 401, { error: { code: reason.code, message: reason.message } });
    }

    url.searchParams.delete("key");
    const target = new URL(upstream.baseURL.replace(/\/$/, "") + url.pathname.slice("/zen/v1".length) + url.search);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || (AUTH_HEADERS as readonly string[]).includes(k)) continue;
      headers[k] = v;
    }
    if (upstream.style === "bearer" || auth.header === "authorization" || auth.header === "query") {
      headers["authorization"] = `Bearer ${credential}`;
    } else {
      headers[auth.header] = credential;
    }

    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const out = send(target, { method: req.method, headers }, (up) => {
      const status = up.statusCode ?? 502;
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) outHeaders[k] = v;
      }
      if (status === 402 || status === 429 || status === 401) {
        void this.inspectBlocked(status, up, res, outHeaders);
        return;
      }
      res.writeHead(status, outHeaders);
      up.pipe(res);
    });
    out.on("error", (err) => {
      this.emit("error", err);
      if (!res.headersSent) json(res, 502, { error: "upstream_unreachable" });
      else res.destroy();
    });
    // If opencode gives up (user pressed stop), stop the upstream request too.
    // The backend keeps draining Zen on its side, so billing stays accurate.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
    });
    req.pipe(out);
  }

  /** Error bodies are small; read them so the UI can show a paywall or budget card. */
  private async inspectBlocked(
    status: number,
    up: IncomingMessage,
    res: ServerResponse,
    headers: Record<string, string | string[]>,
  ): Promise<void> {
    let body = "";
    up.setEncoding("utf8");
    for await (const chunk of up) {
      body += chunk as string;
      if (body.length > 64 * 1024) break;
    }
    let code = status === 402 ? "payment_required" : status === 429 ? "rate_limited" : "unauthorized";
    let message = "";
    let resetsAt: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string; resets_at?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? "";
      resetsAt = parsed.error?.resets_at;
    } catch {
      // not JSON; keep the defaults
    }
    this.emit("blocked", { status, code, message, resetsAt });
    delete headers["content-length"];
    res.writeHead(status, headers);
    res.end(body);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
