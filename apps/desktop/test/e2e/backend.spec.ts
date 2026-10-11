/**
 * Cross-stack: the real Go backend (in-memory dev mode) between the real app
 * and a scripted model upstream. Sign-in uses the code the server logs.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { FakeZen } from "../../src/main/dev/fake-zen";
import { demoBrain } from "../../src/main/dev/demo-brain";
import { launch, type Launched } from "./app";

const SERVER_DIR = resolve(__dirname, "../../../../server");

let bin: string;
let zen: FakeZen;
let catalog: Server;
let api: ChildProcess;
let apiURL: string;
let logs = "";
let app: Launched;

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => res(port));
    });
  });
}

const CATALOG = {
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    env: ["OPENCODE_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/zen/v1",
    models: {
      "big-pickle": {
        id: "big-pickle", name: "Big Pickle", family: "x", attachment: false, reasoning: false, tool_call: true, temperature: true,
        release_date: "2026-01-01", last_updated: "2026-01-01", modalities: { input: ["text"], output: ["text"] }, open_weights: false,
        cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 },
      },
    },
  },
};

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "fml-api-"));
  bin = join(dir, "api");
  execFileSync("go", ["build", "-o", bin, "./cmd/api"], { cwd: SERVER_DIR });

  zen = new FakeZen().respondWith(demoBrain);
  const zenURL = await zen.start();
  catalog = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CATALOG));
  });
  await new Promise<void>((r) => catalog.listen(0, "127.0.0.1", r));
  const catalogURL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}/api.json`;

  const port = await freePort();
  apiURL = `http://127.0.0.1:${port}`;
  api = spawn(bin, [], {
    env: {
      ...process.env,
      PORT: String(port),
      FML_DEV_MEMORY: "1",
      ZEN_API_KEY: "zen-test",
      ZEN_BASE_URL: `${zenURL}/zen/v1`,
      MODELS_URL: catalogURL,
      CODE_SECRET: "c".repeat(32),
      MACHINE_HMAC_SECRET: "m".repeat(32),
      // ~20 seconds, so the test can watch the trial end.
      TRIAL_DAYS: String(20 / 86400),
    },
  });
  api.stdout!.on("data", (d) => (logs += String(d)));
  api.stderr!.on("data", (d) => (logs += String(d)));
  await expect.poll(async () => (await fetch(`${apiURL}/healthz`).catch(() => null))?.status, { timeout: 30_000 }).toBe(200);
  rmSync(dir, { recursive: true, force: true });
});

test.afterAll(async () => {
  api?.kill();
  await zen?.stop();
  catalog?.close();
});

test.beforeEach(async () => {
  app = await launch({ FML_DEMO: "", FML_API_BASE: apiURL });
});
test.afterEach(async () => app.close());

/** FML_SHOTS=<dir> saves screenshots of key screens for visual review. */
async function shot(win: Launched["win"], name: string): Promise<void> {
  const dir = process.env["FML_SHOTS"];
  if (dir) await win.screenshot({ path: join(dir, `${name}.png`) });
}

function codeFor(email: string): string {
  const line = logs
    .split("\n")
    .filter((l) => l.includes("sign-in code") && l.includes(email))
    .at(-1);
  if (!line) throw new Error(`no code logged for ${email}`);
  return (JSON.parse(line) as { code: string }).code;
}

test("signs in with an emailed code, chats through the backend, and hits the paywall when the trial ends", async () => {
  const { win } = app;
  const email = `ana+${Date.now()}@example.com`;

  await expect(win.getByRole("heading", { name: "Fix your computer by describing the problem" })).toBeVisible();
  await shot(win, "signin-email");
  await win.getByLabel("Your email").fill(email);
  await win.getByRole("button", { name: "Email me a code" }).click();
  await expect(win.getByText("We sent a 6-digit code")).toBeVisible();
  await shot(win, "signin-code");
  await expect.poll(() => logs.includes(email)).toBe(true);
  await win.getByLabel("Code").fill(codeFor(email));
  await win.getByRole("button", { name: "Continue" }).click();

  // Signed in on the free trial; the chat works through the backend proxy.
  await expect(win.getByTestId("usage-meter")).toContainText("Free trial");
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible({ timeout: 30_000 });
  await shot(win, "trial-home");
  await win.getByRole("button", { name: "My disk is almost full" }).click();
  await expect(win.getByText("I'll check how much space is left on your disk.")).toBeVisible();
  expect(zen.requests.some((r) => r.headers["authorization"] === "Bearer zen-test")).toBe(true);
  await win.getByTestId("approval-card").getByRole("button", { name: "Don't do this" }).click();
  await expect(win.getByText("No problem, I won't do that.")).toBeVisible();

  // After the (shortened) trial ends, the next request shows the paywall.
  await win.waitForTimeout(21_000);
  await win.getByRole("button", { name: "New chat" }).first().click();
  await win.getByRole("button", { name: "There's no sound" }).click();
  const notice = win.getByTestId("plan-notice");
  await expect(notice).toContainText("Your free trial has ended");
  await expect(notice.getByRole("button", { name: "Subscribe", exact: true })).toBeVisible();
  await expect(win.getByTestId("usage-meter")).toContainText("Trial ended");
  // The card explains it once; the composer waits until they subscribe.
  await expect(win.getByText("Your free trial has ended. Subscribe to keep using Fix My Linux.")).toHaveCount(0);
  await expect(win.getByLabel("Prompt")).toBeDisabled();
  await shot(win, "paywall");
});

test("signing out returns to the sign-in screen", async () => {
  const { win } = app;
  const email = `bob+${Date.now()}@example.com`;
  await win.getByLabel("Your email").fill(email);
  await win.getByRole("button", { name: "Email me a code" }).click();
  await expect.poll(() => logs.includes(email)).toBe(true);
  await win.getByLabel("Code").fill(codeFor(email));
  await win.getByRole("button", { name: "Continue" }).click();
  await expect(win.getByTestId("usage-meter")).toBeVisible();

  await win.getByRole("button", { name: email }).click();
  await win.getByRole("button", { name: "Sign out" }).click();
  await expect(win.getByRole("heading", { name: "Fix your computer by describing the problem" })).toBeVisible();
});
