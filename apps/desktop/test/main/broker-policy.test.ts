import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PendingApproval } from "../../src/shared/approvals";
import { ApprovalBroker, type PermissionRequest } from "../../src/main/safety/broker";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "fml-bp-"));
  mkdirSync(join(home, ".mozilla/firefox/p"), { recursive: true });
  writeFileSync(join(home, ".mozilla/firefox/p/logins.json"), "{}");
  mkdirSync(join(home, "Documents"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("broker with the command policy", () => {
  let replies: Array<[string, string]>;
  let shown: PendingApproval[];
  let audits: Array<{ decision: string; subject: string }>;
  let broker: ApprovalBroker;

  beforeEach(() => {
    replies = [];
    shown = [];
    audits = [];
    broker = new ApprovalBroker({
      reply: async (id, reply) => void replies.push([id, reply]),
      explanationFor: () => null,
      show: (a) => shown.push(a),
      hide: () => undefined,
      audit: (e) => audits.push({ decision: e.decision, subject: e.subject }),
      home,
      policy: () => ({ home, cwd: home }),
      worktree: () => "/",
      alwaysAsk: () => false,
    });
  });

  const ask = (permission: string, patterns: string[], metadata: Record<string, unknown>): PermissionRequest => ({
    id: `p${replies.length + shown.length}`,
    sessionID: "s1",
    permission,
    patterns,
    always: [],
    metadata,
    tool: { messageID: "m", callID: "c" },
  });

  it("auto-approves read-only commands and logs them", async () => {
    await broker.onAsked(ask("bash", ["df -h"], { command: "df -h" }));
    expect(replies).toEqual([["p0", "once"]]);
    expect(shown).toEqual([]);
    expect(audits).toEqual([{ decision: "auto-ran", subject: "df -h" }]);
  });

  it("asks before reading private files, as high risk", async () => {
    await broker.onAsked(ask("bash", ["cat"], { command: `cat ${home}/.mozilla/firefox/p/logins.json` }));
    expect(replies).toEqual([]);
    expect(shown[0]!.risk.level).toBe("high");
    expect(shown[0]!.risk.reasons[0]).toMatch(/private files/);
    expect(shown[0]!.canAllowSimilar).toBe(false);
  });

  it("decides file-tool reads by resolved path", async () => {
    await broker.onAsked(ask("read", [`${home.slice(1)}/Documents/a.txt`], {}));
    await broker.onAsked(ask("read", [`${home.slice(1)}/.mozilla/firefox/p/logins.json`], {}));
    expect(replies).toEqual([["p0", "once"]]);
    expect(shown.map((a) => a.kind)).toEqual(["folder"]);
  });

  it("asks before grep searches that would reach private folders", async () => {
    await broker.onAsked(ask("grep", ["password"], { pattern: "password" }));
    await broker.onAsked(ask("grep", ["password"], { pattern: "password", path: join(home, "Documents") }));
    expect(shown).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });

  it("approves a command's folder request so the command card is the only one", async () => {
    await broker.onAsked(ask("external_directory", ["/var/cache/apt/*"], { command: "sudo apt clean", directories: ["/var/cache/apt"] }));
    expect(replies).toEqual([["p0", "once"]]);
    expect(shown).toEqual([]);
  });

  it("refuses blocked commands, even as folder requests", async () => {
    await broker.onAsked(ask("external_directory", ["/*"], { command: "rm -rf /", directories: ["/"] }));
    expect(replies).toEqual([["p0", "reject"]]);
    expect(audits[0]!.decision).toBe("blocked");
  });
});

describe("broker in the Flatpak build", () => {
  // File tools run inside the sandbox: outside home they'd see the runtime's
  // files, not the computer's. Commands run on the host and are unaffected.
  let replies: Array<[string, string, string | undefined]>;
  let shown: PendingApproval[];
  let broker: ApprovalBroker;

  beforeEach(() => {
    replies = [];
    shown = [];
    broker = new ApprovalBroker({
      reply: async (id, reply, message) => void replies.push([id, reply, message]),
      explanationFor: () => null,
      show: (a) => shown.push(a),
      hide: () => undefined,
      audit: () => undefined,
      home,
      policy: () => ({ home, cwd: home }),
      worktree: () => "/",
      alwaysAsk: () => false,
      sandboxed: true,
    });
  });

  const ask = (permission: string, patterns: string[], metadata: Record<string, unknown>): PermissionRequest => ({
    id: `p${replies.length + shown.length}`,
    sessionID: "s1",
    permission,
    patterns,
    always: [],
    metadata,
  });

  it("points file tools outside home to a shell command instead", async () => {
    await broker.onAsked(ask("external_directory", ["/etc/*"], { filepath: "/etc/fstab", parentDir: "/etc" }));
    await broker.onAsked(ask("read", ["etc/fstab"], {}));
    await broker.onAsked(ask("list", ["var/log"], {}));
    await broker.onAsked(ask("grep", ["error"], { pattern: "error", path: "/var/log" }));
    await broker.onAsked(ask("glob", ["*.conf"], { pattern: "*.conf", path: "/etc" }));
    await broker.onAsked(ask("edit", ["etc/hosts"], { filepath: "/etc/hosts", diff: "" }));
    expect(replies.map(([, r]) => r)).toEqual(["reject", "reject", "reject", "reject", "reject", "reject"]);
    expect(replies.every(([, , m]) => /shell command/.test(m ?? ""))).toBe(true);
    expect(shown).toEqual([]);
  });

  it("handles files in home as usual", async () => {
    await broker.onAsked(ask("read", [`${home.slice(1)}/Documents/a.txt`], {}));
    await broker.onAsked(ask("edit", [`${home.slice(1)}/Documents/a.txt`], { filepath: join(home, "Documents/a.txt"), diff: "" }));
    expect(replies).toEqual([["p0", "once", undefined]]);
    expect(shown.map((a) => a.kind)).toEqual(["edit"]);
  });

  it("leaves commands alone, since they run on the host", async () => {
    await broker.onAsked(ask("bash", ["cat /etc/fstab"], { command: "cat /etc/fstab" }));
    await broker.onAsked(ask("external_directory", ["/etc/*"], { command: "cat /etc/fstab", directories: ["/etc"] }));
    expect(replies.map(([, r]) => r)).toEqual(["once", "once"]);
  });
});
