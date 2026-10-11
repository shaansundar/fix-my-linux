import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

export type Launched = { app: ElectronApplication; win: Page; close(): Promise<void> };

/** Launches the built app in demo mode with throwaway user data. */
export async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const userData = await mkdtemp(join(tmpdir(), "fml-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    env: { ...process.env, FML_DEMO: "1", ...env } as Record<string, string>,
  });
  const win = await app.firstWindow();
  return {
    app,
    win,
    async close() {
      await app.close();
      await rm(userData, { recursive: true, force: true });
    },
  };
}
