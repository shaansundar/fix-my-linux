import { Button } from "@/components/atoms/Button";
import { ValuePill } from "@/components/atoms/ValuePill";
import type { Account } from "../../../shared/account";
import type { BlockedNotice } from "../../../shared/ipc";

/**
 * Paywall and allowance cards, composed from Beautiful UI parts in the
 * Approval Card's shape: a question the person answers before continuing.
 */

function date(iso?: string): string {
  if (!iso) return "soon";
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

type Props = {
  account?: Account;
  notice: BlockedNotice | null;
  onSubscribe: () => void;
  onManage: () => void;
  onCheckAgain: () => void;
  onDismiss: () => void;
};

/** What to show, if anything, given the account and the latest notice. */
export function planNoticeKind(account: Account | undefined, notice: BlockedNotice | null): "paywall" | "payment" | "budget" | "daily" | null {
  if (notice?.code === "budget_exhausted") return "budget";
  if (notice?.code === "daily_limit") return "daily";
  if (notice?.code === "payment_required" || account?.reason === "payment_required") return "payment";
  if (notice?.code === "trial_ended" || notice?.code === "trial_unavailable" || account?.state === "expired") return "paywall";
  return null;
}

export function PlanNotice({ account, notice, onSubscribe, onManage, onCheckAgain, onDismiss }: Props) {
  const kind = planNoticeKind(account, notice);
  if (!kind) return null;

  const copy = {
    paywall: {
      pill: <ValuePill tone="accent">$15 / month</ValuePill>,
      title:
        account?.reason === "trial_unavailable" || notice?.code === "trial_unavailable"
          ? "This computer already used its free trial"
          : "Your free trial has ended",
      body: "Subscribe to keep fixing things with the assistant. You get better AI models and a generous monthly allowance, and you can cancel anytime.",
    },
    payment: {
      pill: <ValuePill tone="red">Payment problem</ValuePill>,
      title: "We couldn't take your last payment",
      body: "Update your card to keep using the assistant.",
    },
    budget: {
      pill: <ValuePill tone="orange">Allowance used</ValuePill>,
      title: "You've used this month's assistant allowance",
      body: `It refills on ${date(notice?.resetsAt ?? account?.period_end)}. Until then the assistant can't take new requests.`,
    },
    daily: {
      pill: <ValuePill tone="orange">Daily limit</ValuePill>,
      title: "You've reached today's free limit",
      body: "It resets tomorrow. Subscribe for a monthly allowance instead of a daily one.",
    },
  }[kind];

  return (
    <div
      data-testid="plan-notice"
      role="alertdialog"
      aria-label={copy.title}
      className="w-full overflow-hidden rounded-card bg-surface shadow-card"
      style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="primitive-card-pad flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink-3">Fix My Linux</span>
          {copy.pill}
        </div>
        <p className="text-[14px] font-medium leading-snug text-ink">{copy.title}</p>
        <p className="text-[13px] text-ink-2">{copy.body}</p>
      </div>
      <div className="primitive-card-footer flex flex-wrap items-center justify-end gap-1.5 border-t border-line">
        {(kind === "budget" || kind === "daily") && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            OK
          </Button>
        )}
        {(kind === "paywall" || kind === "daily") && (
          <>
            <Button variant="ghost" size="sm" onClick={onCheckAgain}>
              I've already subscribed
            </Button>
            <Button variant="accent" size="sm" onClick={onSubscribe}>
              Subscribe
            </Button>
          </>
        )}
        {kind === "payment" && (
          <Button variant="accent" size="sm" onClick={onManage}>
            Update payment
          </Button>
        )}
      </div>
    </div>
  );
}
