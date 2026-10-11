import { describe, expect, it } from "vitest";
import { aptSimulation, parseAptSimulation } from "../../src/main/safety/packages";

describe("aptSimulation", () => {
  it.each([
    ["sudo apt install -y vlc", ["-s", "install", "vlc"]],
    ["sudo apt-get --no-install-recommends install vlc ffmpeg", ["-s", "install", "--no-install-recommends", "vlc", "ffmpeg"]],
    ["sudo apt remove --purge libreoffice-core", ["-s", "remove", "--purge", "libreoffice-core"]],
    ["sudo apt autoremove", ["-s", "autoremove"]],
    ["sudo apt update && sudo apt upgrade -y", ["-s", "upgrade"]],
    // hook-capable options never reach the dry run
    ["sudo apt-get -o APT::Update::Pre-Invoke::=touch install vlc", ["-s", "install", "vlc"]],
    ["sudo apt-get -c /tmp/evil.conf install vlc", ["-s", "install", "vlc"]],
    ["sudo apt -t bookworm-backports install firefox", ["-s", "install", "-t", "bookworm-backports", "firefox"]],
  ])("%s", (cmd, want) => {
    expect(aptSimulation(cmd)).toEqual(want);
  });

  it.each(["apt list --installed", "apt update", "flatpak install x", "sudo apt install $PKG", "echo apt install"])("ignores %s", (cmd) => {
    expect(aptSimulation(cmd)).toBeNull();
  });
});

describe("parseAptSimulation", () => {
  it("reads installs, upgrades and removals", () => {
    const out = [
      "Reading package lists...",
      "The following NEW packages will be installed:",
      "Inst libvlc5 (3.0.20-3build6 Ubuntu:24.04/noble [amd64])",
      "Inst firefox [128.0] (129.0 Ubuntu:24.04/noble-updates [amd64])",
      "Remv libreoffice-core [4:24.2.7-0ubuntu0.24.04.1]",
      "Conf libvlc5 (3.0.20-3build6 Ubuntu:24.04/noble [amd64])",
    ].join("\n");
    expect(parseAptSimulation(out)).toEqual([
      { kind: "add", name: "libvlc5", detail: "3.0.20-3build6" },
      { kind: "update", name: "firefox", detail: "128.0 → 129.0" },
      { kind: "remove", name: "libreoffice-core", detail: "4:24.2.7-0ubuntu0.24.04.1" },
    ]);
  });
});
