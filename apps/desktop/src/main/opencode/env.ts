import { join } from "node:path";

export type EnvInput = {
  /** The Electron main process environment. */
  base: NodeJS.ProcessEnv;
  /** App-private root; opencode's XDG dirs live under it. */
  dataDir: string;
  serverPassword: string;
  configContent: string;
  modelsPath: string;
  /** Directory holding this launch's generated sudo shim. */
  shimDir: string;
  shellDir: string;
  flatpak: boolean;
};

const XDG_KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;

/**
 * Environment for `opencode serve`. Every XDG dir points into the app's own
 * data dir so the user's ~/.config/opencode, auth.json and database never mix
 * with ours; the real values are kept in FML_REAL_* so the shell wrapper can
 * restore them for the commands it runs.
 */
export function buildOpencodeEnv(input: EnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.base)) {
    // Drop inherited opencode settings, e.g. from a developer's own shell.
    if (v === undefined || k.startsWith("OPENCODE_") || k.startsWith("FML_")) continue;
    env[k] = v;
  }

  const home = input.base["HOME"] ?? "";
  const realXdg: Record<(typeof XDG_KEYS)[number], string> = {
    XDG_CONFIG_HOME: input.base["XDG_CONFIG_HOME"] ?? join(home, ".config"),
    XDG_DATA_HOME: input.base["XDG_DATA_HOME"] ?? join(home, ".local/share"),
    XDG_CACHE_HOME: input.base["XDG_CACHE_HOME"] ?? join(home, ".cache"),
    XDG_STATE_HOME: input.base["XDG_STATE_HOME"] ?? join(home, ".local/state"),
  };
  for (const key of XDG_KEYS) env[`FML_REAL_${key}`] = realXdg[key];

  Object.assign(env, {
    XDG_CONFIG_HOME: join(input.dataDir, "config"),
    XDG_DATA_HOME: join(input.dataDir, "data"),
    XDG_CACHE_HOME: join(input.dataDir, "cache"),
    XDG_STATE_HOME: join(input.dataDir, "state"),

    OPENCODE_CONFIG_CONTENT: input.configContent,
    OPENCODE_SERVER_PASSWORD: input.serverPassword,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
    // Stop ~/.claude/CLAUDE.md and ~/.claude, ~/.agents skills from shaping the agent.
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    // The catalog comes from our backend via a file; opencode never fetches it.
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: input.modelsPath,
    // "desktop" enables the question tool, which the Approval Card renders.
    OPENCODE_CLIENT: "desktop",
    OPENCODE_ENABLE_QUESTION_TOOL: "1",

    FML_SHIM_DIR: input.shimDir,
    FML_SHELL_DIR: input.shellDir,
    FML_FLATPAK: input.flatpak ? "1" : "0",
  });
  return env;
}
