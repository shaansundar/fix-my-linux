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
  FML_ASKPASS_BIN: "/app/bin/fml-askpass",
  FML_ASKPASS_SOCKET: "/run/user/1000/fix-my-linux/askpass.sock",
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

  it("routes sudo through the askpass helper", () => {
    expect(run("command -v sudo", APP_ENV).trim()).toBe(join(SHELL_DIR, "bin/sudo"));
    expect(run("echo $SUDO_ASKPASS", APP_ENV).trim()).toBe("/app/bin/fml-askpass");
    // the socket path stays so the helper can find the app
    expect(run("echo $FML_ASKPASS_SOCKET", APP_ENV).trim()).toBe("/run/user/1000/fix-my-linux/askpass.sock");
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
