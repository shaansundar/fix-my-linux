import { describe, expect, it } from "vitest";
import { bashRules, permissionConfig, sessionDenyRules } from "../../src/main/opencode/permissions";
import { decide } from "../helpers/opencode-match";

describe("bash ruleset", () => {
  const rules = bashRules();

  it("starts with the ask catch-all so later rules override it", () => {
    expect(Object.keys(rules)[0]).toBe("*");
    expect(rules["*"]).toBe("ask");
  });

  it.each([
    // read-only diagnostics run
    ["df -h", "allow"],
    ["ls -la /etc", "allow"],
    ["cat /etc/os-release", "allow"],
    ["systemctl status NetworkManager", "allow"],
    ["journalctl -b -p err --no-pager", "allow"],
    ["nmcli device status", "allow"],
    ["ping -c 3 1.1.1.1", "allow"],
    ["id", "allow"],
    // anything else asks
    ["apt install vlc", "ask"],
    ["systemctl restart NetworkManager", "ask"],
    ["rm ~/Downloads/big.iso", "ask"],
    ["identify image.png", "ask"],
    // re-ask overrides beat allows
    ["echo hello > /etc/motd", "ask"],
    ["cat a > ~/.bashrc", "ask"],
    ["sudo apt update", "ask"],
    ["find / -name '*.log' -delete", "ask"],
    ["find ~ -exec rm {} ;", "ask"],
    ["journalctl --vacuum-size=100M", "ask"],
    ["tail -f /var/log/syslog", "ask"],
    ["cat ~/.ssh/id_rsa", "ask"],
    ["echo $OPENCODE_SERVER_PASSWORD", "ask"],
    ["nmcli --show-secrets connection show home", "ask"],
    // denies
    ["rm -rf /", "deny"],
    ["rm -rf ~", "deny"],
    ["rm -rf ~/", "deny"],
    ["mkfs.ext4 /dev/sda1", "deny"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "deny"],
    ["sh", "deny"],
    ["bash -s", "deny"],
    ["shutdown -h now", "deny"],
  ])("%s → %s", (command, expected) => {
    expect(decide(rules, command)).toBe(expected);
  });
});

describe("permission config", () => {
  const cfg = permissionConfig();

  it("never lets the agent spawn subagents or search the web directly", () => {
    expect(cfg["task"]).toBe("deny");
    expect(cfg["websearch"]).toBe("deny");
  });

  it("asks before edits and web fetches", () => {
    expect(cfg["edit"]).toBe("ask");
    expect(cfg["webfetch"]).toBe("ask");
  });

  it("asks before reading secrets", () => {
    const read = cfg["read"] as Record<string, string>;
    expect(decide(read, "/home/ana/.ssh/id_ed25519")).toBe("ask");
    expect(decide(read, "/home/ana/Documents/notes.txt")).toBe("allow");
  });

  it("allows system config reads outside home but still guards secrets", () => {
    const ext = cfg["external_directory"] as Record<string, string>;
    expect(decide(ext, "/etc/fstab")).toBe("allow");
    expect(decide(ext, "/var/log/syslog")).toBe("allow");
    expect(decide(ext, "/root/secret")).toBe("ask");
  });
});

describe("session deny rules", () => {
  it("mirrors every bash deny and blocks task", () => {
    const rules = sessionDenyRules();
    expect(rules.every((r) => r.action === "deny")).toBe(true);
    expect(rules).toContainEqual({ permission: "task", pattern: "*", action: "deny" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "rm -rf /", action: "deny" });
  });
});
