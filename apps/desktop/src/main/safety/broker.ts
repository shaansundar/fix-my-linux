import type { ApprovalDecision, ApprovalKind, AuditDecision, PendingApproval, Risk, RiskLevel } from "../../shared/approvals";
import { DENY_BASH } from "../opencode/permissions";
import { match, simpleCommands } from "../opencode/wildcard";
import { scoreCommand, scoreDirectories, scoreEdit } from "./risk";

/** The subset of opencode's permission.asked payload the broker uses. */
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

export type BrokerDeps = {
  /** Answers opencode. The broker never sends "always": in opencode 1.19 it overrides deny rules process-wide. */
  reply(requestID: string, reply: "once" | "reject", message?: string): Promise<void>;
  /** The agent's sentence right before the tool call, if any. */
  explanationFor(req: PermissionRequest): string | null;
  /** Ask the user. */
  show(approval: PendingApproval): void;
  /** The approval went away (answered here, elsewhere, or cascaded). */
  hide(id: string): void;
  audit(entry: { sessionID: string; kind: ApprovalKind; subject: string; risk: Risk; decision: AuditDecision; callID?: string }): void;
  home: string;
  /** Settings: when true, never auto-approve "similar" requests. */
  alwaysAsk(): boolean;
  now?(): number;
};

/** Actions too consequential to approve in bulk, even at medium risk. */
const NO_SIMILAR_REASONS = new Set(["Deletes or moves files", "Stops running programs", "Writes to a file"]);
const LEVEL: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const BLOCKED_MESSAGE =
  "This command is blocked by Fix My Linux for safety and was not run. Do not try to work around this block; explain to the user what you wanted to do instead.";

export class ApprovalBroker {
  private readonly pending = new Map<string, { approval: PendingApproval; similarKey: string | null; req: PermissionRequest }>();
  /** sessionID → similar-key → the highest risk the user approved for it. */
  private readonly similar = new Map<string, Map<string, RiskLevel>>();

  constructor(private readonly deps: BrokerDeps) {}

  async onAsked(req: PermissionRequest): Promise<void> {
    const command = typeof req.metadata["command"] === "string" ? (req.metadata["command"] as string) : null;

    // opencode asks for folder access before it evaluates bash rules, so a
    // denied command would otherwise reach the user as "allow access to /?".
    if (command && isBlocked(command)) {
      await this.deps.reply(req.id, "reject", BLOCKED_MESSAGE);
      this.deps.audit({ sessionID: req.sessionID, kind: "command", subject: command, risk: scoreCommand(command), decision: "blocked", callID: req.tool?.callID });
      return;
    }

    const approval = this.describe(req);
    const similarKey = approval.canAllowSimilar ? similarKeyFor(req) : null;
    const remembered = similarKey ? this.similar.get(req.sessionID)?.get(similarKey) : undefined;
    if (remembered && !this.deps.alwaysAsk() && LEVEL[approval.risk.level] <= LEVEL[remembered]) {
      await this.deps.reply(req.id, "once");
      this.deps.audit(this.auditOf(approval, "approved-similar", req));
      return;
    }

    this.pending.set(req.id, { approval, similarKey, req });
    this.deps.show(approval);
  }

  async decide(id: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.deps.hide(id);

    const { approval, similarKey, req } = entry;
    if (decision === "reject") {
      await this.deps.reply(id, "reject", "The user chose not to do this. Ask them how they would like to proceed.");
      this.deps.audit(this.auditOf(approval, "denied", req));
      // opencode rejects every other pending request in the session too.
      for (const [otherID, other] of this.pending) {
        if (other.approval.sessionID === approval.sessionID) {
          this.pending.delete(otherID);
          this.deps.hide(otherID);
        }
      }
      return;
    }

    if (decision === "similar" && similarKey && approval.canAllowSimilar) {
      let keys = this.similar.get(approval.sessionID);
      if (!keys) this.similar.set(approval.sessionID, (keys = new Map()));
      keys.set(similarKey, approval.risk.level);
    }
    await this.deps.reply(id, "once");
    this.deps.audit(this.auditOf(approval, decision === "similar" ? "approved-similar" : "approved", req));
  }

  /** opencode said the request was answered (possibly by a cascade). */
  onReplied(requestID: string): void {
    if (this.pending.delete(requestID)) this.deps.hide(requestID);
  }

  /** Forget everything for a session, e.g. when it is deleted. */
  forgetSession(sessionID: string): void {
    this.similar.delete(sessionID);
    for (const [id, p] of this.pending) {
      if (p.approval.sessionID === sessionID) {
        this.pending.delete(id);
        this.deps.hide(id);
      }
    }
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  private describe(req: PermissionRequest): PendingApproval {
    const meta = req.metadata;
    const base = {
      id: req.id,
      sessionID: req.sessionID,
      explanation: this.deps.explanationFor(req),
      createdAt: this.deps.now?.() ?? Date.now(),
    };
    let kind: ApprovalKind;
    let risk: Risk;
    const extra: Partial<PendingApproval> = {};

    switch (req.permission) {
      case "bash": {
        kind = "command";
        const command = String(meta["command"] ?? req.patterns.join(" && "));
        extra.command = command;
        risk = scoreCommand(command);
        break;
      }
      case "edit": {
        kind = "edit";
        const filepath = String(meta["filepath"] ?? req.patterns[0] ?? "");
        extra.filepath = filepath;
        if (typeof meta["diff"] === "string") extra.diff = meta["diff"];
        risk = scoreEdit(filepath, this.deps.home);
        break;
      }
      case "external_directory": {
        kind = "folder";
        const dirs = Array.isArray(meta["directories"]) ? (meta["directories"] as unknown[]).map(String) : req.patterns;
        extra.directories = dirs;
        if (typeof meta["command"] === "string") extra.command = meta["command"];
        risk = scoreDirectories(dirs, this.deps.home);
        break;
      }
      case "webfetch": {
        kind = "web";
        extra.url = String(meta["url"] ?? req.patterns[0] ?? "");
        risk = { level: "low", reasons: ["Opens a web page to look something up"] };
        break;
      }
      default:
        kind = "other";
        risk = { level: "medium", reasons: [`Uses the "${req.permission}" tool`] };
    }
    const canAllowSimilar =
      kind !== "other" && risk.level !== "high" && !risk.reasons.some((r) => NO_SIMILAR_REASONS.has(r));
    return { ...base, kind, risk, canAllowSimilar, ...extra };
  }

  private auditOf(approval: PendingApproval, decision: AuditDecision, req: PermissionRequest) {
    const subject = approval.command ?? approval.filepath ?? approval.url ?? approval.directories?.join(", ") ?? "";
    return { sessionID: approval.sessionID, kind: approval.kind, subject, risk: approval.risk, decision, callID: req.tool?.callID };
  }
}

/**
 * Deletions the app refuses outright, matched precisely: recursive rm of the
 * whole disk, a top-level system folder, or a whole home folder.
 */
const HARD_BLOCK: RegExp[] = [
  /^(sudo\s+)?rm\s+(?=(?:[^|;&]*\s)?(?:-\w*[rR]|--recursive))[^|;&]*\s(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|"\$HOME"\/?\*?|\/home\/?\*?|\/home\/[^/\s]+\/?\*?|\/(etc|usr|boot|bin|sbin|lib|lib64|var|opt|root|srv)\/?\*?)(\s|$)/,
];

export function isBlocked(command: string): boolean {
  return simpleCommands(command).some(
    (part) => DENY_BASH.some((pattern) => match(part, pattern)) || HARD_BLOCK.some((re) => re.test(part)),
  );
}

/**
 * What "similar" means per kind: the same command family opencode reports in
 * `always` (e.g. "flatpak install *"), the same file, the same folders, or
 * the same website.
 */
export function similarKeyFor(req: PermissionRequest): string | null {
  switch (req.permission) {
    case "bash":
      return req.always.length ? `bash:${[...req.always].sort().join("|")}` : null;
    case "edit":
      return `edit:${String(req.metadata["filepath"] ?? req.patterns[0] ?? "")}`;
    case "external_directory":
      return `dir:${[...req.patterns].sort().join("|")}`;
    case "webfetch": {
      try {
        return `web:${new URL(String(req.metadata["url"] ?? req.patterns[0])).host}`;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
