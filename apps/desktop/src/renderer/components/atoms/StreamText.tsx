/**
 * Beautiful UI atom, rebuilt from the compiled bundle at https://www.beautifului.dev
 * (the source is not published). MIT License, Copyright (c) 2026 Shane Levine.
 */
import { useEffect, useRef, useState } from "react";

export type StreamTextProps = {
  text: string;
  charsPerTick?: number;
  tickMs?: number;
  /** How many trailing characters render blurred while streaming. */
  blurTail?: number;
  caret?: boolean;
  className?: string;
  onProgress?: () => void;
  onDone?: () => void;
};

/** Reveals `text` a few characters at a time with a soft blurred tail. */
export function StreamText({
  text,
  charsPerTick = 2,
  tickMs = 9,
  blurTail = 6,
  caret = true,
  className,
  onProgress,
  onDone,
}: StreamTextProps) {
  const [shown, setShown] = useState(0);
  const progressRef = useRef(onProgress);
  const doneRef = useRef(onDone);
  progressRef.current = onProgress;
  doneRef.current = onDone;

  useEffect(() => {
    setShown(0);
    let n = 0;
    const id = setInterval(() => {
      n = Math.min(n + charsPerTick, text.length);
      setShown(n);
      progressRef.current?.();
      if (n >= text.length) {
        clearInterval(id);
        doneRef.current?.();
      }
    }, tickMs);
    return () => clearInterval(id);
  }, [text, charsPerTick, tickMs]);

  const streaming = shown < text.length;
  const visible = text.slice(0, shown);
  const solid = streaming ? Math.max(0, visible.length - blurTail) : visible.length;

  return (
    <span className={className}>
      {visible.slice(0, solid)}
      {solid < visible.length && <span className="stream-tail">{visible.slice(solid)}</span>}
      {caret && <span aria-hidden className={`stream-caret${streaming ? " is-streaming" : ""}`} />}
    </span>
  );
}
