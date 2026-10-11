import { describe, expect, it } from "vitest";
import { buildConfig, type ConfigInput } from "../../src/main/opencode/config";
import { buildOpencodeEnv, type EnvInput } from "../../src/main/opencode/env";

const configInput: ConfigInput = {
  relayOrigin: "http://127.0.0.1:41234",
  relayNonce: "nonce-123",
  plan: { defaultModel: "big-pickle", smallModel: "nano-free", allowed: ["big-pickle"] },
  promptFile: "/app/resources/prompts/fixer.md",
  shellPath: "/app/resources/shell/bash",
};

describe("buildConfig", () => {
  const cfg = buildConfig(configInput) as Record<string, any>;

  it("routes the Zen provider through the loopback relay with the nonce", () => {
    expect(cfg.enabled_providers).toEqual(["opencode"]);
    expect(cfg.provider.opencode.options).toEqual({ baseURL: "http://127.0.0.1:41234/zen/v1", apiKey: "nonce-123" });
  });

  it("whitelists exactly the plan's models, including the small model", () => {
    expect(cfg.provider.opencode.whitelist.sort()).toEqual(["big-pickle", "nano-free"]);
    expect(cfg.model).toBe("opencode/big-pickle");
    expect(cfg.small_model).toBe("opencode/nano-free");
  });

  it("disables everything that phones home or touches the user's files implicitly", () => {
    expect(cfg.share).toBe("disabled");
    expect(cfg.autoupdate).toBe(false);
    expect(cfg.lsp).toBe(false);
    expect(cfg.formatter).toBe(false);
    expect(cfg.snapshot).toBe(false);
  });

  it("uses only the fixer agent and disables the built-in ones", () => {
    expect(cfg.default_agent).toBe("fixer");
    expect(cfg.agent.fixer.mode).toBe("primary");
    expect(cfg.agent.fixer.prompt).toBe("{file:/app/resources/prompts/fixer.md}");
    for (const name of ["build", "plan", "general", "explore"]) expect(cfg.agent[name]).toEqual({ disable: true });
  });

  it("runs commands through the shell wrapper", () => {
    expect(cfg.shell).toBe("/app/resources/shell/bash");
  });
});

describe("buildOpencodeEnv", () => {
  const input: EnvInput = {
    base: {
      HOME: "/home/ana",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/ana/.cfg",
      OPENCODE_CONFIG: "/home/ana/.config/opencode/custom.json",
      OPENCODE_SERVER_PASSWORD: "inherited",
      FML_SOMETHING: "stale",
    },
    dataDir: "/home/ana/.config/Fix My Linux/opencode",
    serverPassword: "pw",
    configContent: "{}",
    modelsPath: "/data/models.json",
    shimDir: "/run/user/1000/fix-my-linux/shim",
    shellDir: "/app/resources/shell",
    flatpak: false,
  };
  const env = buildOpencodeEnv(input);

  it("drops inherited opencode and app variables", () => {
    expect(env["OPENCODE_CONFIG"]).toBeUndefined();
    expect(env["FML_SOMETHING"]).toBeUndefined();
    expect(env["OPENCODE_SERVER_PASSWORD"]).toBe("pw");
  });

  it("isolates every XDG dir and remembers the real ones for the shell", () => {
    expect(env["XDG_CONFIG_HOME"]).toBe("/home/ana/.config/Fix My Linux/opencode/config");
    expect(env["XDG_DATA_HOME"]).toBe("/home/ana/.config/Fix My Linux/opencode/data");
    expect(env["FML_REAL_XDG_CONFIG_HOME"]).toBe("/home/ana/.cfg");
    expect(env["FML_REAL_XDG_DATA_HOME"]).toBe("/home/ana/.local/share");
  });

  it("sets every isolation flag", () => {
    for (const flag of [
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_PURE",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_SHARE",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_MODELS_FETCH",
    ]) {
      expect(env[flag], flag).toBe("1");
    }
    expect(env["OPENCODE_MODELS_PATH"]).toBe("/data/models.json");
    expect(env["OPENCODE_CLIENT"]).toBe("desktop");
  });

  it("keeps the user's PATH and HOME so commands behave normally", () => {
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/ana");
  });
});
