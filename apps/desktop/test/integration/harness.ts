import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpencodeClient, type Event, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { binaryPath, pickVariant } from "../../src/main/opencode/binary";
import { buildConfig, type ModelPlan } from "../../src/main/opencode/config";
import { buildOpencodeEnv } from "../../src/main/opencode/env";
import { OpencodeProcess } from "../../src/main/opencode/process";
import { FakeZen, fakeCatalog } from "../helpers/fake-zen";

export const RESOURCES = resolve(__dirname, "../../resources");

export function opencodeBinary(): string {
  return binaryPath(RESOURCES, pickVariant(process.platform, process.arch, ""));
}

export type Harness = {
  zen: FakeZen;
  proc: OpencodeProcess;
  client: OpencodeClient;
  workDir: string;
  events: Event[];
  /** Resolves with the first event matching `pred` (including ones already seen). */
  waitFor<T extends Event>(pred: (e: Event) => e is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (e: Event) => boolean, timeoutMs?: number): Promise<Event>;
  stop(): Promise<void>;
};

export async function startHarness(options: { plan?: ModelPlan; logs?: boolean } = {}): Promise<Harness> {
  const zen = new FakeZen();
  const zenURL = await zen.start();
  // Mirrors production, where opencode's working directory is the user's home,
  // without letting tests touch the real one.
  const workDir = await mkdtemp(join(tmpdir(), "fml-it-"));
  const modelsPath = join(workDir, "models.json");
  await writeFile(modelsPath, JSON.stringify(fakeCatalog()));

  const plan = options.plan ?? { defaultModel: "fml-fake", smallModel: "fml-fake", allowed: ["fml-fake"] };
  const password = randomBytes(16).toString("hex");
  const config = buildConfig({
    relayOrigin: zenURL,
    relayNonce: "test-nonce",
    plan,
    promptFile: join(RESOURCES, "prompts/fixer.md"),
    shellPath: join(RESOURCES, "shell/bash"),
  });
  const env = buildOpencodeEnv({
    base: { ...process.env, HOME: workDir },
    dataDir: join(workDir, "data"),
    serverPassword: password,
    configContent: JSON.stringify(config),
    modelsPath,
    askpassSocket: join(workDir, "askpass.sock"),
    askpassBin: join(RESOURCES, "bin/darwin-arm64/fml-askpass"),
    shellDir: join(RESOURCES, "shell"),
    flatpak: false,
  });

  const proc = await OpencodeProcess.start({
    binary: opencodeBinary(),
    env,
    cwd: workDir,
    onLog: options.logs ? (l) => console.log("[opencode]", l) : undefined,
  });
  const client = createOpencodeClient({
    baseUrl: proc.url,
    directory: workDir,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });

  const events: Event[] = [];
  const waiters = new Set<{ pred: (e: Event) => boolean; resolve: (e: Event) => void }>();
  const abort = new AbortController();
  const sub = await client.event.subscribe({ directory: workDir }, { signal: abort.signal });
  void (async () => {
    try {
      for await (const e of sub.stream) {
        events.push(e as Event);
        for (const w of waiters) {
          if (w.pred(e as Event)) {
            waiters.delete(w);
            w.resolve(e as Event);
          }
        }
      }
    } catch {
      // stream closed on stop
    }
  })();

  function waitFor(pred: (e: Event) => boolean, timeoutMs = 20000): Promise<Event> {
    const seen = events.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.add(w);
      setTimeout(() => {
        if (waiters.delete(w)) reject(new Error(`timed out waiting for event; saw: ${events.map((e) => e.type).join(", ")}`));
      }, timeoutMs);
    });
  }

  return {
    zen,
    proc,
    client,
    workDir,
    events,
    waitFor: waitFor as Harness["waitFor"],
    async stop() {
      abort.abort();
      await proc.stop();
      await zen.stop();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
