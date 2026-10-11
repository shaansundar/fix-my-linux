import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { demoBrain } from "./dev/demo-brain";
import { FakeZen, fakeCatalog } from "./dev/fake-zen";
import type { EngineMode } from "./engine";

export const DEFAULT_API_BASE = "https://api.fixmylinux.app";

/**
 * Where model traffic goes, from the environment:
 *   FML_DEMO=1                      scripted offline demo (no account, no key)
 *   FML_UPSTREAM_URL + FML_CATALOG_FILE [+ FML_UPSTREAM_KEY]   tests and E2E
 *   FML_DEV_ZEN_KEY                 development against Zen's free models
 *   otherwise                       production backend (FML_API_BASE overrides)
 */
export async function resolveMode(env: NodeJS.ProcessEnv, dataDir: string): Promise<{ mode: EngineMode; demo: FakeZen | null }> {
  if (env["FML_DEMO"] === "1") {
    const zen = new FakeZen().respondWith(demoBrain);
    const url = await zen.start();
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const catalogFile = join(dataDir, "demo-catalog.json");
    await writeFile(
      catalogFile,
      JSON.stringify({
        provider: { ...(fakeCatalog("demo", "Demo assistant") as { opencode: object }).opencode },
        plan: { defaultModel: "demo", smallModel: "demo", allowed: ["demo"] },
      }),
    );
    return { mode: { kind: "custom", upstreamURL: `${url}/zen/v1`, upstreamKey: "demo", catalogFile }, demo: zen };
  }
  const upstreamURL = env["FML_UPSTREAM_URL"];
  const catalogFile = env["FML_CATALOG_FILE"];
  if (upstreamURL && catalogFile) {
    return { mode: { kind: "custom", upstreamURL, upstreamKey: env["FML_UPSTREAM_KEY"] ?? "dev", catalogFile }, demo: null };
  }
  const zenKey = env["FML_DEV_ZEN_KEY"];
  if (zenKey) return { mode: { kind: "dev-zen", zenKey }, demo: null };
  return { mode: { kind: "backend", apiBase: env["FML_API_BASE"] ?? DEFAULT_API_BASE }, demo: null };
}

/** Modes that don't need an account. */
export function needsAccount(mode: EngineMode): boolean {
  return mode.kind === "backend";
}
