import { expect, test } from "@playwright/test";
import { launch, type Launched } from "./app";

let l: Launched;
test.beforeEach(async () => {
  l = await launch();
});
test.afterEach(async () => l.close());

test("starts, then fixes a full disk with one approval", async () => {
  const { win } = l;
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible();
  await win.getByRole("button", { name: "My disk is almost full" }).click();

  // Read-only checks run on their own and show as chips.
  await expect(win.getByText("df -h").first()).toBeVisible();
  await expect(win.getByText("I'll check how much space is left on your disk.")).toBeVisible();

  // The cleanup asks first, explaining in plain words.
  const card = win.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("I'll clear the thumbnail cache.");
  await expect(card).toContainText("Medium risk");
  await expect(card).toContainText("Deletes or moves files");
  await card.getByRole("button", { name: "Show exactly what will run" }).click();
  await expect(card).toContainText("rm -rf ~/.cache/thumbnails");
  await card.getByRole("button", { name: "Allow", exact: true }).click();

  await expect(win.getByText("Done! I cleared the thumbnail cache.")).toBeVisible();
  await expect(card).toBeHidden();

  // The task list shows the plan.
  await expect(win.getByText("Find what's taking up space")).toBeVisible();
});

test("declining a change keeps the agent polite and stops it", async () => {
  const { win } = l;
  await win.getByRole("button", { name: "My disk is almost full" }).click();
  const card = win.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Don't do this" }).click();
  await expect(win.getByText("No problem, I won't do that.")).toBeVisible();
});

test("the agent can ask a question and act on the answer", async () => {
  const { win } = l;
  await win.getByRole("button", { name: "Install a video player" }).click();
  const q = win.getByTestId("question-card");
  await expect(q).toContainText("Which video player would you like?");
  await expect(q).toContainText("Plays almost any video file");
  await q.getByRole("button", { name: /VLC/ }).click();

  const card = win.getByTestId("approval-card");
  await expect(card).toContainText("I'll install VLC from Flathub");
  await expect(card).toContainText("Installs or updates software");
  // Installing software can be approved in bulk for this chat.
  await expect(card.getByRole("button", { name: "Allow similar" })).toBeVisible();
});

test("activity lists what ran and what was declined", async () => {
  const { win } = l;
  await win.getByRole("button", { name: "My disk is almost full" }).click();
  const card = win.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Don't do this" }).click();
  await expect(win.getByText("No problem, I won't do that.")).toBeVisible();

  await win.getByRole("button", { name: "Activity" }).click();
  await expect(win.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(win.getByText("df -h").first()).toBeVisible();
  await expect(win.getByText("Ran on its own").first()).toBeVisible();
  await expect(win.getByText("rm -rf ~/.cache/thumbnails")).toBeVisible();
  await expect(win.getByText("You declined").first()).toBeVisible();
});

test("past chats appear in the sidebar and reopen", async () => {
  const { win } = l;
  await win.getByRole("button", { name: "Wi-Fi keeps dropping" }).click();
  await expect(win.getByText("I'll check whether your computer can see your Wi-Fi.")).toBeVisible();
  await win.getByRole("button", { name: "New chat" }).first().click();
  await expect(win.getByRole("heading", { name: "What's going on with your computer?" })).toBeVisible();
  await win.getByRole("button", { name: "Fix my computer" }).click();
  await expect(win.getByText("Wi-Fi keeps dropping")).toBeVisible();
});
