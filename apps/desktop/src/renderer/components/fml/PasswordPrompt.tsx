import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { ValuePill } from "@/components/atoms/ValuePill";
import CodeBlock from "@/components/bui/CodeBlock";
import type { PasswordRequest } from "../../../shared/ipc";

/**
 * sudo is asking for the administrator password. Composed from Beautiful UI
 * parts (card shell, ValuePill, Code Block, Button). The password goes
 * straight to sudo; it is never stored or shown to the assistant.
 */
export function PasswordPrompt({
  request,
  onAnswer,
}: {
  request: PasswordRequest;
  onAnswer: (password: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPassword("");
    input.current?.focus();
  }, [request.id]);

  const submit = () => {
    if (!password) return;
    const value = password;
    setPassword("");
    onAnswer(value);
  };

  return (
    <div
      data-testid="password-prompt"
      role="dialog"
      aria-label="Administrator password"
      className="w-full overflow-hidden rounded-card bg-surface shadow-overlay"
      style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="primitive-card-pad flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-ink-3">Administrator password</span>
            <ValuePill tone="red">Needs your password</ValuePill>
          </div>
          <p className="text-[14px] font-medium leading-snug text-ink">
            {request.attempt > 1
              ? "That password didn't work. Please try again."
              : "To do this, your computer needs the password you use to log in."}
          </p>
          <CodeBlock lines={[request.command]} code={request.command} filename="It will run" fill plain />
          <div className="flex h-9 items-center gap-1 rounded-control bg-field pr-1 pl-3 shadow-hairline focus-within:shadow-btn">
            <input
              ref={input}
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-label="Password"
              placeholder="Your login password"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
            />
            <Button variant="quiet" size="xs" type="button" onClick={() => setShow((v) => !v)}>
              {show ? "Hide" : "Show"}
            </Button>
          </div>
          <p className="text-[11.5px] text-ink-3">Your password goes straight to your computer's system. Fix My Linux never stores it or shows it to the assistant.</p>
        </div>
        <div className="primitive-card-footer flex items-center justify-end gap-1.5 border-t border-line">
          <Button variant="ghost" size="sm" type="button" onClick={() => onAnswer(null)}>
            Cancel
          </Button>
          <Button variant="accent" size="sm" type="submit" disabled={!password}>
            Continue
          </Button>
        </div>
      </form>
    </div>
  );
}
