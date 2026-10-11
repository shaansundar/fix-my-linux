import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./app";

let l: Launched;
test.beforeEach(async () => {
  l = await launch();
});
test.afterEach(async () => l.close());

test("Ctrl+K starts a quick fix", async () => {
  const { win } = l;
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible();
  await win.keyboard.press("Control+k");
  const palette = win.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox", { name: "Search" }).fill("disk");
  await palette.getByRole("textbox", { name: "Search" }).press("Enter");
  await expect(palette).toBeHidden();
  await expect(win.getByText("I'll check how much space is left on your disk.")).toBeVisible();
});

test("selecting text offers to explain it", async () => {
  const { win } = l;
  await win.getByRole("button", { name: "Wi-Fi keeps dropping" }).click();
  const line = win.getByText("I'll check whether your computer can see your Wi-Fi.");
  await expect(line).toBeVisible();
  await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
  });
  const bar = win.getByTestId("selection-bar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Explain this" }).click();
  await expect(win.getByText(/Can you explain this in plain words\?/)).toBeVisible();
});
