import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { ApprovalKind, AuditDecision, AuditEntry, Risk } from "../../shared/approvals";
import { scoreCommand } from "./risk";

/** Tools whose use is worth showing on the Activity screen. */
const AUDITED_TOOLS = new Set(["bash", "edit", "write", "apply_patch", "webfetch"]);

type Pending = { index: number };

/**
 * Append-only record of what the agent did on the computer: commands that ran
 * on their own, approvals, refusals and blocks, each with its outcome.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private byCall = new Map<string, Pending>();
  private listeners = new Set<(e: AuditEntry) => void>();
  /** Writes are chained so an entry's update always lands after the entry. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly max = 2000,
  ) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = await readFile(this.file, "utf8");
      // Updates are appended as new lines; the last line for an id wins.
      const byId = new Map<string, AuditEntry>();
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as AuditEntry;
          byId.delete(e.id);
          byId.set(e.id, e);
        } catch {
          // skip a torn line from a crash mid-write
        }
      }
      this.entries = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-this.max);
    } catch {
      this.entries = [];
    }
  }

  list(): AuditEntry[] {
    return [...this.entries].reverse();
  }

  onEntry(fn: (e: AuditEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(e: { sessionID: string; kind: ApprovalKind; subject: string; risk: Risk; decision: AuditDecision; callID?: string }): void {
    const entry: AuditEntry = { id: randomUUID(), ts: Date.now(), sessionID: e.sessionID, kind: e.kind, subject: e.subject, risk: e.risk.level, decision: e.decision };
    this.push(entry);
    if (e.callID && e.decision !== "denied" && e.decision !== "blocked") {
      this.byCall.set(`${e.sessionID}:${e.callID}`, { index: this.entries.length - 1 });
    }
  }

  /** Called for every finished tool part; fills in outcomes and logs commands that ran on their own. */
  toolFinished(t: { sessionID: string; callID: string; tool: string; subject: string; ok: boolean; exitCode: number | null; rejected: boolean }): void {
    if (!AUDITED_TOOLS.has(t.tool) || t.rejected) return;
    const key = `${t.sessionID}:${t.callID}`;
    const pending = this.byCall.get(key);
    const outcome = t.ok && (t.exitCode === null || t.exitCode === 0) ? "succeeded" : "failed";
    if (pending) {
      this.byCall.delete(key);
      const prev = this.entries[pending.index];
      if (prev) {
        const updated: AuditEntry = { ...prev, outcome, ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}) };
        this.entries[pending.index] = updated;
        this.persist(updated);
        for (const fn of this.listeners) fn(updated);
      }
      return;
    }
    const kind: ApprovalKind = t.tool === "bash" ? "command" : t.tool === "webfetch" ? "web" : "edit";
    const risk = t.tool === "bash" ? scoreCommand(t.subject).level : "low";
    this.push({
      id: randomUUID(),
      ts: Date.now(),
      sessionID: t.sessionID,
      kind,
      subject: t.subject,
      risk,
      decision: "auto-ran",
      outcome,
      ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}),
    });
  }

  private push(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
      this.byCall.clear();
    }
    this.persist(entry);
    for (const fn of this.listeners) fn(entry);
  }

  private persist(entry: AuditEntry): void {
    const file = this.file;
    if (!file) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.writes = this.writes.then(() => appendFile(file, line, { mode: 0o600 })).catch(() => undefined);
  }

  /** Resolves once every queued write is on disk. */
  flush(): Promise<void> {
    return this.writes;
  }
}
