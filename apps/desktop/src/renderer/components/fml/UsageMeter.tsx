import { Button } from "@/components/atoms/Button";
import { ValuePill, type ValuePillTone } from "@/components/atoms/ValuePill";
import type { Account } from "../../../shared/account";

/** The sidebar footer: plan, what's left, and the next step. Built from ValuePill and Button. */
export function UsageMeter({ account, onSubscribe, onManage }: { account?: Account; onSubscribe: () => void; onManage: () => void }) {
  if (!account) return null;
  let pill: { tone: ValuePillTone; text: string };
  let detail: string;
  let fraction = 0;

  if (account.state === "active") {
    const used = account.used_usd ?? 0;
    const budget = account.budget_usd ?? 8;
    fraction = Math.min(1, used / budget);
    pill = { tone: fraction > 0.9 ? "orange" : "green", text: "Subscribed" };
    detail = `${Math.round(fraction * 100)}% of this month's allowance used`;
  } else if (account.state === "trial") {
    const left = account.trial_ends_at ? Math.max(0, Math.ceil((Date.parse(account.trial_ends_at) - Date.now()) / 86_400_000)) : 0;
    fraction = account.daily_limit ? Math.min(1, (account.used_today ?? 0) / account.daily_limit) : 0;
    pill = { tone: "accent", text: "Free trial" };
    detail = left <= 1 ? "Ends today" : `${left} days left`;
  } else {
    pill = { tone: "red", text: "Trial ended" };
    detail = "Subscribe to continue";
  }

  return (
    <div data-testid="usage-meter" className="flex flex-col gap-2 px-1">
      <div className="flex items-center justify-between gap-2">
        <ValuePill tone={pill.tone} className="mx-0 whitespace-nowrap">
          {pill.text}
        </ValuePill>
        {account.state !== "expired" && <span className="truncate text-[11.5px] text-ink-3">{detail}</span>}
      </div>
      {account.state !== "expired" && (
        <div className="h-1 overflow-hidden rounded-full bg-hover-2" aria-hidden>
          <div className="h-full rounded-full bg-ink-3 transition-[width] duration-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      )}
      {account.state === "active" ? (
        <Button variant="secondary" size="xs" className="w-full" onClick={onManage}>
          Manage subscription
        </Button>
      ) : (
        <Button variant="accent" size="xs" className="w-full" onClick={onSubscribe}>
          Subscribe · $15/month
        </Button>
      )}
    </div>
  );
}
