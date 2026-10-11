import { describe, expect, it } from "vitest";
import { scoreCommand, scoreDirectories, scoreEdit, stripElevation } from "../../src/main/safety/risk";

describe("stripElevation", () => {
  it.each([
    ["sudo apt install vlc", "apt install vlc", true],
    ["sudo -E apt install vlc", "apt install vlc", true],
    ["sudo -u bob -E systemctl --user restart x", "systemctl --user restart x", true],
    ["pkexec rm /etc/x", "rm /etc/x", true],
    ["su -c 'reboot'", "reboot", true],
    ["apt list --installed", "apt list --installed", false],
  ])("%s", (cmd, inner, elevated) => {
    expect(stripElevation(cmd)).toEqual({ inner, elevated });
  });
});

describe("scoreCommand", () => {
  it.each([
    ["mkdir ~/Projects", "low"],
    ["echo hi > ~/notes.txt", "low"],
    ["flatpak install -y flathub org.videolan.VLC", "medium"],
    ["systemctl --user restart pipewire", "medium"],
    ["rm ~/Downloads/old.iso", "medium"],
    ["pkill firefox", "medium"],
    ["nmcli connection up home", "medium"],
    ["gsettings set org.gnome.desktop.interface text-scaling-factor 1.25", "medium"],
    ["curl -LO https://example.com/file.deb", "medium"],
    ["sudo apt install vlc", "high"],
    ["apt remove --purge libreoffice*", "high"],
    ["pacman -Rns firefox", "high"],
    ["sudo update-grub", "high"],
    ["sudo modprobe -r iwlwifi", "high"],
    ["echo 'x' | sudo tee /etc/sysctl.d/99-x.conf", "high"],
    ["ufw enable", "high"],
    ["chmod 755 /usr/local/bin/x", "high"],
    ["systemctl disable bluetooth", "high"],
    ["ls; sudo rm -r /var/cache/apt", "high"],
  ])("%s → %s", (cmd, level) => {
    expect(scoreCommand(cmd).level).toBe(level);
  });

  it("explains why, most serious reason first", () => {
    const risk = scoreCommand("sudo apt install vlc");
    expect(risk.reasons[0]).toBe("Needs administrator rights");
    expect(risk.reasons).toContain("Installs or updates software");
  });
});

describe("scoreEdit", () => {
  const home = "/home/ana";
  it.each([
    ["/etc/fstab", "high"],
    ["/home/ana/.bashrc", "medium"],
    ["/home/ana/.config/monitors.xml", "medium"],
    ["/home/ana/Documents/todo.txt", "low"],
  ])("%s → %s", (path, level) => {
    expect(scoreEdit(path, home).level).toBe(level);
  });
});

describe("scoreDirectories", () => {
  it("flags /root and treats other reads as low", () => {
    expect(scoreDirectories(["/root/.cache"], "/home/ana").level).toBe("medium");
    expect(scoreDirectories(["/srv/data"], "/home/ana").level).toBe("low");
  });
});
