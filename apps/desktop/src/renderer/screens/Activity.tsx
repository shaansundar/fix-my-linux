import FilterTable, { type FilterStatus, type TableRow } from "@/components/bui/FilterTable";
import { useApp } from "@/state/store";
import type { AuditEntry } from "../../shared/approvals";

const STATUSES: Record<string, FilterStatus> = {
  "auto-ran": { label: "Ran on its own", cls: "filter-status-progress", dot: "#16a6c7" },
  approved: { label: "You allowed", cls: "filter-status-done", dot: "#25a878" },
  denied: { label: "You declined", cls: "filter-status-todo", dot: "#f09a2f" },
  failed: { label: "Failed", cls: "filter-status-failed", dot: "#e5484d" },
  blocked: { label: "Blocked", cls: "filter-status-failed", dot: "#e5484d" },
};

function statusOf(e: AuditEntry): string {
  if (e.decision === "blocked") return "blocked";
  if (e.decision === "denied") return "denied";
  if (e.outcome === "failed") return "failed";
  return e.decision === "auto-ran" ? "auto-ran" : "approved";
}

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function result(e: AuditEntry): string {
  if (e.decision === "denied" || e.decision === "blocked") return "Not run";
  if (e.outcome === "succeeded") return "Worked";
  if (e.outcome === "failed") return e.exitCode !== undefined ? `Didn't work (code ${e.exitCode})` : "Didn't work";
  return "Running…";
}

export function Activity() {
  const activity = useApp((s) => s.activity);
  const rows: TableRow[] = activity.map((e) => ({
    id: e.id,
    task: e.subject || e.kind,
    mono: e.kind === "command",
    date: when(e.ts),
    status: statusOf(e),
    owner: result(e),
  }));
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Activity</h1>
          <p className="text-[13.5px] text-ink-2">
            Everything the assistant did on your computer: what ran on its own, what you allowed or declined, and how it went.
          </p>
        </div>
        <FilterTable
          fill
          rows={rows}
          statuses={STATUSES}
          empty="Nothing yet. When the assistant runs something, it shows up here."
          labels={{ columns: { task: "What it did", date: "When", status: "Decision", owner: "Result" } }}
        />
      </div>
    </div>
  );
}
