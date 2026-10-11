import type { Risk, RiskLevel } from "../../shared/approvals";
import { simpleCommands } from "../opencode/wildcard";

export type { Risk, RiskLevel };

/**
 * Risk scoring for approval cards. Scores come only from what will actually
 * run (the command or the diff), never from the model's own explanation,
 * which a prompt injection could make sound harmless.
 */
type Rule = { level: RiskLevel; reason: string; test: RegExp };

const RULES: Rule[] = [
  // high
  { level: "high", reason: "Changes disks or partitions", test: /^(fdisk|parted|gdisk|sgdisk|mkfs\S*|dd|wipefs|cryptsetup|mkswap|swapoff|resize2fs|lvremove|vgremove|pvremove)\b/ },
  { level: "high", reason: "Changes how the computer starts up", test: /^(grub-install|grub2-install|update-grub|grub-mkconfig|grub2-mkconfig|efibootmgr|bootctl|mkinitcpio|dracut|update-initramfs)\b/ },
  { level: "high", reason: "Changes hardware drivers", test: /^(modprobe|rmmod|insmod|dkms|ubuntu-drivers|nvidia-installer|mokutil)\b/ },
  { level: "high", reason: "Removes software", test: /^(apt|apt-get|dnf|yum|zypper)\s+(.*\s)?(remove|purge|autoremove|erase)\b|^pacman\s+-R|^snap\s+remove\b|^flatpak\s+(uninstall|remove)\b/ },
  { level: "high", reason: "Changes user accounts or passwords", test: /^(useradd|userdel|usermod|passwd|chpasswd|groupadd|groupdel|gpasswd|visudo)\b/ },
  { level: "high", reason: "Changes the firewall", test: /^(ufw|iptables|ip6tables|nft|firewall-cmd)\b/ },
  { level: "high", reason: "Changes file ownership or permissions", test: /^(chown|chmod|chgrp|setfacl)\s+.*\s\/(?!home\/|tmp\/)/ },
  { level: "high", reason: "Disables or masks a system service", test: /^systemctl\s+(.*\s)?(disable|mask)\b/ },
  { level: "high", reason: "Writes to a system folder", test: /(^|\s)(>|>>|tee(\s+-a)?)\s*\/(etc|boot|usr|dev|lib|bin|sbin|var\/lib)\b|^(cp|mv|install|ln|rm|sed\s+-i)\s+.*\s\/(etc|boot|usr|lib|bin|sbin)\// },
  // medium
  { level: "medium", reason: "Installs or updates software", test: /^(apt|apt-get|dnf|yum|zypper)\s+(.*\s)?(install|upgrade|full-upgrade|dist-upgrade|update|reinstall)\b|^pacman\s+-S|^(snap|flatpak)\s+(install|update|refresh)\b|^(dpkg\s+-i|rpm\s+-i|pip3?\s+install|npm\s+(-g\s+)?install)\b/ },
  { level: "medium", reason: "Starts, stops or restarts a service", test: /^systemctl\s+(.*\s)?(start|stop|restart|reload|enable|daemon-reload|kill)\b|^service\s+\S+\s+(start|stop|restart)\b/ },
  { level: "medium", reason: "Deletes or moves files", test: /^(rm|rmdir|mv|shred|unlink|trash-put|gio\s+trash)\b/ },
  { level: "medium", reason: "Stops running programs", test: /^(kill|pkill|killall|xkill)\b/ },
  { level: "medium", reason: "Changes network settings", test: /^nmcli\s+(.*\s)?(modify|up|down|delete|add|connect|disconnect|on|off)\b|^(ip\s+(link|addr|route)\s+(set|add|del)|rfkill|resolvectl\s+(dns|domain))\b/ },
  { level: "medium", reason: "Changes desktop settings", test: /^(gsettings\s+(set|reset)|dconf\s+(write|reset|load)|kwriteconfig\d*|xfconf-query)\b/ },
  { level: "medium", reason: "Downloads files from the internet", test: /^(curl|wget|aria2c|git\s+clone)\b/ },
  { level: "medium", reason: "Changes the date, time or language", test: /^(timedatectl|localectl|hostnamectl)\s+set/ },
];

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function max(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

const ELEVATORS = new Set(["sudo", "pkexec", "doas", "run0"]);
/** sudo/doas/run0 options that consume the next token. */
const OPTS_WITH_ARG = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group"]);

/** `sudo -u x -E apt install` → `apt install`, elevated. */
export function stripElevation(cmd: string): { inner: string; elevated: boolean } {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  let elevated = false;
  for (;;) {
    const head = tokens[0];
    if (head && ELEVATORS.has(head)) {
      elevated = true;
      tokens.shift();
      while (tokens[0]?.startsWith("-")) {
        const opt = tokens.shift()!;
        if (opt === "--") break;
        if (OPTS_WITH_ARG.has(opt)) tokens.shift();
      }
      continue;
    }
    if (head === "su") {
      elevated = true;
      tokens.shift();
      const c = tokens.indexOf("-c");
      if (c < 0) return { inner: "", elevated };
      const rest = tokens.slice(c + 1).join(" ").replace(/^["']|["']$/g, "");
      tokens.splice(0, tokens.length, ...rest.split(/\s+/).filter(Boolean));
      continue;
    }
    break;
  }
  return { inner: tokens.join(" "), elevated };
}

export function scoreCommand(command: string): Risk {
  let level: RiskLevel = "low";
  const reasons: string[] = [];
  const add = (l: RiskLevel, reason: string) => {
    level = max(level, l);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const part of simpleCommands(command)) {
    const { inner, elevated } = stripElevation(part);
    if (elevated) add("high", "Needs administrator rights");
    for (const rule of RULES) {
      if (rule.test.test(inner)) add(rule.level, rule.reason);
    }
  }
  if (/(^|[^2&])>{1,2}\s*[~$\w/.]/.test(command) && level === "low") add("low", "Writes to a file");
  reasons.sort((a, b) => ORDER[reasonLevel(b)] - ORDER[reasonLevel(a)]);
  return { level, reasons };
}

function reasonLevel(reason: string): RiskLevel {
  if (reason === "Needs administrator rights") return "high";
  return RULES.find((r) => r.reason === reason)?.level ?? "low";
}

const SYSTEM_PREFIX = /^\/(etc|boot|usr|lib|lib64|bin|sbin|opt|var\/lib|root)\//;

/** Edits are scored by where the file lives. */
export function scoreEdit(filepath: string, home: string): Risk {
  if (SYSTEM_PREFIX.test(filepath)) return { level: "high", reasons: ["Changes a system settings file"] };
  const rel = filepath.startsWith(`${home}/`) ? filepath.slice(home.length + 1) : null;
  if (rel !== null && (rel.startsWith(".") || rel.startsWith(".config/"))) {
    return { level: "medium", reasons: ["Changes one of your app or desktop settings files"] };
  }
  return { level: "low", reasons: ["Changes a file in your folders"] };
}

export function scoreDirectories(directories: string[], home: string): Risk {
  const outsideHome = directories.filter((d) => d !== home && !d.startsWith(`${home}/`));
  if (outsideHome.some((d) => d === "/root" || d.startsWith("/root/"))) {
    return { level: "medium", reasons: ["Looks inside the administrator's private folder"] };
  }
  return { level: "low", reasons: ["Looks at files outside your home folder"] };
}
