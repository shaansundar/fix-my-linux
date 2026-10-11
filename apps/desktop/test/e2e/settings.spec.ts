import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./app";

let l: Launched;
test.beforeEach(async () => {
  l = await launch();
});
test.afterEach(async () => l.close());

test("settings change the theme and make every change ask", async () => {
  const { win } = l;
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible();
  await win.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(win.getByRole("heading", { name: "Settings" })).toBeVisible();

  await win.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(win.locator("html")).toHaveClass(/dark/);
  if (process.env["FML_SHOTS"]) {
    await win.waitForTimeout(800);
    await win.screenshot({ path: join(process.env["FML_SHOTS"], "settings-dark.png") });
  }
  await win.getByRole("button", { name: "Light", exact: true }).click();
  await expect(win.locator("html")).not.toHaveClass(/dark/);

  // "Ask every time" turns off remembered "Allow similar" approvals in the broker.
  await win.getByRole("button", { name: "Ask every time" }).click();
  await expect(win.getByRole("button", { name: "Ask every time" })).toHaveAttribute("aria-pressed", "true");
});
