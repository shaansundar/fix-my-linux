import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from "../shared/settings";

/** Settings saved in the app's data folder. */
export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      this.current = sanitizeSettings(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      this.current = DEFAULT_SETTINGS;
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = sanitizeSettings({ ...this.current, ...patch });
    await writeFile(this.file, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    return this.current;
  }
}
