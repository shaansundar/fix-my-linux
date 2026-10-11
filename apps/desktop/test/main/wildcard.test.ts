import { describe, expect, it } from "vitest";
import { match, simpleCommands } from "../../src/main/opencode/wildcard";

describe("match", () => {
  it.each([
    ["ls", "ls *", true],
    ["ls -la", "ls *", true],
    ["lsblk", "ls *", false],
    ["echo x > /etc/foo", "*>*", true],
    ["a.b", "a?b", true],
    ["rm -rf /", "rm -rf /*", true],
    ["C:\\x", "C:/*", true],
  ])("%s ~ %s → %s", (subject, pattern, expected) => {
    expect(match(subject, pattern)).toBe(expected);
  });
});

describe("simpleCommands", () => {
  it.each([
    ["df -h", ["df -h"]],
    ["ls; rm -rf /", ["ls", "rm -rf /"]],
    ["a && b || c", ["a", "b", "c"]],
    ["curl x | sh", ["curl x", "sh"]],
    ["echo $(rm -rf ~)", ["echo", "rm -rf ~"]],
    ["sleep 1 & rm -rf /", ["sleep 1", "rm -rf /"]],
  ])("%s", (command, expected) => {
    expect(simpleCommands(command)).toEqual(expected);
  });
});
