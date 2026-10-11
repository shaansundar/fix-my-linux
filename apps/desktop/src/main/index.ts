import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { CH, type EngineState } from "../shared/ipc";
import type { FakeZen } from "./dev/fake-zen";
import { Engine } from "./engine";
import { registerIpc } from "./ipc";
import { needsAccount, resolveMode } from "./mode";
import { dataDir, isFlatpak, resourcesDir, runtimeDir, userHome } from "./paths";
import { installSessionPolicies } from "./security";

app.enableSandbox();

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let demoUpstream: FakeZen | null = null;
let engineState: EngineState = { state: "starting" };

function setEngineState(s: EngineState): void {
  engineState = s;
  send(CH.engineOnState, s);
}

function send(channel: string, value: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: "Fix My Linux",
    backgroundColor: "#f9f9fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  w.once("ready-to-show", () => w.show());
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
  return w;
}

async function startEngine(): Promise<void> {
  try {
    await startEngineUnsafe();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("engine failed to start:", message);
    setEngineState({ state: "error", message });
  }
}

async function startEngineUnsafe(): Promise<void> {
  await engine?.stop();
  await demoUpstream?.stop();
  demoUpstream = null;
  const { mode, demo } = await resolveMode(process.env, dataDir());
  demoUpstream = demo;
  // Accounts arrive with the backend; until then only token-free modes start.
  const token: string | null = null;
  if (needsAccount(mode) && !token) {
    engine = null;
    setEngineState({ state: "signed-out" });
    return;
  }
  engine = new Engine({
    mode,
    resourcesDir: resourcesDir(),
    dataDir: dataDir(),
    home: userHome(),
    flatpak: isFlatpak(),
    askpassSocket: join(runtimeDir(), "askpass.sock"),
    deviceToken: () => token,
    alwaysAsk: () => false,
    emit: {
      state: (s) => setEngineState(s),
      event: (e) => send(CH.chatEvent, e),
      approvals: (p) => send(CH.approvalsChange, p),
      activity: (e) => send(CH.activityEntry, e),
      blocked: (n) => send(CH.blocked, n),
      passwords: (p) => send(CH.passwordChange, p),
    },
    log: (line) => {
      if (!app.isPackaged) console.log(line);
    },
  });
  await engine.start();
}

app.whenReady().then(async () => {
  installSessionPolicies();
  registerIpc(() => win, () => engine, { restart: startEngine, state: () => engineState });
  win = createWindow();
  win.on("closed", () => (win = null));
  await startEngine();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !engine) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([engine.stop(), demoUpstream?.stop()]).finally(() => app.quit());
});
