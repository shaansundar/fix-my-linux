import { join } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
import type { AccountState } from "../shared/account";
import { CH, type EngineState } from "../shared/ipc";
import { AccountService, ApiError, type Vault } from "./account";
import type { FakeZen } from "./dev/fake-zen";
import { Engine, type EngineMode } from "./engine";
import { registerIpc } from "./ipc";
import { needsAccount, resolveMode } from "./mode";
import { dataDir, isFlatpak, resourcesDir, runtimeDir, userHome } from "./paths";
import { installSessionPolicies, openExternalSafely } from "./security";
import { SettingsStore } from "./settings";
import { facts, health, Sampler } from "./system";
import type { SystemSample } from "../shared/system";

app.enableSandbox();

let win: BrowserWindow | null = null;
let engine: Engine | null = null;
let demoUpstream: FakeZen | null = null;
let engineState: EngineState = { state: "starting" };
let mode: EngineMode | null = null;
let account: AccountService | null = null;
let accountState: AccountState = { status: "signed-out", weakStorage: false };
let settings: SettingsStore | null = null;
/** Which model list the running engine has; only free ↔ paid needs a restart. */
let enginePlan: "free" | "paid" | null = null;
const modelsFor = (s: AccountState): "free" | "paid" => (s.account?.state === "active" ? "paid" : "free");

function send(channel: string, value: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function setEngineState(s: EngineState): void {
  engineState = s;
  send(CH.engineOnState, s);
}

const electronVault: Vault = {
  available: () => safeStorage.isEncryptionAvailable(),
  weak: () => process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text",
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data),
};

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
      // E2E runs keep animating while the window is in the background, so
      // screenshots show settled colors. Users keep the battery-friendly default.
      backgroundThrottling: process.env["FML_E2E"] !== "1",
    },
  });
  w.once("ready-to-show", () => w.show());
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
  return w;
}

async function stopEngine(): Promise<void> {
  await engine?.stop();
  engine = null;
  enginePlan = null;
}

/** Starts are serialized: sign-in, plan changes and restarts can overlap. */
let lifecycle: Promise<void> = Promise.resolve();
function startEngine(): Promise<void> {
  lifecycle = lifecycle.then(async () => {
    try {
      await startEngineUnsafe();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("engine failed to start:", message);
      setEngineState({ state: "error", message });
    }
  });
  return lifecycle;
}

async function startEngineUnsafe(): Promise<void> {
  await stopEngine();
  await demoUpstream?.stop();
  demoUpstream = null;
  const resolved = await resolveMode(process.env, dataDir());
  mode = resolved.mode;
  demoUpstream = resolved.demo;
  if (needsAccount(mode) && !account?.deviceToken) {
    setEngineState({ state: "signed-out" });
    return;
  }
  enginePlan = modelsFor(accountState);
  engine = new Engine({
    mode,
    resourcesDir: resourcesDir(),
    dataDir: dataDir(),
    privateDir: app.getPath("userData"),
    home: userHome(),
    flatpak: isFlatpak(),
    askpassSocket: join(runtimeDir(), "askpass.sock"),
    deviceToken: () => account?.deviceToken ?? null,
    alwaysAsk: () => settings?.get().alwaysAsk ?? false,
    emit: {
      state: (s) => setEngineState(s),
      event: (e) => send(CH.chatEvent, e),
      approvals: (p) => send(CH.approvalsChange, p),
      activity: (e) => send(CH.activityEntry, e),
      blocked: (n) => {
        send(CH.blocked, n);
        // A paywall or budget notice means the account changed; pick it up.
        void account?.refresh().catch(() => undefined);
      },
      passwords: (p) => send(CH.passwordChange, p),
    },
    log: (line) => {
      if (!app.isPackaged) console.log(line);
    },
  });
  await engine.start();
}

/** Reacts to sign-in, sign-out and plan changes. */
function onAccount(next: AccountState): void {
  const before = accountState;
  accountState = next;
  send(CH.accountChange, next);
  if (!mode || !needsAccount(mode)) return;
  if (next.status === "signed-out" && before.status !== "signed-out") {
    lifecycle = lifecycle.then(stopEngine).then(() => setEngineState({ state: "signed-out" }));
  } else if (next.status === "signed-in" && !engine) {
    void startEngine();
  } else if (next.status === "signed-in" && engine && modelsFor(next) !== enginePlan) {
    // Trial → paid (or back): the model list changed.
    void startEngine();
  }
}

/** After opening checkout, watch for the subscription to become active. */
let watching: ReturnType<typeof setInterval> | null = null;
function watchForSubscription(): void {
  if (watching) clearInterval(watching);
  const until = Date.now() + 15 * 60_000;
  watching = setInterval(() => {
    if (Date.now() > until || accountState.account?.state === "active") {
      if (watching) clearInterval(watching);
      watching = null;
      return;
    }
    void account?.refresh().catch(() => undefined);
  }, 5000);
}

function friendly(err: unknown): never {
  if (err instanceof ApiError) throw new Error(err.message);
  if (err instanceof TypeError) throw new Error("Couldn't reach Fix My Linux. Check your internet connection and try again.");
  throw err;
}

function applyZoom(): void {
  const zoom = settings?.get().zoom ?? 100;
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom / 100);
}

app.whenReady().then(async () => {
  installSessionPolicies();
  settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  await settings.load();
  const resolved = await resolveMode(process.env, dataDir());
  mode = resolved.mode;
  await resolved.demo?.stop();
  if (mode.kind === "backend") {
    account = new AccountService({
      apiBase: mode.apiBase,
      tokenFile: join(app.getPath("userData"), "session.bin"),
      vault: electronVault,
      onChange: onAccount,
    });
  }

  // Live usage for the Home screen: a two-minute rolling window, sampled every 2s.
  const sampler = new Sampler(userHome());
  const samples: SystemSample[] = [];
  setInterval(() => {
    void sampler.sample().then((s) => {
      samples.push(s);
      if (samples.length > 60) samples.shift();
      send(CH.systemSample, s);
    });
  }, 2000);

  registerIpc(() => win, () => engine, {
    restart: startEngine,
    state: () => engineState,
    system: { facts: () => facts(userHome(), isFlatpak()), health: () => health(userHome(), isFlatpak()), history: () => samples },
    settings: {
      get: () => settings!.get(),
      update: async (patch) => {
        const next = await settings!.update(patch && typeof patch === "object" ? (patch as object) : {});
        applyZoom();
        return next;
      },
    },
    account: {
      state: () => accountState,
      start: (email) => account!.startSignIn(email).catch(friendly),
      verify: async (email, code) => {
        await account!.verify(email, code).catch(friendly);
      },
      subscribe: async () => {
        const url = await account!.checkoutURL().catch(friendly);
        await openExternalSafely(url);
        watchForSubscription();
      },
      manage: async () => {
        const url = await account!.portalURL().catch(friendly);
        await openExternalSafely(url);
      },
      refresh: async () => {
        await account?.refresh().catch(friendly);
      },
      signOut: async () => {
        await account?.signOut();
      },
    },
  });
  win = createWindow();
  win.on("closed", () => (win = null));
  win.webContents.on("did-finish-load", applyZoom);

  if (account) await account.restore();
  // restore() starts the engine itself when a saved sign-in works; offline
  // starts try anyway and show a retry if the server can't be reached.
  if (!account || accountState.status !== "signed-in") await startEngine();

  // Keep the usage meter fresh.
  setInterval(() => {
    if (accountState.status !== "signed-out") void account?.refresh().catch(() => undefined);
  }, 60_000);

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
