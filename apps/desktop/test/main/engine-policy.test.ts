import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { policyFor } from "../../src/main/engine";
import { evaluateCommand, evaluatePathTool } from "../../src/main/safety/policy";

const home = mkdtempSync(join(tmpdir(), "fml-ep-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const privateDir = join(home, ".config/Fix My Linux");

describe("policyFor", () => {
  const ctx = policyFor({ home, privateDir, flatpak: false });

  it.each(["session.bin", "settings.json", "engine/audit.jsonl", "Local Storage/leveldb/000003.log"])(
    "asks before the agent reads the app's %s",
    (file) => {
      expect(evaluateCommand(`cat "${join(privateDir, file)}"`, ctx).action).toBe("ask");
      expect(evaluatePathTool("read", join(privateDir, file), ctx).action).toBe("ask");
    },
  );

  it("runs commands in the home folder", () => {
    expect(ctx.cwd).toBe(home);
  });

  it("marks the Flatpak build as sandboxed", () => {
    expect(policyFor({ home, privateDir, flatpak: true }).sandboxed).toBe(true);
    expect(ctx.sandboxed).toBe(false);
  });
});
