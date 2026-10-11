import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyState,
  explanationFor,
  hydrate,
  emptySession,
  reduce,
  type AssistantMessage,
  type ChatState,
  type OpencodeEvent,
  type ToolItem,
} from "../../src/shared/session";

function fixture(name: string): { sessionID: string; events: OpencodeEvent[] } {
  return JSON.parse(readFileSync(join(__dirname, "../fixtures", `${name}.json`), "utf8"));
}

function replay(events: OpencodeEvent[], upTo = events.length): ChatState {
  return events.slice(0, upTo).reduce(reduce, emptyState);
}

function tools(state: ChatState, sessionID: string): ToolItem[] {
  return state.sessions[sessionID]!.messages.flatMap((m) =>
    m.role === "assistant" ? m.items.filter((i): i is ToolItem => i.kind === "tool") : [],
  );
}

describe("reduce (recorded opencode streams)", () => {
  it("builds the basic conversation: user text, plan, reasoning, command and answer", () => {
    const { sessionID, events } = fixture("basic");
    const s = replay(events).sessions[sessionID]!;

    expect(s.messages[0]).toMatchObject({ role: "user", text: "my disk is full" });
    const assistant = s.messages.filter((m): m is AssistantMessage => m.role === "assistant");
    expect(assistant.length).toBeGreaterThanOrEqual(3);
    expect(assistant.every((m) => m.done)).toBe(true);

    const reasoning = assistant.flatMap((m) => m.items).find((i) => i.kind === "reasoning");
    expect(reasoning).toMatchObject({ text: "Need df output first.", done: true });

    const df = tools(replay(events), sessionID).find((t) => t.tool === "bash")!;
    expect(df).toMatchObject({ status: "completed", subject: "df -h", exitCode: 0 });
    expect(df.output).toContain("Filesystem");
    expect(df.explanation).toBe("I'll check how much space is left on your disk.");

    const last = assistant.at(-1)!.items.find((i) => i.kind === "text");
    expect(last).toMatchObject({ text: "Your disk is 93% full. The biggest folder is your Downloads." });

    expect(s.todos.map((t) => t.content)).toEqual(["Check disk space", "Clear old caches"]);
    expect(s.status).toBe("idle");
  });

  it("streams text through deltas before the final part arrives", () => {
    const { sessionID, events } = fixture("basic");
    const firstDelta = events.findIndex((e) => e.type === "message.part.delta");
    const s = replay(events, firstDelta + 1).sessions[sessionID]!;
    const text = s.messages
      .flatMap((m) => (m.role === "assistant" ? m.items : []))
      .find((i) => i.kind === "text");
    expect(text?.kind === "text" && text.text.length).toBeGreaterThan(0);
    expect(s.status).toBe("busy");
  });

  it("shows live command output while running", () => {
    const { sessionID, events } = fixture("basic");
    const running = events.findIndex((e) => {
      const part = (e.properties?.["part"] ?? {}) as { tool?: string; state?: { status?: string; metadata?: { output?: string } } };
      return part.tool === "bash" && part.state?.status === "running" && !!part.state.metadata?.output;
    });
    const df = tools(replay(events, running + 1), sessionID).find((t) => t.tool === "bash")!;
    expect(df.status).toBe("running");
    expect(df.output).toContain("Filesystem");
  });

  it("finds the explanation for an approval from the tool's message", () => {
    const { sessionID, events } = fixture("approval");
    const askedAt = events.findIndex((e) => e.type === "permission.asked");
    const asked = events[askedAt]!.properties as { tool: { messageID: string; callID: string } };
    const state = replay(events, askedAt);
    expect(explanationFor(state, sessionID, asked.tool.messageID, asked.tool.callID)).toBe(
      "I'll install VLC so you can play that video.",
    );
  });

  it("tracks pending questions until they are answered", () => {
    const { sessionID, events } = fixture("question");
    const askedAt = events.findIndex((e) => e.type === "question.asked");
    const mid = replay(events, askedAt + 1).sessions[sessionID]!;
    expect(mid.questions).toHaveLength(1);
    expect(mid.questions[0]!.questions[0]!.options.map((o) => o.label)).toEqual(["VLC", "Celluloid"]);
    expect(replay(events).sessions[sessionID]!.questions).toEqual([]);
  });

  it("marks a rejected command as an error", () => {
    const { sessionID, events } = fixture("rejected");
    const t = tools(replay(events), sessionID).find((x) => x.tool === "bash")!;
    expect(t.status).toBe("error");
    expect(t.error).toMatch(/rejected/);
  });

  it("returns the same state object for irrelevant events", () => {
    const state = replay(fixture("basic").events);
    expect(reduce(state, { type: "server.heartbeat", properties: {} })).toBe(state);
    expect(reduce(state, { type: "message.part.delta", properties: { sessionID: "nope", delta: "x", field: "text" } })).toBe(state);
  });

  it("ignores child sessions", () => {
    const state = reduce(emptyState, { type: "session.created", properties: { info: { id: "child", parentID: "p", title: "x" } } });
    expect(state.sessions["child"]).toBeUndefined();
  });

  it("maps errors to plain text", () => {
    const state = reduce(emptyState, {
      type: "session.error",
      properties: { sessionID: "s", error: { name: "ApiError", data: { message: "Upstream is down" } } },
    });
    expect(state.sessions["s"]!.error).toBe("Upstream is down");
  });
});

describe("hydrate", () => {
  it("rebuilds a session from message history", () => {
    const view = hydrate(emptySession("s1", "Disk"), [
      {
        info: { id: "u1", sessionID: "s1", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", messageID: "u1", sessionID: "s1", type: "text", text: "hello" }],
      },
      {
        info: { id: "a1", sessionID: "s1", role: "assistant", time: { created: 2, completed: 3 } },
        parts: [
          { id: "p2", messageID: "a1", sessionID: "s1", type: "text", text: "Checking." },
          {
            id: "p3",
            messageID: "a1",
            sessionID: "s1",
            type: "tool",
            tool: "bash",
            callID: "c1",
            state: { status: "completed", input: { command: "df -h" }, output: "ok", metadata: { exit: 0 }, title: "df -h", time: { start: 1, end: 2 } },
          },
        ],
      },
    ]);
    expect(view.title).toBe("Disk");
    expect(view.messages).toHaveLength(2);
    const t = (view.messages[1] as AssistantMessage).items[1] as ToolItem;
    expect(t).toMatchObject({ subject: "df -h", explanation: "Checking.", exitCode: 0, output: "ok" });
  });
});
