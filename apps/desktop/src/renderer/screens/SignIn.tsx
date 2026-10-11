import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { ValuePill } from "@/components/atoms/ValuePill";
import { Shimmer } from "@/components/atoms/Shimmer";
import { store, useApp } from "@/state/store";

/**
 * Sign-in with an email code, composed from Beautiful UI parts (card shell,
 * Button, ValuePill, Shimmer). New accounts start the free trial here.
 */

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "email" | "numeric";
  maxLength?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-3">{label}</span>
      <span className="flex h-10 items-center rounded-control bg-field px-3 shadow-hairline focus-within:shadow-btn">
        <input
          ref={ref}
          type={type}
          value={value}
          inputMode={inputMode}
          maxLength={maxLength}
          autoComplete={type === "email" ? "email" : "one-time-code"}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
      </span>
    </label>
  );
}

export function SignIn() {
  const weak = useApp((s) => s.account.weakStorage);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { startSignIn, verify } = store().actions;

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSignIn(email.trim());
      setStep("code");
      setCode("");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await verify(email.trim(), code.trim());
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Fix your computer by describing the problem</h1>
          <p className="text-[14px] text-ink-2">
            Fix My Linux runs the right commands for you and asks before changing anything. Try it free for 5 days.
          </p>
        </div>

        <form
          className="overflow-hidden rounded-card bg-surface shadow-card"
          style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
          onSubmit={(e) => {
            e.preventDefault();
            void (step === "email" ? sendCode() : confirm());
          }}
        >
          <div className="primitive-card-pad flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-3">{step === "email" ? "Sign in or create an account" : "Check your email"}</span>
              <ValuePill tone="green">5-day free trial</ValuePill>
            </div>
            {step === "email" ? (
              <Field label="Your email" type="email" inputMode="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus />
            ) : (
              <>
                <p className="text-[13.5px] text-ink">
                  We sent a 6-digit code to <span className="font-medium">{email}</span>.
                </p>
                <Field
                  label="Code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(v) => setCode(v.replace(/\D/g, ""))}
                  placeholder="123456"
                  autoFocus
                />
              </>
            )}
            {error && (
              <p role="alert" className="rounded-control bg-red-tint px-2.5 py-1.5 text-[12.5px] text-red">
                {error}
              </p>
            )}
            {busy && <Shimmer className="text-[12.5px]">{step === "email" ? "Sending your code…" : "Signing you in…"}</Shimmer>}
          </div>
          <div className="primitive-card-footer flex items-center justify-between gap-2 border-t border-line">
            {step === "code" ? (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void sendCode()}>
                Send a new code
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="accent"
              size="sm"
              type="submit"
              disabled={busy || (step === "email" ? !email.includes("@") : code.length !== 6)}
            >
              {step === "email" ? "Email me a code" : "Continue"}
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-2 text-[12px] leading-relaxed text-ink-3">
          <p>
            During the free trial the assistant uses free AI models. Their providers may use what you send them, which can
            include details from your computer such as command output, to improve their models. Subscribing switches you to
            paid models.
          </p>
          {weak && (
            <p className="text-orange">
              Your computer has no password keyring set up, so your sign-in is saved without strong protection.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
