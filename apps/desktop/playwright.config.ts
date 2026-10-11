import { defineConfig } from "@playwright/test";

/** E2E against the built app (`pnpm build` first) in offline demo mode. */
export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
