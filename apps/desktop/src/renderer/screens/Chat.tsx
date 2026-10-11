import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import ApprovalCard, { type ApprovalQuestion } from "@/components/bui/ApprovalCard";
import LoadingState from "@/components/bui/LoadingState";
import PromptBar, { type PromptCommand, type PromptModel, type PromptSource } from "@/components/bui/PromptBar";
import StreamingText, { tokenize } from "@/components/bui/StreamingText";
import TaskRows from "@/components/bui/TaskRows";
import ThinkingState from "@/components/bui/ThinkingState";
import ToolChips from "@/components/bui/ToolChips";
import { CommandApproval } from "@/components/fml/CommandApproval";
import { taskRows, toolStep, toolsHeader, visibleTools } from "@/lib/view";
import { store, useApp } from "@/state/store";
import type { Item, Message, PendingQuestion, ReasoningItem, SessionView, TextItem, ToolItem } from "../../shared/session";

/** Quick fixes in the / menu: each fills in a plain-language request. */
export const QUICK_FIXES: PromptCommand[] = [
  { key: "disk", name: "/disk-space", desc: "My disk is full", prompt: "My disk is almost full. Can you find what's taking up space and clear what's safe to remove?" },
  { key: "wifi", name: "/wifi", desc: "Wi-Fi isn't working", prompt: "My Wi-Fi isn't working properly. Can you find out why and fix it?" },
  { key: "sound", name: "/sound", desc: "No sound", prompt: "I can't hear any sound from my computer. Can you fix it?" },
  { key: "updates", name: "/updates", desc: "Install updates", prompt: "Please check for system updates and install them." },
  { key: "slow", name: "/slow", desc: "Computer feels slow", prompt: "My computer feels slow. Can you find out why and make it faster?" },
  { key: "install", name: "/install", desc: "Install an app", prompt: "I'd like to install an app: " },
  { key: "printer", name: "/printer", desc: "Printer problems", prompt: "My printer isn't working. Can you help me get it printing?" },
];

/** Context the person can attach with @. */
const SOURCES: PromptSource[] = [
  { key: "system", name: "System info", desc: "Distribution, desktop and hardware", glyph: "layers" },
  { key: "errors", name: "Recent errors", desc: "Problems logged since you started the computer", glyph: "chart" },
];

const SUGGESTIONS = [
  "My disk is almost full",
  "Wi-Fi keeps dropping",
  "There's no sound",
  "Install a video player",
];

type Block =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; item: TextItem; settled: boolean }
  | { kind: "reasoning"; id: string; item: ReasoningItem }
  | { kind: "tools"; id: string; tools: ToolItem[] }
  | { kind: "error"; id: string; text: string };

/** Flattens messages into display blocks, grouping consecutive tool calls. */
function blocks(messages: Message[]): Block[] {
  const out: Block[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ kind: "user", id: m.id, text: m.text });
      continue;
    }
    for (const item of m.items as Item[]) {
      if (item.kind === "text") {
        if (item.text.trim()) out.push({ kind: "text", id: item.id, item, settled: m.done });
      } else if (item.kind === "reasoning") {
        if (item.text.trim()) out.push({ kind: "reasoning", id: item.id, item });
      } else {
        const tools = visibleTools([item]);
        if (!tools.length) continue;
        const last = out.at(-1);
        if (last?.kind === "tools") last.tools.push(...tools);
        else out.push({ kind: "tools", id: item.id, tools });
      }
    }
    if (m.error && m.error !== "Stopped.") out.push({ kind: "error", id: `${m.id}-err`, text: m.error });
  }
  return out;
}

function AgentText({ item, settled, actions }: { item: TextItem; settled: boolean; actions: boolean }) {
  // Text that was already complete when it first appeared (history) renders at once.
  const instant = useRef(settled).current;
  const tokens = useMemo(() => tokenize(item.text), [item.text]);
  return (
    <StreamingText
      content={tokens}
      instant={instant}
      loop={false}
      fill
      sources={[]}
      followUps={[]}
      showActions={actions}
      onAction={(a) => {
        if (a === "copy") void navigator.clipboard.writeText(item.text);
      }}
    />
  );
}

function Reasoning({ item }: { item: ReasoningItem }) {
  const rows = item.text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((primary) => ({ primary }));
  return <ThinkingState variant="Reasoning" rows={rows} working={!item.done} active="Thinking" done="Thought it through" />;
}

function Question({ q }: { q: PendingQuestion }) {
  const { answer, dismissQuestion } = store().actions;
  const questions: ApprovalQuestion[] = q.questions.map((x) => ({
    q: x.question,
    type: x.multiple ? "check" : "radio",
    options: x.options.map((o) => o.label),
    descriptions: x.options.map((o) => o.description),
    noCustom: x.custom === false,
  }));
  return (
    <div data-testid="question-card">
      <ApprovalCard
        questions={questions}
        resettable={false}
        labels={{ sentMessage: "Answer sent" }}
        onSubmitted={(answers, custom) => {
          const out = q.questions.map((x, i) => {
            const text = custom[i]?.trim();
            if (text) return [text];
            return (answers[i] ?? []).map((j) => x.options[j]?.label ?? "").filter(Boolean);
          });
          void answer(q.id, out);
        }}
        onDismiss={() => void dismissQuestion(q.id)}
      />
    </div>
  );
}

function Transcript({ session }: { session: SessionView }) {
  const approvals = useApp((s) => s.approvals);
  const mine = approvals.filter((a) => a.sessionID === session.id);
  const list = blocks(session.messages);
  const lastBlock = list.at(-1);
  const busy = session.status !== "idle";
  const waiting = busy && mine.length === 0 && session.questions.length === 0 && lastBlock?.kind !== "text";
  // Copy and feedback actions belong to the final answer, not every sentence.
  const finalTextID = !busy && lastBlock?.kind === "text" ? lastBlock.id : null;
  const decide = store().actions.decide;

  return (
    <div className="flex flex-col gap-4">
      {list.map((b) => {
        switch (b.kind) {
          case "user":
            return (
              <div key={b.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-[18px] bg-hover-2 px-3.5 py-2 text-[13.5px] leading-relaxed text-ink">
                  {b.text}
                </div>
              </div>
            );
          case "text":
            return <AgentText key={b.id} item={b.item} settled={b.settled} actions={b.id === finalTextID} />;
          case "reasoning":
            return <Reasoning key={b.id} item={b.item} />;
          case "tools":
            return (
              <ToolChips
                key={b.id}
                live
                defaultOpen
                steps={b.tools.map(toolStep)}
                diffs={[]}
                labels={{ header: toolsHeader(b.tools), more: "" }}
              />
            );
          case "error":
            return (
              <div key={b.id} className="rounded-card bg-red-tint px-3 py-2 text-[13px] text-red">
                {b.text}
              </div>
            );
        }
      })}
      {session.retryMessage && (
        <div className="text-[12.5px] text-ink-3">Having trouble reaching the assistant, retrying… ({session.retryMessage})</div>
      )}
      {waiting && (
        <div className="py-1">
          <LoadingState variant="Dots" label="Working on it" />
        </div>
      )}
      {mine.map((a) => (
        <CommandApproval key={a.id} approval={a} onDecide={(d) => void decide(a.id, d)} />
      ))}
      {session.questions.map((q) => (
        <Question key={q.id} q={q} />
      ))}
      {session.error && !busy && (
        <div className="flex items-center justify-between gap-3 rounded-card bg-red-tint px-3 py-2 text-[13px] text-red">
          <span>{session.error}</span>
        </div>
      )}
    </div>
  );
}

function Composer({ busy, tall, onSend }: { busy: boolean; tall?: boolean; onSend: (text: string) => void }) {
  const models = useApp((s) => s.models);
  const model = useApp((s) => s.model);
  const engine = useApp((s) => s.engine);
  const { setModel, stop } = store().actions;
  const pickerModels: PromptModel[] = models.map((m) => ({
    key: m.id,
    name: m.name,
    tag: m.recommended ? "Recommended" : m.free ? "Free" : "",
  }));
  return (
    <PromptBar
      demo={false}
      tall={tall}
      autoFocus
      placeholder="Describe what's wrong, in your own words…"
      sources={SOURCES}
      commands={QUICK_FIXES}
      models={pickerModels.length ? pickerModels : [{ key: "none", name: "Assistant", tag: "" }]}
      model={model ?? undefined}
      onModelChange={setModel}
      celebrateModel=""
      dictation={false}
      busy={busy}
      onStop={() => void stop()}
      disabled={engine.state !== "ready"}
      onSend={(text, ctx) => {
        const extras: string[] = [];
        if (ctx.sources.includes("system")) extras.push("(Please start by checking my system information.)");
        if (ctx.sources.includes("errors")) extras.push("(Please look at the errors logged since this boot.)");
        onSend([text, ...extras].join("\n\n"));
      }}
    />
  );
}

function EmptyChat() {
  const { send } = store().actions;
  return (
    <div className="mx-auto flex h-full w-full max-w-[640px] flex-col justify-center gap-6 px-6 pb-16">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">What's going on with your computer?</h1>
        <p className="text-[14px] text-ink-2">
          Describe the problem in your own words. I'll figure out what's wrong and fix it, and I'll ask before changing anything.
        </p>
      </div>
      <Composer busy={false} tall onSend={(t) => void send(t)} />
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <Button key={s} variant="secondary" size="xs" onClick={() => void send(s)}>
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function Chat() {
  const view = useApp((s) => s.view);
  const sessions = useApp((s) => s.chat.sessions);
  const sending = useApp((s) => s.sending);
  const error = useApp((s) => s.error);
  const { send, dismissError } = store().actions;
  const sessionID = view.kind === "chat" ? view.sessionID : null;
  const session = sessionID ? sessions[sessionID] : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  // Follow new content unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => setStick(true), [sessionID]);

  if (!sessionID || !session) {
    return (
      <div className="relative h-full">
        <EmptyChat />
        {error && <ErrorBar text={error} onClose={dismissError} />}
      </div>
    );
  }

  const busy = sending || session.status !== "idle";
  const rows = taskRows(session.todos);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[720px] px-6 pt-8 pb-6">
          <Transcript session={session} />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-6 pb-5">
        {rows.length > 0 && <TaskRows variant="List" rows={rows} labels={{ completed: "Done", failed: "Skipped" }} />}
        {error && <ErrorBar text={error} onClose={dismissError} inline />}
        <Composer busy={busy} onSend={(t) => void send(t)} />
      </div>
    </div>
  );
}

function ErrorBar({ text, onClose, inline = false }: { text: string; onClose: () => void; inline?: boolean }) {
  return (
    <div
      role="alert"
      className={`${inline ? "" : "absolute inset-x-6 bottom-6 mx-auto max-w-[640px] "}flex items-center justify-between gap-3 rounded-card bg-red-tint px-3 py-2 text-[13px] text-red shadow-hairline`}
      style={{ animation: "fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <span>{text}</span>
      <Button variant="quiet" size="xs" onClick={onClose}>
        Dismiss
      </Button>
    </div>
  );
}
