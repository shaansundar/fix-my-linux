import { writeFile } from "node:fs/promises";
import type { ModelPlan } from "./opencode/config";

/**
 * The model catalog opencode reads from OPENCODE_MODELS_PATH (models.dev
 * format, only the `opencode` provider) plus the plan derived from it.
 * In production both come from the backend's /v1/catalog; in development
 * they are derived from the public models.opencode.ai catalog.
 */

export type CatalogModel = {
  id: string;
  name: string;
  status?: string;
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
  [key: string]: unknown;
};

export type ProviderCatalog = {
  id: string;
  models: Record<string, CatalogModel>;
  [key: string]: unknown;
};

export type CatalogResponse = {
  provider: ProviderCatalog;
  plan: ModelPlan;
};

/** Preferred free models for tool use, best first; anything else free is a fallback. */
const FREE_PREFERENCE = ["big-pickle", "nemotron-3-ultra-free", "mimo-v2.6-flash-free", "step-5-preview-free"];

export function isFree(m: CatalogModel): boolean {
  return (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0;
}

export function usable(m: CatalogModel): boolean {
  return m.status !== "deprecated" && m.tool_call !== false;
}

/** The trial plan: every active free model that can call tools. */
export function freePlan(provider: ProviderCatalog): CatalogResponse {
  const free = Object.values(provider.models).filter((m) => isFree(m) && usable(m));
  if (free.length === 0) throw new Error("no free models available");
  const ids = free.map((m) => m.id);
  const ranked = [...FREE_PREFERENCE.filter((id) => ids.includes(id)), ...ids.filter((id) => !FREE_PREFERENCE.includes(id))];
  const models = Object.fromEntries(free.map((m) => [m.id, m]));
  return {
    provider: { ...provider, models },
    plan: { defaultModel: ranked[0]!, smallModel: ranked[0]!, allowed: ranked },
  };
}

export async function fetchPublicCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
  const res = await fetch("https://models.opencode.ai/api.json", { signal });
  if (!res.ok) throw new Error(`failed to fetch model catalog: ${res.status}`);
  const all = (await res.json()) as Record<string, ProviderCatalog>;
  const provider = all["opencode"];
  if (!provider) throw new Error("model catalog has no opencode provider");
  return provider;
}

export async function fetchBackendCatalog(apiBase: string, token: string, signal?: AbortSignal): Promise<CatalogResponse> {
  const res = await fetch(`${apiBase}/v1/catalog`, { headers: { authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new Error(`failed to fetch catalog: ${res.status}`);
  return (await res.json()) as CatalogResponse;
}

export async function writeCatalog(path: string, provider: ProviderCatalog): Promise<void> {
  await writeFile(path, JSON.stringify({ opencode: provider }), { mode: 0o600 });
}
