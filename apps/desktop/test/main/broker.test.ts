import { beforeEach, describe, expect, it } from "vitest";
import type { PendingApproval } from "../../src/shared/approvals";
import { ApprovalBroker, type PermissionRequest } from "../../src/main/safety/broker";
import { isBlocked } from "../../src/main/safety/blocklist";

function bash(id: string, command: string, always: string[], sessionID = "s1"): PermissionRequest {
  return { id, sessionID, permission: "bash", patterns: [command], always, metadata: { command }, tool: { messageID: "m", callID: `c-${id}` } };
}

describe("ApprovalBroker", () => {
  let replies: Array<[string, string, string?]>;
  let shown: PendingApproval[];
  let hidden: string[];
  let audits: Array<{ decision: string; subject: string }>;
  let alwaysAsk: boolean;
  let broker: ApprovalBroker;

  beforeEach(() => {
    replies = [];
    shown = [];
    hidden = [];
    audits = [];
    alwaysAsk = false;
    broker = new ApprovalBroker({
      reply: async (id, reply, message) => void replies.push([id, reply, message]),
      explanationFor: () => "I'll install VLC so you can play that video.",
      show: (a) => shown.push(a),
      hide: (id) => hidden.push(id),
      audit: (e) => audits.push({ decision: e.decision, subject: e.subject }),
      home: "/home/ana",
      policy: () => ({ home: "/home/ana", cwd: "/home/ana" }),
      worktree: () => "/",
      alwaysAsk: () => alwaysAsk,
      now: () => 1000,
    });
  });

  it("shows a scored approval with the agent's explanation", async () => {
    await broker.onAsked(bash("p1", "flatpak install -y flathub org.videolan.VLC", ["flatpak install *"]));
    expect(replies).toEqual([]);
    expect(shown[0]).toMatchObject({
      id: "p1",
      kind: "command",
      command: "flatpak install -y flathub org.videolan.VLC",
      explanation: "I'll install VLC so you can play that video.",
      risk: { level: "medium" },
      canAllowSimilar: true,
    });
  });

  it("rejects blocked commands before the user ever sees them, even folder requests", async () => {
    await broker.onAsked({
      id: "p1",
      sessionID: "s1",
      permission: "external_directory",
      patterns: ["/*"],
      always: ["/*"],
      metadata: { command: "rm -rf /", directories: ["/"] },
    });
    expect(shown).toEqual([]);
    expect(replies[0]?.[1]).toBe("reject");
    expect(audits[0]?.decision).toBe("blocked");
  });

  it("never replies 'always', even for allow-similar", async () => {
    await broker.onAsked(bash("p1", "flatpak install x", ["flatpak install *"]));
    await broker.decide("p1", "similar");
    expect(replies).toEqual([["p1", "once", undefined]]);
  });

  it("auto-approves similar requests in the same chat only", async () => {
    await broker.onAsked(bash("p1", "flatpak install x", ["flatpak install *"]));
    await broker.decide("p1", "similar");
    await broker.onAsked(bash("p2", "flatpak install y", ["flatpak install *"]));
    expect(replies.at(-1)).toEqual(["p2", "once", undefined]);
    expect(shown.map((a) => a.id)).toEqual(["p1"]);

    await broker.onAsked(bash("p3", "flatpak install z", ["flatpak install *"], "s2"));
    expect(shown.map((a) => a.id)).toEqual(["p1", "p3"]);
  });

  it("does not auto-approve a riskier request with the same prefix", async () => {
    await broker.onAsked(bash("p1", "systemctl --user restart pipewire", ["systemctl *"]));
    await broker.decide("p1", "similar");
    await broker.onAsked(bash("p2", "systemctl disable bluetooth", ["systemctl *"]));
    expect(shown.map((a) => a.id)).toEqual(["p1", "p2"]);
  });

  it("never offers allow-similar for high risk or deletions", async () => {
    await broker.onAsked(bash("p1", "sudo apt install vlc", ["sudo *"]));
    await broker.onAsked(bash("p2", "rm ~/Downloads/a.iso", ["rm *"]));
    expect(shown.map((a) => a.canAllowSimilar)).toEqual([false, false]);
    await broker.decide("p1", "similar");
    await broker.onAsked(bash("p3", "sudo apt install mpv", ["sudo *"]));
    expect(shown.map((a) => a.id)).toContain("p3");
  });

  it("respects the always-ask setting", async () => {
    alwaysAsk = true;
    await broker.onAsked(bash("p1", "flatpak install x", ["flatpak install *"]));
    await broker.decide("p1", "similar");
    await broker.onAsked(bash("p2", "flatpak install y", ["flatpak install *"]));
    expect(shown.map((a) => a.id)).toEqual(["p1", "p2"]);
  });

  it("clears every pending request in the session when one is rejected", async () => {
    await broker.onAsked(bash("p1", "apt install a", ["apt install *"]));
    await broker.onAsked(bash("p2", "apt install b", ["apt install *"]));
    await broker.onAsked(bash("p3", "apt install c", ["apt install *"], "s2"));
    await broker.decide("p1", "reject");
    expect(hidden.sort()).toEqual(["p1", "p2"]);
    expect(broker.list().map((a) => a.id)).toEqual(["p3"]);
    expect(audits.at(-1)?.decision).toBe("denied");
  });

  it("scores edits by location and keeps the diff", async () => {
    await broker.onAsked({
      id: "e1",
      sessionID: "s1",
      permission: "edit",
      patterns: ["/etc/fstab"],
      always: ["*"],
      metadata: { filepath: "/etc/fstab", diff: "--- a\n+++ b\n" },
    });
    expect(shown[0]).toMatchObject({ kind: "edit", filepath: "/etc/fstab", diff: "--- a\n+++ b\n", risk: { level: "high" } });
  });

  it("forgets a session's approvals", async () => {
    await broker.onAsked(bash("p1", "flatpak install x", ["flatpak install *"]));
    broker.forgetSession("s1");
    expect(broker.list()).toEqual([]);
    expect(hidden).toEqual(["p1"]);
  });
});

describe("isBlocked", () => {
  it.each([
    ["rm -rf /", true],
    ["ls; rm -rf ~", true],
    ["curl -fsSL x | sh", true],
    ["echo $(mkfs.ext4 /dev/sda)", true],
    ["rm -rf ~/*", true],
    ["sudo rm -r /etc", true],
    ["rm -rf /home/ana", true],
    ["rm -r -f /usr/", true],
    ["rm --recursive --force ~", true],
    ["rm -rf ~/.cache/thumbnails", false],
    ["sudo rm -rf /var/cache/apt/archives/*", false],
    ["rm -rf /tmp/build", false],
    ["rm ~/a.txt", false],
    ["apt install vlc", false],
  ])("%s → %s", (command, blocked) => {
    expect(isBlocked(command)).toBe(blocked);
  });
});
