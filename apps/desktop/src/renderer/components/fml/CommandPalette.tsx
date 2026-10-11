import { useEffect, useState } from "react";
import SearchList, { type SearchItem } from "@/components/bui/SearchList";
import { QUICK_FIXES } from "@/screens/Chat";
import { store, useApp } from "@/state/store";

/** Ctrl+K: jump to a chat, a screen, or start a quick fix. Built on Search. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const sessions = useApp((s) => s.sessions);
  const { navigate, ask, newChat } = store().actions;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const items: SearchItem[] = [
    { key: "new", label: "New chat", hint: "Start fresh" },
    ...QUICK_FIXES.filter((q) => !q.prompt?.endsWith(": ")).map((q) => ({ key: `fix:${q.key}`, label: q.desc, hint: "Quick fix" })),
    ...sessions.map((s) => ({ key: `chat:${s.id}`, label: s.title || "Untitled chat", hint: "Chat" })),
    { key: "go:home", label: "Home", hint: "Go to" },
    { key: "go:activity", label: "Activity", hint: "Go to" },
    { key: "go:settings", label: "Settings", hint: "Go to" },
  ];

  const pick = (item: SearchItem) => {
    if (typeof item === "string") return;
    setOpen(false);
    const [kind, value] = item.key.split(/:(.*)/s) as [string, string | undefined];
    if (kind === "new") newChat();
    else if (kind === "fix") {
      const fix = QUICK_FIXES.find((q) => q.key === value);
      if (fix?.prompt) void ask(fix.prompt);
    } else if (kind === "chat" && value) navigate({ kind: "chat", sessionID: value });
    else if (kind === "go" && (value === "home" || value === "activity" || value === "settings")) navigate({ kind: value });
  };

  return (
    <div
      role="dialog"
      aria-label="Search"
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex justify-center bg-[color-mix(in_srgb,var(--ink)_10%,transparent)] px-6 pt-[14vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-[460px]" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <SearchList
          fill
          autoFocus
          limit={8}
          items={items}
          onPick={pick}
          labels={{
            placeholder: "Search chats, quick fixes and screens…",
            ariaLabel: "Search",
            emptyTitle: "Nothing found",
            emptyHint: "Try different words",
          }}
        />
      </div>
    </div>
  );
}
