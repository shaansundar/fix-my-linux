import { app, session, shell, type WebContents } from "electron";

/** Hosts the app may open in the user's browser (billing pages). */
const EXTERNAL_HOSTS = new Set(["checkout.lemonsqueezy.com", "app.lemonsqueezy.com", "lemonsqueezy.com"]);

export function isAllowedExternal(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return EXTERNAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".lemonsqueezy.com");
  } catch {
    return false;
  }
}

export async function openExternalSafely(raw: string): Promise<void> {
  if (!isAllowedExternal(raw)) throw new Error(`refusing to open external url: ${raw}`);
  await shell.openExternal(raw);
}

/** Lock down every web contents the app creates: no navigation, no popups, no webviews. */
export function hardenWebContents(contents: WebContents, devServerUrl?: string): void {
  contents.on("will-navigate", (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

export function installSessionPolicies(): void {
  // The renderer needs no device permissions (camera, mic, notifications...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents, process.env["ELECTRON_RENDERER_URL"]));
}
