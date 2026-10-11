/**
 * Beautiful UI atom, rebuilt from the compiled bundle at https://www.beautifului.dev
 * (the source is not published). MIT License, Copyright (c) 2026 Shane Levine.
 */
import type { ReactNode } from "react";

export type ValuePillTone = "neutral" | "green" | "orange" | "red" | "accent";

const TONES: Record<ValuePillTone, { cls: string; ring: string }> = {
  neutral: { cls: "bg-field text-ink-2", ring: "var(--shadow-hairline)" },
  green: { cls: "bg-green-tint text-green", ring: "0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)" },
  orange: { cls: "bg-orange-tint text-orange", ring: "0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)" },
  red: { cls: "bg-red-tint text-red", ring: "0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)" },
  accent: { cls: "bg-accent-tint text-accent-ink", ring: "0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)" },
};

export type ValuePillProps = {
  children: ReactNode;
  tone?: ValuePillTone;
  className?: string;
};

export function ValuePill({ children, tone = "neutral", className = "" }: ValuePillProps) {
  const t = TONES[tone];
  return (
    <span
      className={`mx-0.5 inline-flex items-center rounded-full px-1.5 py-0
        align-middle text-[12px] font-medium ${t.cls} ${className}`}
      style={{ boxShadow: t.ring }}
    >
      {children}
    </span>
  );
}
