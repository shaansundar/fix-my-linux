import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("shell wrapper in the Flatpak build", () => {
  // Stands in for flatpak-spawn: records its arguments, then runs the command
  // the way the host would, in a clean session environment plus the --env pairs.
  const dir = mkdtempSync(join(tmpdir(), "fml-spawn-"));
  const log = join(dir, "args");
  writeFileSync(
    join(dir, "flatpak-spawn"),
    `#!/bin/bash
printf '%s\\n' "$@" > "$TEST_SPAWN_LOG"
envs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host | --watch-bus) shift ;;
    --env=*) envs+=("\${1#--env=}"); shift ;;
    *) break ;;
  esac
done
# TEST_HOST_PATH=none simulates a host session without PATH.
host_path=("PATH=/usr/local/bin:/usr/bin:/bin")
[ "\${TEST_HOST_PATH:-}" = none ] && host_path=()
exec env -i HOME=/home/ana "\${host_path[@]}" "\${envs[@]}" "$@"
`,
  );
  chmodSync(join(dir, "flatpak-spawn"), 0o755);

  const SANDBOX_ENV = {
    ...APP_ENV,
    PATH: `${dir}:/app/bin:/usr/bin:/bin`,
    FML_FLATPAK: "1",
    FML_REAL_XDG_CONFIG_HOME: "/home/ana/.var/app/dev.fixmylinux.app/config",
    XDG_DATA_DIRS: "/app/share:/usr/share",
    TEST_SPAWN_LOG: log,
  };
  const host = (command: string) => run(command, SANDBOX_ENV);
  const args = () => readFileSync(log, "utf8").split("\n");

  it("runs the command on the host and stops it if the app goes away", () => {
    expect(host("echo hi").trim()).toBe("hi");
    expect(args().slice(0, 2)).toEqual(["--host", "--watch-bus"]);
  });

  it("puts the sudo shim in front of the host's own PATH", () => {
    expect(host("echo $PATH").trim()).toBe("/run/user/1000/fix-my-linux/shim:/usr/local/bin:/usr/bin:/bin");
  });

  it("keeps the shim first, and a usable PATH, when the host session has none", () => {
    const path = run("echo $PATH", { ...SANDBOX_ENV, TEST_HOST_PATH: "none" }).trim().split(":");
    expect(path[0]).toBe("/run/user/1000/fix-my-linux/shim");
    expect(path).toContain("/usr/bin");
    expect(run("command -v ls", { ...SANDBOX_ENV, TEST_HOST_PATH: "none" }).trim()).toMatch(/\/ls$/);
  });

  it("never hands sandbox paths or app secrets to the host", () => {
    const env = host("env");
    expect(env).not.toContain("/app/");
    expect(env).not.toContain(".var/app");
    expect(env).not.toContain("secret-password");
    const passed = args().filter((a) => a.startsWith("--env="));
    expect(passed.some((a) => /^--env=(PATH|HOME|XDG_[A-Z_]+)=/.test(a))).toBe(false);
    expect(args().join("\n")).not.toContain("secret-password");
  });

  it("keeps host commands non-interactive", () => {
    expect(host("echo $DEBIAN_FRONTEND $PAGER").trim()).toBe("noninteractive cat");
  });

  it("passes the host command's exit code through", () => {
    try {
      host("exit 4");
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(4);
    }
  });
});
