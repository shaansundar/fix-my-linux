export type Theme = "system" | "light" | "dark";

export type Settings = {
  theme: Theme;
  /** Text size, percent. */
  zoom: number;
  /** Never offer "Allow similar": every change asks. */
  alwaysAsk: boolean;
  /** Preferred model id, if the plan allows it. */
  model: string | null;
};

export const DEFAULT_SETTINGS: Settings = { theme: "system", zoom: 100, alwaysAsk: false, model: null };

/** Accepts only known keys and sane values; anything else falls back to the default. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    theme: r["theme"] === "light" || r["theme"] === "dark" ? r["theme"] : "system",
    zoom: typeof r["zoom"] === "number" && r["zoom"] >= 80 && r["zoom"] <= 150 ? Math.round(r["zoom"]) : 100,
    alwaysAsk: r["alwaysAsk"] === true,
    model: typeof r["model"] === "string" && r["model"].length < 128 ? r["model"] : null,
  };
}
