import { useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/atoms/Button";
import { ChatBubbleQuestion, Spark } from "@/components/icons";

/**
 * Highlight text the assistant showed (an error, some output) and ask about it.
 * Composed from Selection Actions' parts: the floating pill bar, quiet
 * Buttons and the same icons and motion.
 */
export function SelectionBar({ root, onAsk }: { root: RefObject<HTMLElement | null>; onAsk: (prompt: string) => void }) {
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const s = window.getSelection();
      const el = root.current;
      if (!s || s.isCollapsed || !el || s.rangeCount === 0) return setSel(null);
      const range = s.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setSel(null);
      const text = s.toString().trim();
      if (text.length < 3) return setSel(null);
      const rect = range.getBoundingClientRect();
      setSel({ text: text.slice(0, 2000), x: rect.left + rect.width / 2, y: rect.bottom + 8 });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [root]);

  if (!sel) return null;
  const run = (prompt: string) => {
    window.getSelection()?.removeAllRanges();
    setSel(null);
    onAsk(prompt);
  };
  const quoted = `"${sel.text}"`;

  return (
    <div
      data-testid="selection-bar"
      className="fixed z-40"
      style={{ left: sel.x, top: sel.y, transform: "translateX(-50%)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        className="flex h-9 items-center gap-0.5 rounded-full bg-surface p-1 font-sans text-ink shadow-overlay"
        style={{ animation: "pop-in 220ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <Button variant="quiet" size="xs" onClick={() => run(`Can you explain this in plain words?\n\n${quoted}`)}>
          <ChatBubbleQuestion width={14} height={14} strokeWidth={1.8} aria-hidden />
          Explain this
        </Button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
        <Button variant="quiet" size="xs" onClick={() => run(`Can you fix this?\n\n${quoted}`)}>
          <Spark width={14} height={14} strokeWidth={1.8} aria-hidden />
          Fix this
        </Button>
      </div>
    </div>
  );
}
