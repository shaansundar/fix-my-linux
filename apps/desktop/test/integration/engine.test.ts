import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry, PendingApproval } from "../../src/shared/approvals";
import type { BlockedNotice, EngineState } from "../../src/shared/ipc";
import type { OpencodeEvent } from "../../src/shared/session";
import { Engine } from "../../src/main/engine";
import { FakeZen, fakeCatalog } from "../helpers/fake-zen";
import { RESOURCES } from "./harness";

function until<T>(get: () => T | undefined, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("Engine (real opencode, fake Zen)", () => {
  const zen = new FakeZen();
  let dir: string;
  let engine: Engine;
  const states: EngineState[] = [];
  const events: OpencodeEvent[] = [];
  let approvals: PendingApproval[] = [];
  const activity: AuditEntry[] = [];
  const blocked: BlockedNotice[] = [];

  beforeAll(async () => {
    const url = await zen.start();
    dir = await mkdtemp(join(tmpdir(), "fml-engine-"));
    const catalogFile = join(dir, "catalog.json");
    await writeFile(
      catalogFile,
      JSON.stringify({
        provider: (fakeCatalog() as { opencode: unknown }).opencode,
        plan: { defaultModel: "fml-fake", smallModel: "fml-fake", allowed: ["fml-fake"] },
      }),
    );
    engine = new Engine({
      mode: { kind: "custom", upstreamURL: `${url}/zen/v1`, upstreamKey: "dev-key", catalogFile },
      resourcesDir: RESOURCES,
      dataDir: join(dir, "data"),
      home: dir,
      flatpak: false,
      askpassSocket: join(dir, "askpass.sock"),
      deviceToken: () => null,
      alwaysAsk: () => false,
      emit: {
        state: (s) => states.push(s),
        event: (e) => events.push(e),
        approvals: (p) => (approvals = p),
        activity: (e) => activity.push(e),
        blocked: (n) => blocked.push(n),
      },
    });
    await engine.start();
  }, 60000);

  afterAll(async () => {
    await engine?.stop();
    await zen.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("starts and reports ready", () => {
    expect(engine.getState()).toEqual({ state: "ready" });
    expect(states.map((s) => s.state)).toEqual(["starting", "ready"]);
    expect(engine.models()).toEqual([{ id: "fml-fake", name: "Fake", free: true, recommended: true }]);
  });

  it("relays model calls with the upstream key, never the nonce", async () => {
    zen.clear().script({ text: "Hello! How can I help?" });
    const id = await engine.createSession();
    await engine.send(id, "hi");
    await until(() => events.find((e) => e.type === "session.status" && (e.properties as any).status.type === "idle" && (e.properties as any).sessionID === id));
    const call = zen.requests.at(-1)!;
    expect(call.headers["authorization"]).toBe("Bearer dev-key");
    const view = await engine.openSession(id);
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("asks before changing the system, with the agent's sentence and a risk score", async () => {
    zen
      .clear()
      .script(
        { text: "I'll install VLC so you can play that video.", tools: [{ name: "bash", args: { command: "flatpak install -y flathub org.videolan.VLC" } }] },
        { text: "VLC is ready." },
      );
    const id = await engine.createSession();
    await engine.send(id, "install vlc");
    const card = await until(() => approvals.find((a) => a.sessionID === id));
    expect(card).toMatchObject({
      kind: "command",
      command: "flatpak install -y flathub org.videolan.VLC",
      explanation: "I'll install VLC so you can play that video.",
      risk: { level: "medium", reasons: ["Installs or updates software"] },
      canAllowSimilar: true,
    });

    await engine.decide(card.id, "reject");
    await until(() => (approvals.some((a) => a.id === card.id) ? undefined : true));
    await until(() => activity.find((a) => a.decision === "denied" && a.subject.includes("VLC")));
    // A reject with a message is feedback: the agent continues and explains.
    await until(() =>
      [...events].reverse().find((e) => e.type === "session.status" && (e.properties as any).sessionID === id && (e.properties as any).status.type === "idle"),
    );
    const view = await engine.openSession(id);
    const last = view.messages.at(-1);
    expect(last?.role === "assistant" && last.items.some((i) => i.kind === "text" && i.text === "VLC is ready.")).toBe(true);
  });

  it("logs commands that ran on their own, with exit codes", async () => {
    zen.clear().script({ text: "I'll check your disk.", tools: [{ name: "bash", args: { command: "df -h" } }] }, { text: "Plenty of room." });
    const id = await engine.createSession();
    await engine.send(id, "disk?");
    const entry = await until(() => activity.find((a) => a.sessionID === id && a.decision === "auto-ran"));
    expect(entry).toMatchObject({ subject: "df -h", outcome: "succeeded", exitCode: 0, risk: "low" });
  });

  it("blocks catastrophic commands without ever showing them", async () => {
    zen.clear().script({ text: "Cleaning up.", tools: [{ name: "bash", args: { command: "rm -rf /" } }] }, { text: "I couldn't do that." });
    const id = await engine.createSession();
    await engine.send(id, "delete everything");
    await until(() => events.find((e) => e.type === "session.status" && (e.properties as any).status.type === "idle" && (e.properties as any).sessionID === id));
    expect(approvals.filter((a) => a.sessionID === id)).toEqual([]);
    const toolError = await until(() =>
      events.find(
        (e) => e.type === "message.part.updated" && (e.properties as any).sessionID === id && (e.properties as any).part.state?.status === "error",
      ),
    );
    expect(JSON.stringify(toolError)).toMatch(/blocked|denied|prevents/i);
  });

  it("surfaces a paywall from the upstream", async () => {
    zen.clear().failWith = { status: 402, body: { error: { code: "trial_ended", message: "Your free trial has ended." } } };
    try {
      const id = await engine.createSession();
      await engine.send(id, "hi");
      const notice = await until(() => blocked.find((b) => b.code === "trial_ended"));
      expect(notice).toMatchObject({ status: 402, message: "Your free trial has ended." });
    } finally {
      zen.failWith = null;
    }
  });

  it("lists sessions newest first", async () => {
    const sessions = await engine.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    expect([...sessions].sort((a, b) => b.updatedAt - a.updatedAt)).toEqual(sessions);
  });
});
