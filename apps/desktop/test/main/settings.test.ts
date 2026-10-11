import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/main/settings";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/shared/settings";

describe("settings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fml-set-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it.each([
    [{}, DEFAULT_SETTINGS],
    [{ theme: "dark", zoom: 120, alwaysAsk: true, model: "claude-haiku-4-5" }, { theme: "dark", zoom: 120, alwaysAsk: true, model: "claude-haiku-4-5" }],
    [{ theme: "neon", zoom: 999, alwaysAsk: "yes", model: 5 }, DEFAULT_SETTINGS],
    [null, DEFAULT_SETTINGS],
  ])("sanitizes %j", (raw, want) => {
    expect(sanitizeSettings(raw)).toEqual(want);
  });

  it("persists updates and survives a corrupt file", async () => {
    const file = join(dir, "settings.json");
    const s = new SettingsStore(file);
    expect(await s.load()).toEqual(DEFAULT_SETTINGS);
    await s.update({ alwaysAsk: true, zoom: 110 });
    expect(await new SettingsStore(file).load()).toMatchObject({ alwaysAsk: true, zoom: 110 });
    await writeFile(file, "{not json");
    expect(await new SettingsStore(file).load()).toEqual(DEFAULT_SETTINGS);
  });
});
