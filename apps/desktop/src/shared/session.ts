/**
 * Turns opencode's event stream into the chat view model. Pure and shared:
 * the main process uses it to find the agent's explanation for an approval,
 * the renderer uses it to draw the chat.
 */

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type TextItem = { kind: "text"; id: string; text: string };
export type ReasoningItem = { kind: "reasoning"; id: string; text: string; done: boolean };
export type ToolItem = {
  kind: "tool";
  id: string;
  callID: string;
  tool: string;
  status: ToolStatus;
  /** For bash: the command. For edits: the file. */
  subject: string;
  title: string;
  output: string;
  exitCode: number | null;
  error: string | null;
  /** The agent's sentence right before this call. */
  explanation: string | null;
  input: Record<string, unknown>;
  startedAt: number | null;
  endedAt: number | null;
};
export type Item = TextItem | ReasoningItem | ToolItem;

export type UserMessage = { role: "user"; id: string; text: string; createdAt: number };
export type AssistantMessage = {
  role: "assistant";
  id: string;
  items: Item[];
  done: boolean;
  error: string | null;
  createdAt: number;
};
export type Message = UserMessage | AssistantMessage;

export type Todo = { content: string; status: string; priority: string };

export type QuestionOption = { label: string; description: string };
export type Question = { question: string; header: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean };
export type PendingQuestion = { id: string; sessionID: string; questions: Question[] };

export type SessionStatus = "idle" | "busy" | "retry";

export type SessionView = {
  id: string;
  title: string;
  messages: Message[];
  todos: Todo[];
  status: SessionStatus;
  retryMessage: string | null;
  questions: PendingQuestion[];
  error: string | null;
  updatedAt: number;
};

export type ChatState = { sessions: Record<string, SessionView> };

export const emptyState: ChatState = { sessions: {} };

/** A loosely typed opencode event; the reducer validates what it reads. */
export type OpencodeEvent = { type: string; properties?: Record<string, unknown> };

export function emptySession(id: string, title = ""): SessionView {
  return { id, title, messages: [], todos: [], status: "idle", retryMessage: null, questions: [], error: null, updatedAt: 0 };
}

type Obj = Record<string, unknown>;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function errorText(err: unknown): string | null {
  if (!err) return null;
  const e = obj(err);
  const data = obj(e["data"]);
  const message = str(data["message"]) || str(e["message"]) || str(e["name"]);
  if (str(e["name"]) === "MessageAbortedError") return "Stopped.";
  return message || "Something went wrong.";
}

function withSession(state: ChatState, id: string, fn: (s: SessionView) => SessionView): ChatState {
  const current = state.sessions[id] ?? emptySession(id);
  const next = fn(current);
  if (next === current) return state;
  return { sessions: { ...state.sessions, [id]: next } };
}

function upsertMessage(s: SessionView, id: string, make: () => Message, fn: (m: Message) => Message): SessionView {
  const i = s.messages.findIndex((m) => m.id === id);
  const messages = [...s.messages];
  if (i < 0) messages.push(fn(make()));
  else messages[i] = fn(messages[i]!);
  return { ...s, messages };
}

function lastTextBefore(items: Item[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "text" && it.text.trim()) return it.text.trim();
    if (it.kind === "tool") return null;
  }
  return null;
}

function subjectOf(tool: string, input: Obj): string {
  if (tool === "bash") return str(input["command"]);
  if (["edit", "write", "read", "apply_patch"].includes(tool)) return str(input["filePath"]) || str(input["filepath"]) || str(input["path"]);
  if (tool === "webfetch") return str(input["url"]);
  if (tool === "glob" || tool === "grep") return str(input["pattern"]);
  return "";
}

function applyPart(s: SessionView, part: Obj): SessionView {
  const messageID = str(part["messageID"]);
  const partID = str(part["id"]);
  const type = str(part["type"]);
  if (!messageID || !partID) return s;

  const isUser = s.messages.find((m) => m.id === messageID)?.role === "user";
  if (isUser) {
    if (type !== "text" || part["synthetic"]) return s;
    return upsertMessage(
      s,
      messageID,
      () => ({ role: "user", id: messageID, text: "", createdAt: 0 }),
      (m) => (m.role === "user" ? { ...m, text: str(part["text"]) } : m),
    );
  }

  let item: Item | null = null;
  if (type === "text") {
    if (part["synthetic"] || part["ignored"]) return s;
    item = { kind: "text", id: partID, text: str(part["text"]) };
  } else if (type === "reasoning") {
    item = { kind: "reasoning", id: partID, text: str(part["text"]), done: num(obj(part["time"])["end"]) !== null };
  } else if (type === "tool") {
    const state = obj(part["state"]);
    const input = obj(state["input"]);
    const meta = obj(state["metadata"]);
    const tool = str(part["tool"]);
    const status = str(state["status"], "pending") as ToolStatus;
    const time = obj(state["time"]);
    item = {
      kind: "tool",
      id: partID,
      callID: str(part["callID"]),
      tool,
      status,
      subject: subjectOf(tool, input),
      title: str(state["title"]),
      output: status === "completed" ? str(state["output"]) || str(meta["output"]) : str(meta["output"]),
      exitCode: num(meta["exit"]),
      error: status === "error" ? str(state["error"]) : null,
      explanation: null,
      input,
      startedAt: num(time["start"]),
      endedAt: num(time["end"]),
    };
  } else {
    return s;
  }

  return upsertMessage(
    s,
    messageID,
    () => ({ role: "assistant", id: messageID, items: [], done: false, error: null, createdAt: 0 }),
    (m) => {
      if (m.role !== "assistant") return m;
      const items = [...m.items];
      const i = items.findIndex((x) => x.id === partID);
      if (i < 0) items.push(item!);
      else items[i] = item!.kind === "tool" ? { ...item!, explanation: (items[i] as ToolItem).explanation } : item!;
      const at = i < 0 ? items.length - 1 : i;
      const placed = items[at]!;
      if (placed.kind === "tool" && placed.explanation === null) {
        items[at] = { ...placed, explanation: lastTextBefore(items, at) };
      }
      return { ...m, items };
    },
  );
}

function applyDelta(s: SessionView, p: Obj): SessionView {
  const messageID = str(p["messageID"]);
  const partID = str(p["partID"]);
  const delta = str(p["delta"]);
  if (str(p["field"]) !== "text" || !delta) return s;
  const msg = s.messages.find((m) => m.id === messageID);
  if (!msg || msg.role !== "assistant") return s;
  const i = msg.items.findIndex((x) => x.id === partID);
  if (i < 0) return s;
  const item = msg.items[i]!;
  if (item.kind !== "text" && item.kind !== "reasoning") return s;
  const items = [...msg.items];
  items[i] = { ...item, text: item.text + delta };
  return { ...s, messages: s.messages.map((m) => (m.id === messageID ? { ...msg, items } : m)) };
}

export function reduce(state: ChatState, event: OpencodeEvent): ChatState {
  const p = event.properties ?? {};
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = obj(p["info"]);
      const id = str(info["id"]) || str(p["sessionID"]);
      if (!id || info["parentID"]) return state;
      const updated = num(obj(info["time"])["updated"]) ?? 0;
      return withSession(state, id, (s) =>
        s.title === str(info["title"]) && s.updatedAt === updated ? s : { ...s, title: str(info["title"], s.title), updatedAt: updated },
      );
    }
    case "session.deleted": {
      const id = str(obj(p["info"])["id"]) || str(p["sessionID"]);
      if (!state.sessions[id]) return state;
      const { [id]: _gone, ...rest } = state.sessions;
      return { sessions: rest };
    }
    case "message.updated": {
      const info = obj(p["info"]);
      const sessionID = str(p["sessionID"]) || str(info["sessionID"]);
      const id = str(info["id"]);
      if (!sessionID || !id) return state;
      const created = num(obj(info["time"])["created"]) ?? 0;
      if (info["role"] === "user") {
        return withSession(state, sessionID, (s) =>
          upsertMessage(s, id, () => ({ role: "user", id, text: "", createdAt: created }), (m) => ({ ...m, createdAt: created })),
        );
      }
      const done = num(obj(info["time"])["completed"]) !== null || !!info["error"];
      const error = errorText(info["error"]);
      return withSession(state, sessionID, (s) =>
        upsertMessage(
          s,
          id,
          () => ({ role: "assistant", id, items: [], done: false, error: null, createdAt: created }),
          (m) => (m.role === "assistant" ? { ...m, done, error, createdAt: created } : m),
        ),
      );
    }
    case "message.part.updated": {
      const part = obj(p["part"]);
      const sessionID = str(p["sessionID"]) || str(part["sessionID"]);
      if (!sessionID) return state;
      return withSession(state, sessionID, (s) => applyPart(s, part));
    }
    case "message.part.delta": {
      const sessionID = str(p["sessionID"]);
      if (!sessionID || !state.sessions[sessionID]) return state;
      return withSession(state, sessionID, (s) => applyDelta(s, p));
    }
    case "message.part.removed": {
      const sessionID = str(p["sessionID"]);
      const partID = str(p["partID"]);
      if (!state.sessions[sessionID]) return state;
      return withSession(state, sessionID, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.role === "assistant" ? { ...m, items: m.items.filter((x) => x.id !== partID) } : m)),
      }));
    }
    case "todo.updated": {
      const sessionID = str(p["sessionID"]);
      const todos = Array.isArray(p["todos"]) ? (p["todos"] as Todo[]) : [];
      return withSession(state, sessionID, (s) => ({ ...s, todos }));
    }
    case "session.status": {
      const sessionID = str(p["sessionID"]);
      const status = obj(p["status"]);
      const type = str(status["type"], "idle") as SessionStatus;
      return withSession(state, sessionID, (s) =>
        s.status === type && type !== "retry"
          ? s
          : { ...s, status: type, retryMessage: type === "retry" ? str(status["message"]) : null, error: type === "busy" ? null : s.error },
      );
    }
    case "session.error": {
      const sessionID = str(p["sessionID"]);
      if (!sessionID) return state;
      return withSession(state, sessionID, (s) => ({ ...s, error: errorText(p["error"]) }));
    }
    case "question.asked": {
      const sessionID = str(p["sessionID"]);
      const q: PendingQuestion = { id: str(p["id"]), sessionID, questions: (p["questions"] as Question[]) ?? [] };
      return withSession(state, sessionID, (s) => ({ ...s, questions: [...s.questions.filter((x) => x.id !== q.id), q] }));
    }
    case "question.replied":
    case "question.rejected": {
      const sessionID = str(p["sessionID"]);
      const requestID = str(p["requestID"]);
      if (!state.sessions[sessionID]) return state;
      return withSession(state, sessionID, (s) => ({ ...s, questions: s.questions.filter((x) => x.id !== requestID) }));
    }
    default:
      return state;
  }
}

/** The agent's explanation for a tool call, for the approval card. */
export function explanationFor(state: ChatState, sessionID: string, messageID: string, callID: string): string | null {
  const msg = state.sessions[sessionID]?.messages.find((m) => m.id === messageID);
  if (!msg || msg.role !== "assistant") return null;
  const i = msg.items.findIndex((x) => x.kind === "tool" && x.callID === callID);
  if (i < 0) {
    // The tool part may not exist yet; use the newest text in the message.
    const texts = msg.items.filter((x): x is TextItem => x.kind === "text" && !!x.text.trim());
    return texts.at(-1)?.text.trim() ?? null;
  }
  return lastTextBefore(msg.items, i);
}

/** Builds a session view from `session.messages()` (history on startup). */
export function hydrate(
  base: SessionView,
  history: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>,
): SessionView {
  let state: ChatState = { sessions: { [base.id]: { ...base, messages: [] } } };
  for (const m of history) {
    state = reduce(state, { type: "message.updated", properties: { sessionID: base.id, info: m.info } });
    for (const part of m.parts) state = reduce(state, { type: "message.part.updated", properties: { sessionID: base.id, part } });
  }
  return state.sessions[base.id]!;
}
