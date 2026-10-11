/**
 * Vendored from Beautiful UI — https://www.beautifului.dev
 * MIT License, Copyright (c) 2026 Shane Levine. See THIRD_PARTY_NOTICES.md.
 */
"use client";

import { useState } from "react";
import GlideMenu from "@/components/primitives/GlideMenu";

/* ─────────────────────────────────────────────────────────
 * SEARCH — command search with live filtering.
 * The field, clear action, and results are directly usable.
 * ───────────────────────────────────────────────────────── */

/** A plain label, or a keyed entry with an optional hint shown on the right. */
export type SearchItem = string | { key: string; label: string; hint?: string };

const labelOf = (i: SearchItem) => (typeof i === "string" ? i : i.label);
const keyOf = (i: SearchItem) => (typeof i === "string" ? i : i.key);

export type SearchListLabels = {
  placeholder: string;
  ariaLabel: string;
  emptyTitle: string;
  emptyHint: string;
};

const ITEMS: SearchItem[] = [
  "Forecast summer demand",
  "Find waffle cone suppliers",
  "Compare seasonal flavors",
  "Draft flavor launch plan",
  "Check cold-chain status",
  "Audit sugar costs",
  "Retire low sellers",
];

const LABELS: SearchListLabels = {
  placeholder: "Search flavors…",
  ariaLabel: "Search flavors",
  emptyTitle: "No results found",
  emptyHint: "Adjust your search to try again",
};

export default function SearchList({
  items = ITEMS,
  labels = LABELS,
  onPick,
  autoFocus = false,
  limit = 5,
  fill = false,
}: {
  items?: SearchItem[];
  labels?: SearchListLabels;
  /** Called when a result is chosen (click or Enter); without it, picking fills the query. */
  onPick?: (item: SearchItem) => void;
  autoFocus?: boolean;
  /** How many results show before typing. */
  limit?: number;
  fill?: boolean;
  variant?: string;
} = {}) {
  const [query, setQuery] = useState("");
  const results = query
    ? items.filter((i) => labelOf(i).toLowerCase().includes(query.toLowerCase())).slice(0, 12)
    : items.slice(0, limit);
  const pick = (item: SearchItem) => (onPick ? onPick(item) : setQuery(labelOf(item)));
  const empty = query.length > 2 && results.length === 0;

  return (
    <div className={`flex ${fill ? "" : "min-h-[248px] max-w-72 "}w-full flex-col items-stretch`}>
      <div className="w-full self-start overflow-hidden rounded-card bg-surface shadow-raised">
        {/* input row */}
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" className="shrink-0">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={query}
            autoFocus={autoFocus}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0]) {
                event.preventDefault();
                pick(results[0]);
              }
            }}
            placeholder={labels.placeholder}
            aria-label={labels.ariaLabel}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button
              aria-label="Clear search"
              type="button"
              onClick={() => setQuery("")}
              className="flex size-6 items-center justify-center rounded-full text-ink-3
                transition-colors duration-100 hover:bg-line/70 hover:text-ink"
              style={{ animation: "fade-in 150ms ease-out both" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* results / empty state */}
        {empty ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-8" style={{ animation: "fade-in 250ms ease-out both" }}>
            <span className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <span className="text-[13px] font-medium text-ink">{labels.emptyTitle}</span>
            <span className="text-[12px] text-ink-3">{labels.emptyHint}</span>
          </div>
        ) : (
          <div className="p-1">
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {results.map((item) => (
                <button
                  key={keyOf(item)}
                  data-menu-row
                  type="button"
                  onClick={() => pick(item)}
                  className="relative z-10 flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-ink"
                  style={{ animation: "fade-in 200ms ease-out both" }}
                >
                  <span className="min-w-0 flex-1 truncate">{labelOf(item)}</span>
                  {typeof item !== "string" && item.hint && <span className="shrink-0 text-[11.5px] text-ink-3">{item.hint}</span>}
                </button>
              ))}
            </GlideMenu>
          </div>
        )}
      </div>
    </div>
  );
}
