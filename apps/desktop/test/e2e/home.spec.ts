import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./app";

let l: Launched;
test.beforeEach(async () => {
  l = await launch();
});
test.afterEach(async () => l.close());

test("home shows live usage, facts with their source, and hands questions to the assistant", async () => {
  const { win } = l;
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible();
  await win.getByRole("button", { name: "Home", exact: true }).click();
  await expect(win.getByRole("heading", { name: "Your computer" })).toBeVisible();
  await expect(win.getByText("About this computer")).toBeVisible();
  await expect(win.getByText("Storage")).toBeVisible();
  await expect(win.getByText("df -h ~")).toBeVisible();
  // Either a recommendation or the all-clear, once the check finishes.
  await expect(win.getByText(/Everything looks healthy|Want me to take care of this\?/)).toBeVisible();
  await expect(win.locator(".insight-chart-stage canvas").first()).toBeVisible();
  await win.waitForTimeout(4500);
  if (process.env["FML_SHOTS"]) await win.screenshot({ path: join(process.env["FML_SHOTS"], "home.png") });

  await win.getByRole("button", { name: "Why is my computer slow?" }).click();
  await expect(win.getByText("Why is my computer slow?").first()).toBeVisible();
  await expect(win.getByRole("heading", { name: "Your computer" })).toBeHidden();
});
