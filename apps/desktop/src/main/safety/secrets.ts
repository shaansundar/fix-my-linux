import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/**
 * Where private material lives. Used to decide whether reading or searching a
 * path needs the person's OK. Paths are resolved (~, relative, symlinks) first,
 * so `cat ~/m/x` with `~/m -> ~/.mozilla` is still caught.
 */

/** Directories under the home folder whose contents are private. */
const HOME_SECRET_DIRS = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".local/share/keyrings",
  ".aws",
  ".kube",
  ".docker",
  ".mozilla",
  ".thunderbird",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".config/vivaldi",
  ".config/opera",
  ".config/Signal",
  ".config/keepassxc",
  ".local/share/kwalletd",
  // Flatpak apps keep their own profiles (browsers, password managers) here.
  ".var/app",
];

/** Single files under home. */
const HOME_SECRET_FILES = [".netrc", ".pgpass", ".git-credentials", ".bash_history", ".zsh_history", ".python_history"];

/** System locations with secrets or process internals. */
const SYSTEM_SECRET_PREFIXES = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/NetworkManager/system-connections",
  "/etc/ssh/ssh_host_",
  "/root",
  "/proc/kcore",
  "/dev/mem",
  "/dev/kmem",
];

/** File names that are private wherever they are. */
const SECRET_NAMES = [/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/, /\.pem$/, /\.key$/, /^logins\.json$/, /^key[34]\.db$/, /^cookies\.sqlite$/, /^Cookies$/, /^Login Data$/, /^\.env$/];

/** /proc/<pid>/<x> entries that expose another process's environment or memory. */
const PROC_PRIVATE_ENTRIES = ["environ", "mem", "fd", "fdinfo", "map_files", "cwd", "root", "auxv", "pagemap", "syscall", "stack"];
const WILDCARD = /[*?[]/;

/** One path component as a shell wildcard; anything it can't parse matches everything. */
function componentPattern(c: string): RegExp {
  let re = "";
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = c.indexOf("]", i + 2);
      if (end < 0) return /^/;
      const body = c.slice(i + 1, end).replace(/^[!^]/, "^").replace(/\\/g, "\\\\");
      re += `[${body}]`;
      i = end;
    } else re += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return /^/;
  }
}

function couldBe(component: string | undefined, names: string[]): boolean {
  if (component === undefined) return false;
  if (!WILDCARD.test(component)) return names.includes(component);
  const re = componentPattern(component);
  return names.some((n) => re.test(n));
}

/** A process id (or self), or a wildcard that might match one. */
function pidLike(component: string | undefined): boolean {
  return component !== undefined && (/^(self|thread-self|\d+)$/.test(component) || WILDCARD.test(component));
}

/**
 * /proc/<pid>/environ and the like, including wildcard spellings such as
 * /proc/[0-9]*\/env*, which are checked as written when they match nothing
 * locally (no /proc on macOS, another PID namespace in the sandbox).
 */
function procPrivate(abs: string): boolean {
  const parts = abs.split("/");
  if (parts[1] !== "proc" || !pidLike(parts[2])) return false;
  if (couldBe(parts[3], PROC_PRIVATE_ENTRIES)) return true;
  return couldBe(parts[3], ["task"]) && pidLike(parts[4]) && couldBe(parts[5], PROC_PRIVATE_ENTRIES);
}

export type SecretContext = {
  home: string;
  /** The app's own data directory (activity log, catalog). */
  appData?: string;
};

/** Expands ~ and resolves against cwd; symlinks followed when the path exists. */
export function resolvePath(raw: string, cwd: string, home: string): string {
  let p = raw;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  else if (p === "$HOME" || p === "${HOME}") p = home;
  else if (p.startsWith("$HOME/")) p = join(home, p.slice(6));
  else if (p.startsWith("${HOME}/")) p = join(home, p.slice(8));
  const abs = normalize(isAbsolute(p) ? p : resolve(cwd, p));
  return realish(abs);
}

/** realpath of the longest existing prefix, so new files under a symlinked dir resolve too. */
function realish(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const i = head.lastIndexOf(sep);
      if (i <= 0) return abs;
      tail.push(head.slice(i + 1));
      head = head.slice(0, i);
    }
  }
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Folders outside home where the Flatpak sandbox has its own copy and the
 * person can create files on the computer, so a link planted there on the
 * host can't be seen from the sandbox.
 */
const SANDBOX_OWN_COPY = ["/tmp", "/var/tmp", "/dev/shm", "/run", "/var/run"];

/**
 * Flatpak: can the policy, looking at the sandbox's files, not vouch for
 * this path on the computer? Only the home folder is shared; a wildcard
 * elsewhere would expand against the sandbox's files.
 */
export function sandboxCantCheck(abs: string, wildcard: boolean, home: string): boolean {
  const h = realish(home);
  if (under(abs, h) || under(canonical(abs), canonical(h))) return false;
  return wildcard || SANDBOX_OWN_COPY.some((d) => under(canonical(abs), d));
}

/** Is this path (as a tool would resolve it) the home folder or inside it? */
export function insideHome(raw: string, cwd: string, home: string): boolean {
  return under(resolvePath(raw, cwd, home), realish(home));
}

function secretDirs(ctx: SecretContext): string[] {
  const home = realish(ctx.home);
  const dirs = HOME_SECRET_DIRS.map((d) => join(home, d));
  if (ctx.appData) dirs.push(realish(ctx.appData));
  return dirs;
}

/**
 * macOS (development only) resolves /etc to /private/etc and /home to
 * /System/Volumes/Data/home; map them back so checks match Linux.
 */
function canonical(abs: string): string {
  return abs.replace(/^\/private(?=\/(etc|var|tmp)(\/|$))/, "").replace(/^\/System\/Volumes\/Data(?=\/home(\/|$))/, "");
}

/** Is reading this (absolute, resolved) path private? */
export function isSecretPath(abs: string, ctx: SecretContext): boolean {
  const alt = canonical(abs);
  return secretAt(abs, ctx) || (alt !== abs && secretAt(alt, ctx));
}

function secretAt(abs: string, ctx: SecretContext): boolean {
  if (procPrivate(abs)) return true;
  // A trailing "_" marks a file-name prefix (ssh_host_*_key); others are files or folders.
  if (SYSTEM_SECRET_PREFIXES.some((p) => (p.endsWith("_") ? abs.startsWith(p) : abs === p || abs.startsWith(`${p}/`)))) return true;
  if (secretDirs(ctx).some((d) => under(abs, d))) return true;
  const home = realish(ctx.home);
  if (HOME_SECRET_FILES.some((f) => abs === join(home, f))) return true;
  const name = abs.slice(abs.lastIndexOf(sep) + 1);
  if (SECRET_NAMES.some((re) => re.test(name))) return true;
  // Other people's home folders.
  if (/^\/home\/[^/]+/.test(abs) && !under(abs, home)) return true;
  return false;
}

/**
 * Would a recursive search rooted here reach private files? True if the root
 * is itself private or contains a private directory (searching the whole
 * home folder includes ~/.mozilla, for instance).
 */
export function searchReachesSecrets(raw: string, ctx: SecretContext): boolean {
  if (isSecretPath(raw, ctx)) return true;
  const root = canonical(raw);
  const home = canonical(realish(ctx.home));
  if (root === "/" || root === "/home" || under(home, root)) return true;
  if (root === "/proc" || under(root, "/proc")) return true;
  // /etc's secrets (shadow, NetworkManager system-connections) are root-only;
  // searching it as the user can't read them, and sudo searches always ask.
  return secretDirs(ctx).map(canonical).some((d) => under(d, root));
}
