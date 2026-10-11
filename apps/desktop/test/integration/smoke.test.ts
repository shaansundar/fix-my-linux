import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionDenyRules } from "../../src/main/opencode/permissions";
import { startHarness, type Harness } from "./harness";

describe("opencode smoke", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ logs: !!process.env["FML_IT_LOGS"] });
  }, 60000);
  afterAll(async () => h?.stop());

  it("starts with our config: fixer agent only, no built-in agents", async () => {
    const res = await h.client.app.agents({ directory: h.workDir });
    const names = (res.data ?? []).map((a: { name: string }) => a.name);
    expect(names).toContain("fixer");
    for (const builtin of ["build", "plan", "general", "explore"]) expect(names).not.toContain(builtin);
  });

  it("streams a scripted reply through the fake upstream with the relay nonce", async () => {
    h.zen.script({ text: "Your disk has plenty of space left." });
    const created = await h.client.session.create({ title: "smoke", permission: sessionDenyRules() });
    const sessionID = created.data!.id;
    await h.client.session.promptAsync({
      sessionID,
      agent: "fixer",
      model: { providerID: "opencode", modelID: "fml-fake" },
      parts: [{ type: "text", text: "Is my disk full?" }],
    });
    await h.waitFor(
      (e) => e.type === "session.status" && e.properties.sessionID === sessionID && e.properties.status.type === "idle",
    );
    const parts = h.events
      .filter((e) => e.type === "message.part.updated" && e.properties.sessionID === sessionID)
      .map((e) => (e as { properties: { part: { type: string; text?: string } } }).properties.part);
    expect(parts.some((p) => p.type === "text" && p.text?.includes("plenty of space"))).toBe(true);

    const modelCall = h.zen.requests.find((r) => !r.body.messages.some((m) => String(m.content).includes("title generator")));
    expect(modelCall?.headers["authorization"]).toBe("Bearer test-nonce");
    const system = modelCall?.body.messages.find((m) => m.role === "system");
    expect(String(system?.content)).toContain("You are Fix My Linux");
  });
});
