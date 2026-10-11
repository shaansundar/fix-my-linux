/**
 * Beautiful UI atom, rebuilt from the compiled bundle at https://www.beautifului.dev
 * (the source is not published). MIT License, Copyright (c) 2026 Shane Levine.
 */
import type { ReactNode } from "react";

function Monogram({
  children,
  color = "#e08a3c",
  className = "",
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-full
        text-[9px] font-semibold leading-none text-white ${className}`}
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

export type EntityChipProps = {
  name: string;
  /** Monogram background. */
  color?: string;
  /** Defaults to the first letter of `name`. */
  monogram?: ReactNode;
  className?: string;
};

export function EntityChip({ name, color, monogram, className = "" }: EntityChipProps) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full bg-field
        py-px pl-[3px] pr-1.5 align-middle shadow-hairline ${className}`}
    >
      <Monogram color={color}>{monogram ?? name.charAt(0)}</Monogram>
      <span className="text-[12px] font-medium text-ink">{name}</span>
    </span>
  );
}
