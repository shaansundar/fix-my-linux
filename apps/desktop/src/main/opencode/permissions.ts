/**
 * The opencode permission ruleset. Facts this relies on (opencode 1.19):
 *
 * - Rules are evaluated last-match-wins, so object key order matters.
 * - Bash commands are split with tree-sitter; every simple command (both sides
 *   of `;`, `&&`, `|`, `$(...)`) is matched separately. Any deny wins, all
 *   allow runs, anything else asks.
 * - `*` matches any characters, including spaces, `>` and `/`, and a
 *   redirect stays part of the command it belongs to.
 * - Subagents do not inherit the parent agent's rules, so everything lives in
 *   the top-level `permission` block and `task` is denied.
 *
 * Re-check these with the decision-table test before any opencode upgrade.
 */

export type Action = "allow" | "ask" | "deny";
export type RuleMap = Record<string, Action>;

/** Read-only diagnostics that run without asking. */
export const ALLOW_BASH = [
  "ls *", "ls",
  "cat *", "head *", "tail *", "less *", "wc *",
  "grep *", "find *", "file *", "stat *",
  "df *", "df", "du *", "free *", "free",
  "uname *", "uname", "lsb_release *", "hostnamectl", "hostnamectl status*",
  "lsblk*", "lspci*", "lsusb*", "lscpu*", "lsmod*",
  "ip addr*", "ip a", "ip route*", "ip link show*", "ip -br *",
  "nmcli general*", "nmcli device status*", "nmcli device show*", "nmcli connection show*", "nmcli radio*", "nmcli -t *",
  "systemctl status *", "systemctl list-*", "systemctl is-*", "systemctl --failed*",
  "journalctl *",
  "ps *", "ps", "top -b*", "uptime*", "whoami", "id", "id *", "groups*",
  "which *", "type *", "command -v *",
  "dpkg -l*", "dpkg -s *", "dpkg --get-selections*", "apt list*", "apt-cache *", "apt policy*",
  "rpm -q*", "dnf list*", "dnf info*", "dnf repolist*",
  "pacman -Q*", "pacman -Ss*", "pacman -Si*",
  "flatpak list*", "flatpak info*", "snap list*", "snap info*",
  "pactl info*", "pactl list*", "aplay -l*", "wpctl status*",
  "xrandr --query*", "xrandr", "glxinfo*", "nvidia-smi*",
  "echo *", "echo", "pwd", "date*", "env", "printenv*", "locale*", "timedatectl", "timedatectl status*",
  "ping -c *", "resolvectl status*", "getent hosts *",
];

/** Overrides that must come after the allows: these always ask. */
export const REASK_BASH = [
  // Any redirect can write files, including `echo x > /etc/foo`.
  "*>*",
  // Privilege escalation is never auto-approved.
  "sudo *", "pkexec *", "su *", "su", "doas *", "run0 *",
  // find variants that delete, execute or write.
  "find * -delete*", "find * -exec*", "find * -ok*", "find * -fprint*", "find * -fls*",
  "journalctl *--vacuum*", "journalctl *--rotate*", "journalctl *--flush*",
  "nmcli *--show-secrets*", "nmcli * -s *",
  // Commands that never exit.
  "tail *-f*", "tail *--follow*", "journalctl *-f*", "journalctl *--follow*",
  // Our own process secrets.
  "*OPENCODE_*",
  // Secret material in the home directory.
  "*.ssh/*", "*.gnupg*", "*id_rsa*", "*id_ed25519*", "*id_ecdsa*", "*.pem*", "*.password-store*",
  "*/keyrings/*", "*.netrc*", "*.aws/*", "*.kube/*", "*.docker/config.json*",
];

/** Patterns that are refused outright. */
export const DENY_BASH = [
  // Exact forms only: opencode's `*` cannot match a literal asterisk, so
  // "rm -rf /*" would also block "rm -rf /var/cache/apt/archives/*". Broader
  // whole-disk and whole-home deletions are caught by the broker (HARD_BLOCK).
  "rm -rf /", "rm -fr /", "rm -rf ~", "rm -rf ~/", "rm -fr ~", "rm -fr ~/",
  "rm -rf $HOME", "rm -rf $HOME/", "rm --no-preserve-root*", "rm * --no-preserve-root*",
  "mkfs*", "dd * of=/dev/*", "chmod -R 777 /*", "chown -R * /",
  // A shell reading from a pipe is how `curl ... | sh` runs; each side of a pipe is matched on its own.
  "sh", "bash", "zsh", "sh -s*", "bash -s*", "sh -", "bash -",
  ":(){*",
  "shutdown*", "poweroff*", "halt*", "init 0*",
];

/** Files the read tool may not open without asking. */
export const SECRET_PATHS = [
  "*/.ssh/*", "*/.gnupg/*", "*/.password-store/*", "*/keyrings/*", "*/.netrc", "*/.aws/*", "*/.kube/*",
  "*/.docker/config.json", "*.pem", "*/.mozilla/*", "*/.config/google-chrome/*", "*/.config/chromium/*",
];

function ordered(...groups: Array<[patterns: string[], action: Action]>): RuleMap {
  const out: RuleMap = {};
  for (const [patterns, action] of groups) {
    for (const p of patterns) {
      // Re-inserting moves the key to the end, preserving last-match-wins order.
      delete out[p];
      out[p] = action;
    }
  }
  return out;
}

export function bashRules(): RuleMap {
  return ordered([["*"], "ask"], [ALLOW_BASH, "allow"], [REASK_BASH, "ask"], [DENY_BASH, "deny"]);
}

export type PermissionConfig = Record<string, Action | RuleMap>;

export function permissionConfig(): PermissionConfig {
  return {
    bash: bashRules(),
    read: ordered([["*"], "allow"], [SECRET_PATHS, "ask"]),
    edit: "ask",
    glob: "allow",
    grep: "allow",
    list: "allow",
    external_directory: ordered(
      [["*"], "ask"],
      [["/etc/*", "/var/log/*", "/proc/*", "/sys/*", "/usr/share/*", "/opt/*", "/boot/grub/*"], "allow"],
      [SECRET_PATHS, "ask"],
    ),
    // Fetching a page could be used to send data out; the user decides.
    webfetch: "ask",
    // Would call a third-party search API directly, bypassing our proxy.
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    todowrite: "allow",
    question: "allow",
    doom_loop: "ask",
  };
}

/**
 * Deny rules passed to session.create. Unlike agent rules, session rules also
 * reach child sessions, so they back up the config if a subagent ever runs.
 */
export function sessionDenyRules(): Array<{ permission: string; pattern: string; action: "deny" }> {
  return [
    ...DENY_BASH.map((pattern) => ({ permission: "bash", pattern, action: "deny" as const })),
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
  ];
}
