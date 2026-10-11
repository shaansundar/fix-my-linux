import type { TaskRow } from "@/components/bui/TaskRows";
import type { ToolStep } from "@/components/bui/ToolChips";
import type { Todo, ToolItem } from "../../shared/session";

/** What a non-technical person should read for each tool call. */
const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  bash: { label: "Ran", icon: "run" },
  read: { label: "Read", icon: "read" },
  glob: { label: "Looked for", icon: "read" },
  grep: { label: "Searched", icon: "read" },
  list: { label: "Listed", icon: "read" },
  edit: { label: "Edited", icon: "write" },
  write: { label: "Wrote", icon: "write" },
  apply_patch: { label: "Edited", icon: "write" },
  webfetch: { label: "Looked up", icon: "read" },
};

const HIDDEN_TOOLS = new Set(["todowrite", "question", "invalid"]);

export function visibleTools(items: ToolItem[]): ToolItem[] {
  return items.filter((t) => !HIDDEN_TOOLS.has(t.tool));
}

export function toolStep(t: ToolItem): ToolStep {
  const meta = TOOL_LABELS[t.tool] ?? { label: t.tool, icon: "run" };
  const status = t.status === "error" ? "failed" : t.status === "completed" ? "done" : "running";
  const lines = (t.status === "error" ? t.error ?? "" : t.output).split("\n").filter((l) => l.trim());
  const detail = lines.slice(-6).map((text) => ({ text }));
  if (t.status === "completed" && t.exitCode !== null && t.exitCode !== 0) {
    detail.push({ text: `Finished with error code ${t.exitCode}` });
  }
  return {
    id: t.id,
    status: status === "done" && t.exitCode !== null && t.exitCode !== 0 ? "failed" : status,
    icon: meta.icon,
    label: status === "running" ? (t.tool === "bash" ? "Running" : "Working") : meta.label,
    chip: t.subject || t.title || t.tool,
    mono: t.tool === "bash" || !!t.subject,
    detailMono: true,
    detail: detail.length ? detail : [{ text: t.status === "running" || t.status === "pending" ? "Working…" : "No output" }],
  };
}

export function toolsHeader(tools: ToolItem[]): string {
  const running = tools.some((t) => t.status === "running" || t.status === "pending");
  const commands = tools.filter((t) => t.tool === "bash").length;
  const others = tools.length - commands;
  const parts: string[] = [];
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (others) parts.push(`${others} step${others === 1 ? "" : "s"}`);
  return `${running ? "Running" : "Ran"} ${parts.join(" and ")}`;
}

export function taskRows(todos: Todo[]): TaskRow[] {
  return todos.map((t, i) => ({
    key: `${i}-${t.content}`,
    label: t.content,
    amount: "",
    status:
      t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : t.status === "cancelled" ? "failed" : "pending",
    step: i + 1,
    details: [],
  }));
}
