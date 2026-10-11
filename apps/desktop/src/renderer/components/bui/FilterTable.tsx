/**
 * Vendored from Beautiful UI — https://www.beautifului.dev
 * MIT License, Copyright (c) 2026 Shane Levine. See THIRD_PARTY_NOTICES.md.
 */
"use client";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────
 * FILTER TABLE
 * Status chips directly filter the task table.
 * ───────────────────────────────────────────────────────── */

type Status = string;

export type TableRow = { id?: string; task: string; date: string; status: Status; owner: string; mono?: boolean };

/** A status: its pill label, the pill class (see bui.css), and the filter dot color. */
export type FilterStatus = { label: string; cls: string; dot: string };

export type FilterTableLabels = {
  columns: { task: string; date: string; status: string; owner: string };
};


const ROWS: TableRow[] = [
  { task: "Restock mango sorbet", date: "Dec 03", status: "todo", owner: "Mango Moon Gelato" },
  { task: "Churn black sesame", date: "Sep 22", status: "progress", owner: "Kumo Creamery" },
  { task: "Print summer menu", date: "Jan 02", status: "todo", owner: "Coral Coast Sorbet" },
  { task: "Taste-test batch 42", date: "Nov 08", status: "progress", owner: "Maple Orbit" },
  { task: "Order waffle cones", date: "Apr 14", status: "done", owner: "Aurora Scoops" },
];

const LABELS: FilterTableLabels = {
  columns: { task: "Task name", date: "Date", status: "Status", owner: "Advisor" },
};

const PILLS: Record<Status, FilterStatus> = {
  todo: { label: "To do", cls: "filter-status-todo", dot: "#f09a2f" },
  progress: { label: "In Progress", cls: "filter-status-progress", dot: "#16a6c7" },
  done: { label: "Completed", cls: "filter-status-done", dot: "#25a878" },
};

export default function FilterTable({
  rows = ROWS,
  labels = LABELS,
  statuses = PILLS,
  allLabel = "All",
  fill = false,
  empty,
}: {
  rows?: TableRow[];
  labels?: FilterTableLabels;
  /** status key → pill; also the order of the filter chips */
  statuses?: Record<Status, FilterStatus>;
  allLabel?: string;
  /** fill the parent width instead of the gallery's fixed measure */
  fill?: boolean;
  /** shown when there are no rows */
  empty?: string;
  variant?: string;
} = {}) {
  const [filter, setFilter] = useState<"all" | Status>("all");
  const FILTERS: { key: "all" | Status; label: string; dot?: string; count: number }[] = [
    { key: "all", label: allLabel, count: rows.length },
    ...Object.entries(statuses).map(([key, st]) => ({
      key,
      label: st.label,
      dot: st.dot,
      count: rows.filter((r) => r.status === key).length,
    })),
  ];

  return (
    <div className={fill ? "w-full" : "w-full max-w-105"}>
      {/* filter chips */}
      <div
        className="-mx-1 mb-1 flex items-center gap-1 overflow-x-auto px-1 py-1"
        style={{ scrollbarWidth: "none" }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(f.key)}
              className={`flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px]
                font-medium transition-[background-color,box-shadow,color] duration-200
                ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`}
            >
              {f.dot && <span className="size-1.5 rounded-full" style={{ background: f.dot }} />}
              {f.label}
              <span
                className={`rounded-[4px] px-1 text-[10.5px] tabular-nums
                  ${active ? "bg-field text-ink-2" : "text-ink-3"}`}
              >
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* table */}
      <div
        aria-label="Scrollable task table"
        className="overflow-x-auto rounded-card bg-surface shadow-card"
        role="region"
        tabIndex={0}
        style={{ scrollbarWidth: "none" }}
      >
        <div className="min-w-[420px]">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.6fr)_minmax(0,0.95fr)_minmax(0,0.9fr)] border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2">
            <span className="border-r border-[var(--grid-line)] px-3 py-2">{labels.columns.task}</span>
            <span className="border-r border-[var(--grid-line)] px-3 py-2">{labels.columns.date}</span>
            <span className="border-r border-[var(--grid-line)] px-3 py-2">{labels.columns.status}</span>
            <span className="px-3 py-2">{labels.columns.owner}</span>
          </div>
          {rows.length === 0 && empty && <div className="px-3 py-6 text-center text-[13px] text-ink-3">{empty}</div>}
          {rows.map((row) => {
            const shown = filter === "all" || row.status === filter;
            const pill = statuses[row.status] ?? { label: row.status, cls: "filter-status-todo", dot: "" };
            return (
              <div
                key={row.id ?? row.task}
                className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{
                  gridTemplateRows: shown ? "1fr" : "0fr",
                  opacity: shown ? 1 : 0,
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              >
                <div className="overflow-hidden">
                  <div
                    className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.6fr)_minmax(0,0.95fr)_minmax(0,0.9fr)] border-b
                      border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover"
                  >
                    <span className="flex min-w-0 items-center border-r border-[var(--grid-line)] px-3 py-2">
                      <span className={`truncate font-medium text-ink${row.mono ? " font-mono text-[12px]" : ""}`} title={row.task}>{row.task}</span>
                    </span>
                    <span className="flex items-center whitespace-nowrap border-r border-[var(--grid-line)] px-3 py-2 text-ink-2 tabular-nums">
                      {row.date}
                    </span>
                    <span className="flex items-center border-r border-[var(--grid-line)] px-3 py-2">
                      <span
                        className={`inline-flex h-[23px] shrink-0 items-center whitespace-nowrap rounded-[8px] border px-[7px]
                          text-[13px] font-medium ${pill.cls}`}
                      >
                        {pill.label}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center px-3 py-2 text-ink-2">
                      <span className="truncate">{row.owner}</span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
