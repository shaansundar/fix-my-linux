import { useState } from "react";
import { Button } from "@/components/atoms/Button";
import { ValuePill, type ValuePillTone } from "@/components/atoms/ValuePill";
import CodeBlock from "@/components/bui/CodeBlock";
import { ChangeTable, type ChangeRow } from "@/components/bui/DiffTable";
import { parseUnifiedDiff } from "@/lib/diff";
import type { ApprovalDecision, PendingApproval, RiskLevel } from "../../../shared/approvals";

/**
 * Asks before the agent changes anything. Composed from Beautiful UI parts:
 * the Approval Card shell, Button, ValuePill and Code Block.
 */

const RISK: Record<RiskLevel, { tone: ValuePillTone; label: string }> = {
  low: { tone: "green", label: "Low risk" },
  medium: { tone: "orange", label: "Medium risk" },
  high: { tone: "red", label: "High risk" },
};

const TITLES: Record<PendingApproval["kind"], { title: string; fallback: string; allow: string }> = {
  command: { title: "Run a command", fallback: "The assistant wants to run a command on your computer.", allow: "Allow" },
  edit: { title: "Change a file", fallback: "The assistant wants to change a file.", allow: "Allow change" },
  folder: { title: "Look outside your home folder", fallback: "The assistant wants to look at files outside your home folder.", allow: "Allow" },
  web: { title: "Open a web page", fallback: "The assistant wants to look something up on the web.", allow: "Allow" },
  other: { title: "Use a tool", fallback: "The assistant wants to use a tool.", allow: "Allow" },
};

export function CommandApproval({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(approval.risk.level === "high" || approval.kind === "edit");
  const copy = TITLES[approval.kind];
  const risk = RISK[approval.risk.level];

  const decide = (d: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    onDecide(d);
  };

  const detail =
    approval.kind === "edit" && approval.diff ? (
      <CodeBlock variant="Diff" diff={parseUnifiedDiff(approval.diff)} filename={approval.filepath ?? "file"} fill maxBodyHeight={220} />
    ) : approval.command ? (
      <CodeBlock lines={approval.command.split("\n")} code={approval.command} filename="Command" fill plain maxBodyHeight={160} />
    ) : approval.directories?.length ? (
      <CodeBlock lines={approval.directories} filename="Folders" fill plain />
    ) : approval.url ? (
      <CodeBlock lines={[approval.url]} filename="Web page" fill plain />
    ) : approval.filepath ? (
      <CodeBlock lines={[approval.filepath]} filename="File" fill plain />
    ) : null;

  return (
    <div
      data-testid="approval-card"
      role="alertdialog"
      aria-label={copy.title}
      className="w-full overflow-hidden rounded-card bg-surface shadow-card"
      style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="primitive-card-pad flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink-3">{copy.title}</span>
          <ValuePill tone={risk.tone}>{risk.label}</ValuePill>
        </div>
        <p className="text-[14px] font-medium leading-snug text-ink">{approval.explanation ?? copy.fallback}</p>
        {approval.risk.reasons.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
            {approval.risk.reasons.map((r) => (
              <li key={r} className="flex items-center gap-1.5">
                <span aria-hidden className="size-1 rounded-full bg-ink-3" />
                {r}
              </li>
            ))}
          </ul>
        )}
        {approval.packages && approval.packages.length > 0 && <PackageChanges changes={approval.packages} />}
        {detail && (
          <div>
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
              className="-mx-1.5 flex items-center gap-1 rounded-control px-1.5 py-0.5 text-[12px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: showDetails ? "rotate(0deg)" : "rotate(-90deg)" }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
              {showDetails ? "Hide details" : "Show exactly what will run"}
            </button>
            <div
              className="grid transition-[grid-template-rows,opacity] duration-300"
              style={{ gridTemplateRows: showDetails ? "1fr" : "0fr", opacity: showDetails ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="pt-2">{detail}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="primitive-card-footer flex flex-wrap items-center justify-end gap-1.5 border-t border-line">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide("reject")}>
          Don't do this
        </Button>
        {approval.canAllowSimilar && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide("similar")} title="Don't ask again for this kind of step in this chat">
            Allow similar
          </Button>
        )}
        <Button variant={approval.risk.level === "high" ? "danger" : "accent"} size="sm" disabled={busy} onClick={() => decide("once")}>
          {copy.allow}
        </Button>
      </div>
    </div>
  );
}

const TAG: Record<ChangeRow["kind"], string> = { add: "New", remove: "Removed", update: "Update" };

/** What the package manager says will change, from its dry run. */
function PackageChanges({ changes }: { changes: NonNullable<PendingApproval["packages"]> }) {
  // Removals first: they're what the person most needs to see.
  const order = { remove: 0, add: 1, update: 2 } as const;
  const rows: ChangeRow[] = [...changes]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((c, i) => ({ key: `${c.kind}-${c.name}-${i}`, kind: c.kind, name: c.name, tag: TAG[c.kind], detail: c.detail }));
  const removed = changes.filter((c) => c.kind === "remove").length;
  const added = changes.filter((c) => c.kind === "add").length;
  const updated = changes.length - removed - added;
  const parts = [added && `${added} new`, updated && `${updated} updated`, removed && `${removed} removed`].filter(Boolean).join(", ");
  return <ChangeTable title={`What this changes: ${parts}`} rows={rows} columns={["Package", "Change", "Version"]} limit={6} />;
}
