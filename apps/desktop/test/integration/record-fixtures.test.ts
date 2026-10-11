/**
 * Records real opencode event streams for the reducer's unit tests.
 * Run with FML_RECORD=1 to refresh test/fixtures/*.json.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2/client";
import { sessionDenyRules } from "../../src/main/opencode/permissions";
import { startHarness, type Harness } from "./harness";

const RECORD = !!process.env["FML_RECORD"];
const FIXTURES = join(__dirname, "../fixtures");

describe.runIf(RECORD)("record fixtures", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  }, 60000);
  afterAll(async () => h?.stop());

  async function run(name: string, prompt: string, turns: Parameters<Harness["zen"]["script"]>, onAsked?: (e: Event) => Promise<void>) {
    const sessionID = (await h.client.session.create({ title: name, permission: sessionDenyRules() })).data!.id;
    h.zen.clear().script(...turns);
    const start = h.events.length;
    await h.client.session.promptAsync({
      sessionID,
      agent: "fixer",
      model: { providerID: "opencode", modelID: "fml-fake" },
      parts: [{ type: "text", text: prompt }],
    });
    const handled = new Set<string>();
    for (;;) {
      const e = await h.waitFor(
        (ev) =>
          (ev.type === "session.status" && ev.properties.sessionID === sessionID && ev.properties.status.type === "idle") ||
          ((ev.type === "permission.asked" || ev.type === "question.asked") &&
            ev.properties.sessionID === sessionID &&
            !handled.has(ev.properties.id)),
        30000,
      );
      if (e.type === "session.status") break;
      handled.add((e as { properties: { id: string } }).properties.id);
      await onAsked?.(e);
    }
    await new Promise((r) => setTimeout(r, 300));
    const events = h.events
      .slice(start)
      .filter((e) => "properties" in e && (e.properties as { sessionID?: string }).sessionID === sessionID);
    await writeFile(join(FIXTURES, `${name}.json`), JSON.stringify({ sessionID, events }, null, 1));
  }

  it("basic: reasoning, text, an auto-run command and a todo list", async () => {
    await run("basic", "my disk is full", [
      {
        text: "I'll make a short plan.",
        tools: [{ name: "todowrite", args: { todos: [
          { content: "Check disk space", status: "in_progress", priority: "high" },
          { content: "Clear old caches", status: "pending", priority: "medium" },
        ] } }],
      },
      { reasoning: "Need df output first.", text: "I'll check how much space is left on your disk.", tools: [{ name: "bash", args: { command: "df -h" } }] },
      { text: "Your disk is 93% full. The biggest folder is your Downloads." },
    ]);
  });

  it("approval: a command that needs approval, approved", async () => {
    await run(
      "approval",
      "install vlc",
      [
        { text: "I'll install VLC so you can play that video.", tools: [{ name: "bash", args: { command: "echo installing-vlc > /dev/null" } }] },
        { text: "VLC is installed." },
      ],
      async (e) => {
        if (e.type === "permission.asked") await h.client.permission.reply({ requestID: e.properties.id, reply: "once" });
      },
    );
  });

  it("question: the agent asks the user to choose", async () => {
    await run(
      "question",
      "I want a video player",
      [
        {
          text: "There are two good options.",
          tools: [{ name: "question", args: { questions: [{
            question: "Which video player would you like?",
            header: "Player",
            options: [
              { label: "VLC", description: "Plays almost anything" },
              { label: "Celluloid", description: "Simple and clean" },
            ],
          }] } }],
        },
        { text: "Great, VLC it is." },
      ],
      async (e) => {
        if (e.type === "question.asked") await h.client.question.reply({ requestID: e.properties.id, answers: [["VLC"]] });
      },
    );
  });

  it("rejected: the user declines", async () => {
    await run(
      "rejected",
      "remove libreoffice",
      [{ text: "I'll remove LibreOffice.", tools: [{ name: "bash", args: { command: "apt remove libreoffice" } }] }],
      async (e) => {
        if (e.type === "permission.asked") await h.client.permission.reply({ requestID: e.properties.id, reply: "reject" });
      },
    );
  });
});
