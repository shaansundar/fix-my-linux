import { globSync } from "node:fs";
import { basename } from "node:path";
import { isBlocked } from "./blocklist";
import { isSecretPath, resolvePath, sandboxCantCheck, searchReachesSecrets, type SecretContext } from "./secrets";
import { parse, type SimpleCommand, type Word } from "./shell";

/**
 * Decides whether a bash command may run without asking. opencode's own
 * permission patterns are wildcard matches over the whole command string,
 * which flags, globs and extra arguments slip past, so every bash request is
 * routed here instead. Only commands we can parse completely, built from
 * read-only programs with checked arguments, run on their own; everything
 * else asks the person, and blocked commands are refused.
 */

export type Verdict = { action: "allow" | "ask" | "deny"; reason: string };

export type PolicyContext = SecretContext & {
  cwd: string;
  /** Flatpak: this process sees the sandbox's files, while commands run on the computer. */
  sandboxed?: boolean;
};

type Check = (args: Word[], ctx: PolicyContext) => string | null;

const ok: Check = () => null;
const ASK_DYNAMIC = "uses a variable or wildcard the app can't check";
const ASK_SANDBOX = "uses a folder the app can't check from its sandbox";

/** Literal text of a word, or null when bash would substitute something. */
function lit(w: Word | undefined): string | null {
  if (!w || w.dynamic) return null;
  return w.text;
}

function isFlag(w: Word): boolean {
  return w.text.startsWith("-") && w.text !== "-";
}

/** Splits args into flags and positionals; `valueFlags` consume the next word. */
function split(args: Word[], valueFlags: string[] = []) {
  const flags: string[] = [];
  const positionals: Word[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!endOfFlags && w.text === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && isFlag(w)) {
      flags.push(w.text);
      if (valueFlags.includes(w.text)) i++;
      continue;
    }
    positionals.push(w);
  }
  return { flags, positionals };
}

/** Every path a word refers to (glob-expanded), or a reason to ask. */
function expandPaths(w: Word, ctx: PolicyContext): string[] | string {
  if (w.dynamic) return ASK_DYNAMIC;
  const pattern = resolvePath(w.text, ctx.cwd, ctx.home);
  if (ctx.sandboxed && sandboxCantCheck(pattern, w.glob, ctx.home)) return ASK_SANDBOX;
  if (!w.glob) return [pattern];
  let matches: string[];
  try {
    matches = globSync(pattern);
  } catch {
    return ASK_DYNAMIC;
  }
  if (matches.length > 2000) return "matches too many files";
  // A pattern that matches nothing here is checked as written.
  return matches.length ? matches.map((m) => resolvePath(m, ctx.cwd, ctx.home)) : [pattern];
}

function checkReadPaths(words: Word[], ctx: PolicyContext): string | null {
  for (const w of words) {
    const paths = expandPaths(w, ctx);
    if (typeof paths === "string") return paths;
    if (paths.some((p) => isSecretPath(p, ctx))) return "reads private files";
  }
  return null;
}

function checkSearchRoots(words: Word[], ctx: PolicyContext): string | null {
  const roots = words.length ? words : [{ text: ".", glob: false, dynamic: false, tilde: false, quoted: false }];
  for (const w of roots) {
    const paths = expandPaths(w, ctx);
    if (typeof paths === "string") return paths;
    if (paths.some((p) => searchReachesSecrets(p, ctx))) return "searches folders that contain private files";
  }
  return null;
}

/** A reader: any flags except `deny`, positionals are files. */
function reader(deny: RegExp | null = null, valueFlags: string[] = []): Check {
  return (args, ctx) => {
    const { flags, positionals } = split(args, valueFlags);
    if (deny && flags.some((f) => deny.test(f))) return "uses an option that changes things or never stops";
    return checkReadPaths(positionals, ctx);
  };
}

/** No positional arguments at all (they would change settings). */
const flagsOnly =
  (allowed?: RegExp): Check =>
  (args) => {
    const { flags, positionals } = split(args);
    if (positionals.length) return "would change a setting";
    if (allowed && flags.some((f) => !allowed.test(f))) return "uses an option the app doesn't know";
    return null;
  };

/** First positional must be one of `subs` (prefix match allowed for `abbrev`). */
function subcommand(subs: Record<string, Check | true>, opts: { valueFlags?: string[]; none?: boolean; abbrev?: boolean; deny?: RegExp } = {}): Check {
  return (args, ctx) => {
    const { flags, positionals } = split(args, opts.valueFlags);
    if (opts.deny && flags.some((f) => opts.deny!.test(f))) return "uses an option that changes things";
    const first = positionals[0];
    if (!first) return opts.none ? null : "needs a subcommand the app can check";
    const name = lit(first);
    if (name === null) return ASK_DYNAMIC;
    const key = Object.keys(subs).find((k) => k === name || (opts.abbrev && name.length > 0 && k.startsWith(name)));
    if (!key) return `"${name}" may change things`;
    const sub = subs[key]!;
    if (sub === true) return null;
    const rest = args.slice(args.indexOf(first) + 1);
    return sub(rest, ctx);
  };
}

const noMore: Check = (args) => (split(args).positionals.length ? "would change a setting" : null);
const atMost =
  (n: number): Check =>
  (args) =>
    split(args).positionals.length > n ? "would change a setting" : null;

/** Short-option letters in a combined flag like -xeu (stops at a value letter). */
function shortLetters(flag: string, valueLetters: string): string[] {
  if (!/^-[A-Za-z]/.test(flag) || flag.startsWith("--")) return [];
  const out: string[] = [];
  for (const ch of flag.slice(1)) {
    out.push(ch);
    if (valueLetters.includes(ch)) break;
  }
  return out;
}

const grep: Check = (args, ctx) => {
  const valueFlags = ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--context"];
  const { flags, positionals } = split(args, valueFlags);
  let recursive = false;
  let patternGiven = false;
  for (const f of flags) {
    if (f === "--recursive" || f === "--dereference-recursive" || f === "--directories=recurse" || f === "-d") recursive = true;
    if (f.startsWith("--regexp") || f.startsWith("--file") || f === "-e" || f === "-f") patternGiven = true;
    const letters = shortLetters(f, "efmABCdD");
    if (letters.includes("r") || letters.includes("R")) recursive = true;
    if (letters.includes("e") || letters.includes("f")) patternGiven = true;
  }
  // -f FILE reads patterns from a file.
  const fileIdx = args.findIndex((w) => w.text === "-f" || w.text === "--file");
  if (fileIdx >= 0) {
    const r = checkReadPaths(args.slice(fileIdx + 1, fileIdx + 2), ctx);
    if (r) return r;
  }
  const paths = patternGiven ? positionals : positionals.slice(1);
  if (recursive) return checkSearchRoots(paths, ctx);
  return checkReadPaths(paths, ctx);
};

const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const find: Check = (args, ctx) => {
  if (args.some((w) => FIND_ACTIONS.test(w.text))) return "can delete files or run other commands";
  const roots: Word[] = [];
  for (const w of args) {
    if (w.text.startsWith("-") || w.text === "(" || w.text === "!" || w.text === ")") break;
    roots.push(w);
  }
  // find descends, so a root is judged by everything beneath it, like grep -r.
  const why = checkSearchRoots(roots, ctx);
  return why ? why.replace("searches", "looks through") : null;
};

const ls: Check = (args, ctx) => {
  const { positionals } = split(args, ["-I", "--ignore", "-w", "--width", "-T", "--tabsize"]);
  for (const w of positionals) {
    const paths = expandPaths(w, ctx);
    if (typeof paths === "string") return paths;
    if (paths.some((p) => isSecretPath(p, ctx))) return "lists private folders";
  }
  return null;
};

const ps: Check = (args) => {
  // BSD-style options without a dash: "e" prints every process's environment.
  if (args.some((w) => !w.text.startsWith("-") && /e/.test(w.text) && /^[a-zA-Z]+$/.test(w.text))) {
    return "would show other programs' private settings";
  }
  return null;
};

const top: Check = (args) => {
  const t = args.map((w) => w.text).join(" ");
  if (!/(^|\s)-\w*b/.test(t)) return "would wait forever";
  if (!/(^|\s)-\w*n\s*\d+/.test(t)) return "would wait forever";
  return null;
};

const date: Check = (args) =>
  args.some((w) => /^(-s|--set)/.test(w.text) || /^-[a-zA-Z]*s/.test(w.text)) ? "would change the clock" : null;

const hostname: Check = (args) => (split(args).positionals.length ? "would rename the computer" : null);

// `env NAME=value` prints; any other positional is a command to run.
const env: Check = (args) =>
  args.some((w) => !w.text.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) || args.some((w) => /^(-S|--split-string|-C|--chdir)/.test(w.text))
    ? "would run another command"
    : null;

const command: Check = (args) => (args[0] && /^-[vV]$/.test(args[0].text) ? null : "would run another command");

const JOURNAL_DENY = /^--(follow|vacuum-size|vacuum-time|vacuum-files|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/;
const journalctl: Check = (args) => {
  for (const w of args) {
    if (JOURNAL_DENY.test(w.text)) return "would change logs or never stop";
    if (shortLetters(w.text, "nutpbkoSUDMgFcIi").includes("f")) return "would never stop";
  }
  return null;
};

const systemctl = subcommand(
  Object.fromEntries(
    [
      "status", "show", "cat", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies",
      "list-jobs", "list-machines", "list-automounts", "list-paths", "is-active", "is-enabled", "is-failed",
      "is-system-running", "get-default", "help",
    ].map((s) => [s, true as const]),
  ),
  { valueFlags: ["-t", "--type", "--state", "-p", "--property", "-n", "--lines", "-o", "--output"], none: true, deny: /^(-H|--host|-M|--machine|--root)/ },
);

const NMCLI_VALUE = ["-m", "--mode", "-c", "--colors", "-f", "--fields", "-e", "--escape", "-g", "--get-values", "-w", "--wait"];
const nmcli: Check = (args, ctx) => {
  if (args.some((w) => /^(-s|--show-secrets|-a|--ask)$/.test(w.text))) return "would reveal Wi-Fi passwords";
  return subcommand(
    {
      general: subcommand({ status: noMore, permissions: noMore, hostname: noMore, logging: noMore }, { none: true, abbrev: true }),
      networking: subcommand({ connectivity: atMost(1) }, { none: true, abbrev: true }),
      radio: (rest) => {
        const { positionals } = split(rest);
        if (positionals.length === 0) return null;
        if (positionals.length === 1 && ["all", "wifi", "wwan"].some((k) => k.startsWith(positionals[0]!.text))) return null;
        return "would turn radios on or off";
      },
      connection: subcommand({ show: true }, { none: true, abbrev: true }),
      device: subcommand(
        { status: noMore, show: true, wifi: subcommand({ list: true }, { none: true, abbrev: true }), lldp: subcommand({ list: true }, { none: true, abbrev: true }) },
        { none: true, abbrev: true },
      ),
    },
    { valueFlags: NMCLI_VALUE, none: true, abbrev: true },
  )(args, ctx);
};

const IP_VALUE = ["-f", "-family", "-n", "-netns", "-b", "-batch", "-rc", "-rcvbuf"];
const ipShow: Check = (rest) => {
  const verb = rest.find((w) => !isFlag(w));
  if (!verb) return null;
  if (["show", "list", "lst", "get"].some((v) => v.startsWith(verb.text) && verb.text.length > 0)) return null;
  return "would change network settings";
};
const ip: Check = (args, ctx) => {
  if (args.some((w) => /^-(n|netns|b|batch|force)$/.test(w.text))) return "uses an option the app can't check";
  return subcommand(
    { address: ipShow, link: ipShow, route: ipShow, rule: ipShow, neighbour: ipShow, neighbor: ipShow, maddress: ipShow, netconf: ipShow },
    { valueFlags: IP_VALUE, none: false, abbrev: true },
  )(args, ctx);
};

const resolvectl = subcommand({ status: true, statistics: true, dns: atMost(1), domain: atMost(1), llmnr: atMost(1), mdns: atMost(1) }, { none: true });

const rpm: Check = (args) => {
  const first = args.find(isFlag)?.text ?? "";
  if (!/^(-q|--query|-V|--verify|-K|--checksig)/.test(first)) return "may install or remove software";
  if (args.some((w) => /^(-e|-i|-U|-F|--erase|--install|--upgrade|--freshen|--setperms|--setugids|--restore|--import|--delete|--rebuilddb|--initdb)/.test(w.text))) {
    return "may change installed software";
  }
  return null;
};

const pacman: Check = (args) => {
  const op = args.find(isFlag)?.text ?? "";
  if (/^-Q/.test(op) || op === "--query") return null;
  if (/^-S[sigl]+$/.test(op)) return null;
  if (/^-F[^y]*$/.test(op) && op.length > 1) return null;
  return "may install or update software";
};

const dpkg: Check = (args) => {
  const op = args.find(isFlag)?.text ?? "";
  const READ = /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-p|--print-avail|--get-selections|--print-architecture|--print-foreign-architectures|-C|--audit|--compare-versions|--version|-V|--verify)$/;
  return READ.test(op) ? null : "may install or remove software";
};

const xrandr = flagsOnly(/^(-q|--query|--listmonitors|--listactivemonitors|--listproviders|--verbose|--current)$/);

const nvidiaSmi: Check = (args) =>
  args.every((w) => /^(-L|--list-gpus|-q|--query|--query-[a-z-]+=.*|--format=.*|-i|--id=.*|-d|--display=.*|\d+|[A-Z,_]+|-h|--help|-x|--xml-format)$/.test(w.text))
    ? null
    : "would change graphics card settings";

const dmesg: Check = (args) =>
  args.some((w) => /^(-c|-C|-D|-E|-n|-w|-W|--clear|--read-clear|--console-off|--console-on|--console-level|--follow|--follow-new)/.test(w.text))
    ? "would change kernel log settings or never stop"
    : null;

const efibootmgr = flagsOnly(/^(-v|--verbose)$/);
const mount: Check = (args) => (args.every((w) => w.text === "-l") ? null : "would mount a disk");
const findmnt: Check = (args) => (args.some((w) => /^(-p|--poll)/.test(w.text)) ? "would wait forever" : null);
const swapon = flagsOnly(/^(--show(=.*)?|--noheadings|--bytes|--raw)$/);
const amixer = subcommand({ scontrols: true, scontents: true, controls: true, contents: true, get: true, sget: true, info: true }, { valueFlags: ["-c", "--card", "-D", "--device"], none: true });
const audioList = flagsOnly(/^(-l|-L|--list-devices|--list-pcms)$/);
const xset = subcommand({ q: true }, {});
const iwconfig: Check = (args) => (split(args).positionals.length <= 1 ? null : "would change Wi-Fi settings");
const iw: Check = (args) => {
  const words = args.map((w) => w.text);
  const shapes = [/^dev$/, /^list$/, /^phy$/, /^reg get$/, /^dev \S+ (info|link|station dump|survey dump)$/, /^phy\S* info$/];
  return shapes.some((re) => re.test(words.join(" "))) ? null : "would change Wi-Fi settings";
};
const upower = flagsOnly(/^(-e|--enumerate|-d|--dump|-i|--show-info|--version|-v)$/);
const inxi: Check = (args) => (args.some((w) => /U|--recommends|--update/.test(w.text)) ? "would update itself" : null);

const PROGRAMS: Record<string, Check> = {
  // reading files
  cat: reader(), head: reader(null, ["-n", "-c", "--lines", "--bytes"]), tail: reader(/^(-f|-F|--follow|--retry)|^-[a-zA-Z]*f/, ["-n", "-c", "--lines", "--bytes", "-s"]),
  wc: reader(), file: reader(), stat: reader(), nl: reader(), tac: reader(),
  md5sum: reader(), sha1sum: reader(), sha256sum: reader(), sha512sum: reader(), cksum: reader(),
  strings: reader(), hexdump: reader(), od: reader(),
  diff: reader(), cmp: reader(), comm: reader(), realpath: reader(), readlink: reader(), dirname: ok, basename: ok,
  grep, egrep: grep, fgrep: grep, zgrep: grep,
  find, ls, du: ok, df: ok, tree: ls,
  // filters (stdin)
  sort: reader(/^(-o|--output|--compress-program)/), uniq: (args, ctx) => (split(args).positionals.length > 1 ? "would write a file" : reader()(args, ctx)),
  cut: reader(), tr: ok, column: reader(), fold: reader(), fmt: reader(), rev: reader(), expand: reader(), paste: reader(),
  // about the system
  echo: ok, printf: ok, true: ok, false: ok, test: ok, "[": ok, pwd: ok, whoami: ok, id: ok, groups: ok,
  uname: ok, uptime: ok, nproc: ok, arch: ok, locale: ok, printenv: ok, env, which: ok, whereis: ok, type: ok, command,
  date, hostname, lsb_release: ok, getconf: ok,
  ps, top, free: ok, vmstat: (args) => ([0, 2].includes(split(args).positionals.length) ? null : "would wait forever"), lscpu: ok, lsblk: ok, lspci: ok, lsusb: ok, lsmod: ok, lsof: ok, lsipc: ok, lslocks: ok,
  w: ok, who: ok, last: ok, sensors: ok, findmnt, blkid: ok, mount, swapon, modinfo: ok,
  lshw: ok, dmidecode: ok, hwinfo: ok, inxi, fastfetch: ok, neofetch: ok, screenfetch: ok,
  glxinfo: ok, vainfo: ok, vulkaninfo: ok, clinfo: ok, "nvidia-smi": nvidiaSmi, dmesg,
  udevadm: subcommand({ info: true }, {}),
  // services and logs
  systemctl, journalctl,
  loginctl: subcommand(Object.fromEntries(["list-sessions", "list-users", "list-seats", "show-session", "show-user", "show-seat", "session-status", "user-status", "seat-status"].map((s) => [s, true as const])), { none: true }),
  timedatectl: subcommand({ status: true, show: true, "list-timezones": true, "timesync-status": true, "show-timesync": true }, { none: true }),
  hostnamectl: subcommand({ status: true, show: true }, { none: true }),
  localectl: subcommand({ status: true, "list-locales": true, "list-keymaps": true, "list-x11-keymap-models": true, "list-x11-keymap-layouts": true }, { none: true }),
  // network
  nmcli, ip, iw, iwconfig, resolvectl,
  networkctl: subcommand({ list: true, status: true, lldp: true, label: true }, { none: true }),
  rfkill: subcommand({ list: true }, { none: true }),
  bluetoothctl: subcommand({ show: true, list: true, devices: true, "paired-devices": true, info: true, version: true }, {}),
  // sound and display
  pactl: subcommand(Object.fromEntries(["info", "stat", "list", "get-default-sink", "get-default-source", "get-sink-volume", "get-sink-mute", "get-source-volume", "get-source-mute"].map((s) => [s, true as const])), {}),
  wpctl: subcommand({ status: true, inspect: true, "get-volume": true }, {}),
  amixer, aplay: audioList, arecord: audioList,
  xrandr, xset, xdpyinfo: ok,
  gsettings: subcommand(Object.fromEntries(["get", "list-schemas", "list-relocatable-schemas", "list-keys", "list-children", "list-recursively", "range", "describe", "writable"].map((s) => [s, true as const])), {}),
  dconf: subcommand({ read: true, list: true, dump: true }, {}),
  // packages
  dpkg, "dpkg-query": ok,
  apt: subcommand({ list: true, show: true, policy: true, search: true, depends: true, rdepends: true }, {}),
  "apt-cache": subcommand(Object.fromEntries(["policy", "show", "showpkg", "search", "depends", "rdepends", "madison", "stats", "pkgnames", "showsrc"].map((s) => [s, true as const])), {}),
  "apt-mark": subcommand({ showmanual: true, showauto: true, showhold: true }, {}),
  rpm,
  dnf: subcommand(Object.fromEntries(["list", "info", "search", "repolist", "provides", "whatprovides", "repoquery", "check-update", "deplist"].map((s) => [s, true as const])), {}),
  yum: subcommand(Object.fromEntries(["list", "info", "search", "repolist", "provides", "whatprovides", "check-update", "deplist"].map((s) => [s, true as const])), {}),
  pacman,
  zypper: subcommand(Object.fromEntries(["search", "se", "info", "if", "packages", "pa", "repos", "lr", "patches", "lp", "list-updates", "lu", "products", "pd", "patterns", "pt"].map((s) => [s, true as const])), {}),
  flatpak: subcommand(Object.fromEntries(["list", "info", "remotes", "remote-ls", "search", "history", "ps"].map((s) => [s, true as const])), { none: true }),
  snap: subcommand(Object.fromEntries(["list", "info", "find", "services", "version", "connections", "changes", "change"].map((s) => [s, true as const])), {}),
  fwupdmgr: subcommand(Object.fromEntries(["get-devices", "get-updates", "get-history", "get-remotes", "get-topology"].map((s) => [s, true as const])), {}),
  // printers and power
  lpstat: ok, lpq: ok, upower, acpi: ok, efibootmgr,
  smartctl: (args) => (args.some((w) => /^(-s|-t|-X|-o|-S|--smart|--test|--abort|--offlineauto|--saveauto)/.test(w.text)) ? "would change disk settings" : null),
};

const STANDARD_BIN = /^\/(usr\/)?(local\/)?s?bin\/[^/]+$/;

function checkRedirects(c: SimpleCommand, ctx: PolicyContext): string | null {
  for (const r of c.redirects) {
    if (r.op === "<<<") continue;
    const target = lit(r.target ?? undefined);
    if (target === null) return ASK_DYNAMIC;
    if (r.op === ">&" || r.op === "<&") {
      if (/^(\d|-)$/.test(target)) continue;
      return "writes to a file";
    }
    if (r.op === "<") {
      const why = checkReadPaths([r.target!], ctx);
      if (why) return why;
      continue;
    }
    if (target === "/dev/null") continue;
    return "writes to a file";
  }
  return null;
}

/** The decision for one bash command line. */
export function evaluateCommand(command: string, ctx: PolicyContext): Verdict {
  if (isBlocked(command)) return { action: "deny", reason: "blocked for safety" };
  const parsed = parse(command);
  if (!parsed.ok) return { action: "ask", reason: `uses shell features the app can't check (${parsed.reason})` };
  if (parsed.commands.length === 0) return { action: "ask", reason: "empty command" };

  let cwd = ctx.cwd;
  for (const c of parsed.commands) {
    if (c.assignments.length) return { action: "ask", reason: "sets environment variables for a command" };
    const name0 = lit(c.argv[0]);
    if (name0 === null || c.argv[0]!.glob) return { action: "ask", reason: ASK_DYNAMIC };
    let name = name0;
    if (name.includes("/")) {
      if (!STANDARD_BIN.test(name)) return { action: "ask", reason: "runs a program from an unusual place" };
      name = basename(name);
    }
    const local = { ...ctx, cwd };
    if (name === "cd") {
      const target = c.argv[1];
      if (c.argv.length > 2 || (target && (target.dynamic || target.glob))) return { action: "ask", reason: ASK_DYNAMIC };
      cwd = target ? resolvePath(target.text, cwd, ctx.home) : ctx.home;
      continue;
    }
    const check = Object.hasOwn(PROGRAMS, name) ? PROGRAMS[name] : undefined;
    if (!check) return { action: "ask", reason: `"${name}" may change something` };
    const redirect = checkRedirects(c, local);
    if (redirect) return { action: "ask", reason: redirect };
    const why = check(c.argv.slice(1), local);
    if (why) return { action: "ask", reason: why };
  }
  return { action: "allow", reason: "only looks at your system" };
}

/** File tools (read, grep, glob, list): may they look here without asking? */
export function evaluatePathTool(tool: string, path: string, ctx: PolicyContext): Verdict {
  const abs = resolvePath(path, ctx.cwd, ctx.home);
  if (tool === "grep") {
    return searchReachesSecrets(abs, ctx) ? { action: "ask", reason: "searches folders that contain private files" } : { action: "allow", reason: "searches your files" };
  }
  return isSecretPath(abs, ctx) ? { action: "ask", reason: "opens private files" } : { action: "allow", reason: "reads your files" };
}
