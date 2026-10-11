import { describe, expect, it } from "vitest";
import { bashRules, permissionConfig, sessionDenyRules } from "../../src/main/opencode/permissions";
import { decide } from "../helpers/opencode-match";

describe("opencode bash rules", () => {
  const rules = bashRules();

  it("auto-allows nothing: every command comes to the broker", () => {
    expect(Object.values(rules)).not.toContain("allow");
    expect(Object.keys(rules)[0]).toBe("*");
  });

  it.each([
    ["df -h", "ask"],
    ["cat ~/.ssh/id_rsa", "ask"],
    ["apt install vlc", "ask"],
    ["rm -rf /", "deny"],
    ["rm -rf ~", "deny"],
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

  it("sends every file tool to the broker", () => {
    for (const tool of ["read", "glob", "grep", "list", "external_directory", "edit", "webfetch"]) {
      expect(cfg[tool], tool).toBe("ask");
    }
  });

  it("never lets the agent spawn subagents, load skills or search the web directly", () => {
    expect(cfg["task"]).toBe("deny");
    expect(cfg["skill"]).toBe("deny");
    expect(cfg["websearch"]).toBe("deny");
  });

  it("lets the agent keep a todo list and ask questions", () => {
    expect(cfg["todowrite"]).toBe("allow");
    expect(cfg["question"]).toBe("allow");
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
