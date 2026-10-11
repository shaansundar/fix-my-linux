import { mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { app } from "electron";

/** Bundled resources: the repo's resources/ in development, process.resourcesPath when packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "resources") : join(app.getAppPath(), "resources");
}

export function dataDir(): string {
  return join(app.getPath("userData"), "engine");
}

export function isFlatpak(): boolean {
  return !!process.env["FLATPAK_ID"];
}

/** A private (0700) runtime directory for the askpass socket. */
export function runtimeDir(): string {
  const base = process.env["XDG_RUNTIME_DIR"] ?? join(tmpdir(), `fml-${userInfo().uid}`);
  const dir = join(base, isFlatpak() ? `app/${process.env["FLATPAK_ID"]}` : "fix-my-linux");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function userHome(): string {
  return process.env["HOME"] ?? homedir();
}
