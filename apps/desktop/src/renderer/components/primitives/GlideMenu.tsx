/**
 * Beautiful UI primitive, rebuilt from the compiled bundle at https://www.beautifului.dev
 * (the source is not published). MIT License, Copyright (c) 2026 Shane Levine.
 */
import { useRef, useState, type ReactNode } from "react";

export type GlideMenuProps = {
  children: ReactNode;
  className?: string;
  /** Classes for the highlight that glides between rows. */
  highlightClassName?: string;
  /** Which descendants count as rows. */
  rowSelector?: string;
};

/** A list whose hover/focus highlight slides between rows instead of jumping. */
export default function GlideMenu({
  children,
  className = "",
  highlightClassName = "inset-x-0 rounded-[8px] bg-hover",
  rowSelector = "[data-menu-row]",
}: GlideMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);

  const track = (target: EventTarget | null) => {
    const root = ref.current;
    if (!(target instanceof Element) || !root) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !root.contains(row)) return;
    const r = root.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    setBox({ top: b.top - r.top, height: b.height });
    setVisible(true);
  };

  return (
    <div
      ref={ref}
      onMouseOver={(e) => track(e.target)}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={(e) => track(e.target)}
      onBlurCapture={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node | null)) setVisible(false);
      }}
      className={`group/glide-menu relative ${className}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute ${highlightClassName}`}
        style={{
          top: box?.top ?? 0,
          height: box?.height ?? 0,
          opacity: box && visible ? 1 : 0,
          transition:
            "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease",
        }}
      />
      {children}
    </div>
  );
}
