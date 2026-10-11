import { describe, expect, it } from "vitest";
import { hostCommand } from "../../src/main/host";

describe("hostCommand", () => {
  it("runs the program directly outside Flatpak, with the extra variables", () => {
    expect(hostCommand(false, "apt-get", ["-s", "install", "vlc"], { LANG: "C" })).toEqual({
      file: "apt-get",
      args: ["-s", "install", "vlc"],
      env: { LANG: "C" },
    });
  });

  it("goes through flatpak-spawn --host in Flatpak, passing variables as --env", () => {
    expect(hostCommand(true, "apt-get", ["-s", "install", "vlc"], { LANG: "C", LC_ALL: "C" })).toEqual({
      file: "flatpak-spawn",
      args: ["--host", "--watch-bus", "--env=LANG=C", "--env=LC_ALL=C", "apt-get", "-s", "install", "vlc"],
      env: {},
    });
  });

  it("keeps arguments that look like flatpak-spawn options as the program's own", () => {
    const { args } = hostCommand(true, "systemctl", ["--failed", "--env=X"]);
    expect(args).toEqual(["--host", "--watch-bus", "systemctl", "--failed", "--env=X"]);
  });
});
