import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_DIR = resolve(__dirname, "../../resources/shell");
const WRAPPER = join(SHELL_DIR, "bash");

function run(command: string, env: Record<string, string>): string {
  return execFileSync(WRAPPER, ["-c", command], {
    env: { PATH: "/usr/bin:/bin", HOME: "/home/ana", ...env },
    encoding: "utf8",
  });
}

const APP_ENV = {
  OPENCODE_SERVER_PASSWORD: "secret-password",
  OPENCODE_CONFIG_CONTENT: '{"provider":{"opencode":{"options":{"apiKey":"nonce"}}}}',
  XDG_CONFIG_HOME: "/app/data/config",
  FML_REAL_XDG_CONFIG_HOME: "/home/ana/.config",
  FML_REAL_XDG_DATA_HOME: "/home/ana/.local/share",
  FML_SHELL_DIR: SHELL_DIR,
  FML_SHIM_DIR: "/run/user/1000/fix-my-linux/shim",
  // Inherited from older launches; must never reach a command.
  FML_ASKPASS_BIN: "/app/bin/fml-askpass",
  FML_ASKPASS_SOCKET: "/run/user/1000/fix-my-linux/askpass.sock",
  SUDO_ASKPASS: "/app/bin/fml-askpass",
  ELECTRON_RUN_AS_NODE: "1",
};

describe("shell wrapper", () => {
  it("removes the app's secrets from every command's environment", () => {
    const env = run("env", APP_ENV);
    expect(env).not.toContain("secret-password");
    expect(env).not.toContain("OPENCODE_");
    expect(env).not.toContain("ELECTRON_");
    expect(run("echo \"[$OPENCODE_SERVER_PASSWORD]\"", APP_ENV).trim()).toBe("[]");
  });

  it("restores the user's real XDG directories", () => {
    expect(run("echo $XDG_CONFIG_HOME", APP_ENV).trim()).toBe("/home/ana/.config");
    expect(run("echo $XDG_DATA_HOME", APP_ENV).trim()).toBe("/home/ana/.local/share");
    expect(run("env", APP_ENV)).not.toContain("FML_REAL_");
  });

  it("puts the per-launch sudo shim first and hides the askpass wiring", () => {
    expect(run("echo $PATH", APP_ENV).trim().split(":")[0]).toBe("/run/user/1000/fix-my-linux/shim");
    expect(run("echo \"[$SUDO_ASKPASS][$FML_ASKPASS_SOCKET][$FML_ASKPASS_BIN]\"", APP_ENV).trim()).toBe("[][][]");
  });

  it("falls back to the bundled shim", () => {
    const { FML_SHIM_DIR: _drop, ...rest } = APP_ENV;
    expect(run("command -v sudo", rest).trim()).toBe(join(SHELL_DIR, "bin/sudo"));
  });

  it("makes commands non-interactive", () => {
    expect(run("echo $DEBIAN_FRONTEND $PAGER", APP_ENV).trim()).toBe("noninteractive cat");
  });

  it("passes the command's exit code through", () => {
    try {
      run("exit 3", APP_ENV);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(3);
    }
  });
});
