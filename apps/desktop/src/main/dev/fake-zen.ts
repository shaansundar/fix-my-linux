/**
 * A scripted stand-in for OpenCode Zen's /chat/completions endpoint, so the
 * real opencode binary can be driven deterministically in tests. Each model
 * request pops the next scripted turn; title-generation requests are answered
 * separately so they never consume the script.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ToolCall = { name: string; args: Record<string, unknown> };
export type Turn = { text?: string; reasoning?: string; tools?: ToolCall[] };
export type Script = Turn | ((body: ChatRequest) => Turn);

export type ChatMessage = { role: string; content?: unknown; tool_call_id?: string };
export type ChatRequest = { model: string; stream?: boolean; messages: ChatMessage[] };

export type RecordedRequest = { path: string; headers: IncomingMessage["headers"]; body: ChatRequest };

export class FakeZen {
  readonly requests: RecordedRequest[] = [];
  private queue: Script[] = [];
  private fallback: ((body: ChatRequest) => Turn) | null = null;
  private server: Server | null = null;
  private seq = 0;
  /** Status to return instead of a completion, e.g. 402 to simulate a paywall. */
  failWith: { status: number; body: unknown } | null = null;

  script(...turns: Script[]): this {
    this.queue.push(...turns);
    return this;
  }

  /** Answers every request the script doesn't cover (demo mode). */
  respondWith(fn: (body: ChatRequest) => Turn): this {
    this.fallback = fn;
    return this;
  }

  /** Drops any unconsumed turns, e.g. after a rejected approval ended a session early. */
  clear(): this {
    this.queue = [];
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (raw += c));
      req.on("end", () => {
        const body = (raw ? JSON.parse(raw) : {}) as ChatRequest;
        this.requests.push({ path: req.url ?? "", headers: req.headers, body });
        if (this.failWith) {
          res.writeHead(this.failWith.status, { "content-type": "application/json" });
          res.end(JSON.stringify(this.failWith.body));
          return;
        }
        if (!req.url?.endsWith("/chat/completions")) {
          res.writeHead(404).end();
          return;
        }
        const turn = isTitleRequest(body) ? { text: "Fix my computer" } : this.next(body);
        if (body.stream) this.stream(res, body.model, turn);
        else this.json(res, body.model, turn);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const { port: bound } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${bound}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private next(body: ChatRequest): Turn {
    const script = this.queue.shift();
    if (!script) return this.fallback ? this.fallback(body) : { text: "All done." };
    return typeof script === "function" ? script(body) : script;
  }

  private chunk(model: string, delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
    return {
      id: `chatcmpl-${this.seq}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    };
  }

  private stream(res: import("node:http").ServerResponse, model: string, turn: Turn): void {
    this.seq++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send(this.chunk(model, { role: "assistant", content: "" }));
    if (turn.reasoning) send(this.chunk(model, { reasoning_content: turn.reasoning }));
    if (turn.text) {
      for (const piece of turn.text.match(/.{1,24}/gs) ?? []) send(this.chunk(model, { content: piece }));
    }
    (turn.tools ?? []).forEach((call, index) => {
      send(
        this.chunk(model, {
          tool_calls: [
            {
              index,
              id: `call_${this.seq}_${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }),
      );
    });
    const finish = turn.tools?.length ? "tool_calls" : "stop";
    send(this.chunk(model, {}, finish, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }));
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private json(res: import("node:http").ServerResponse, model: string, turn: Turn): void {
    this.seq++;
    const message: Record<string, unknown> = { role: "assistant", content: turn.text ?? "" };
    if (turn.tools?.length) {
      message["tool_calls"] = turn.tools.map((call, i) => ({
        id: `call_${this.seq}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${this.seq}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: turn.tools?.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }
}

function isTitleRequest(body: ChatRequest): boolean {
  return body.messages?.some(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("You are a title generator"),
  );
}

/** A models.dev-format catalog with one free openai-compatible model for the fake. */
export function fakeCatalog(modelID = "fml-fake", name = "Fake"): Record<string, unknown> {
  return {
    opencode: {
      id: "opencode",
      name: "OpenCode Zen",
      env: ["OPENCODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://opencode.ai/zen/v1",
      models: {
        [modelID]: {
          id: modelID,
          name,
          family: "fake",
          attachment: false,
          reasoning: false,
          tool_call: true,
          temperature: true,
          release_date: "2026-01-01",
          last_updated: "2026-01-01",
          modalities: { input: ["text"], output: ["text"] },
          open_weights: false,
          cost: { input: 0, output: 0 },
          limit: { context: 128000, output: 8192 },
        },
      },
    },
  };
}
