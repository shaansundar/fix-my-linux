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
const PROC_PRIVATE = /^\/proc\/(self|thread-self|\d+)(\/task\/\d+)?\/(environ|mem|fd|fdinfo|map_files|cwd|root|auxv|pagemap|syscall|stack)(\/|$)/;

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
  if (PROC_PRIVATE.test(abs)) return true;
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
