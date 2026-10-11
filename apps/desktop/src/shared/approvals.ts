/** Types shared by the main process and the renderer for the approval flow. */

export type RiskLevel = "low" | "medium" | "high";
export type Risk = { level: RiskLevel; reasons: string[] };

export type ApprovalKind = "command" | "edit" | "folder" | "web" | "other";

export type PendingApproval = {
  id: string;
  sessionID: string;
  kind: ApprovalKind;
  /** The agent's own one-sentence explanation, shown as context, not trusted. */
  explanation: string | null;
  command?: string;
  filepath?: string;
  diff?: string;
  directories?: string[];
  url?: string;
  risk: Risk;
  /** "Allow similar for this chat" is offered only for low and medium risk. */
  canAllowSimilar: boolean;
  createdAt: number;
};

export type ApprovalDecision = "once" | "similar" | "reject";

export type AuditDecision = "auto-ran" | "approved" | "approved-similar" | "denied" | "blocked";

export type AuditEntry = {
  ts: number;
  sessionID: string;
  kind: ApprovalKind;
  subject: string;
  risk: RiskLevel;
  decision: AuditDecision;
  /** Filled in when the tool finishes. */
  outcome?: "succeeded" | "failed";
  exitCode?: number;
};
