import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/main/safety/audit";

const low = { level: "low" as const, reasons: [] };

describe("AuditLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fml-audit-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("logs commands that ran without asking, with their outcome", () => {
    const log = new AuditLog(null);
    log.toolFinished({ sessionID: "s", callID: "c1", tool: "bash", subject: "df -h", ok: true, exitCode: 0, rejected: false });
    log.toolFinished({ sessionID: "s", callID: "c2", tool: "read", subject: "/etc/hosts", ok: true, exitCode: null, rejected: false });
    expect(log.list()).toEqual([expect.objectContaining({ subject: "df -h", decision: "auto-ran", outcome: "succeeded", exitCode: 0 })]);
  });

  it("fills in the outcome of an approved command instead of adding a second entry", () => {
    const log = new AuditLog(null);
    log.record({ sessionID: "s", kind: "command", subject: "apt install vlc", risk: { level: "medium", reasons: [] }, decision: "approved", callID: "c1" });
    log.toolFinished({ sessionID: "s", callID: "c1", tool: "bash", subject: "apt install vlc", ok: true, exitCode: 100, rejected: false });
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]).toMatchObject({ decision: "approved", outcome: "failed", exitCode: 100 });
  });

  it("does not add an auto-ran entry for a rejected call", () => {
    const log = new AuditLog(null);
    log.record({ sessionID: "s", kind: "command", subject: "rm x", risk: low, decision: "denied", callID: "c1" });
    log.toolFinished({ sessionID: "s", callID: "c1", tool: "bash", subject: "rm x", ok: false, exitCode: null, rejected: true });
    expect(log.list().map((e) => e.decision)).toEqual(["denied"]);
  });

  it("persists and reloads, keeping the latest version of each entry", async () => {
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(file);
    log.record({ sessionID: "s", kind: "command", subject: "apt install vlc", risk: low, decision: "approved", callID: "c1" });
    log.toolFinished({ sessionID: "s", callID: "c1", tool: "bash", subject: "apt install vlc", ok: true, exitCode: 0, rejected: false });
    await log.flush();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);

    const reloaded = new AuditLog(file);
    await reloaded.load();
    expect(reloaded.list()).toEqual([expect.objectContaining({ subject: "apt install vlc", outcome: "succeeded" })]);
  });

  it("lists newest first", () => {
    const log = new AuditLog(null);
    log.toolFinished({ sessionID: "s", callID: "a", tool: "bash", subject: "first", ok: true, exitCode: 0, rejected: false });
    log.toolFinished({ sessionID: "s", callID: "b", tool: "bash", subject: "second", ok: true, exitCode: 0, rejected: false });
    expect(log.list().map((e) => e.subject)).toEqual(["second", "first"]);
  });
});
