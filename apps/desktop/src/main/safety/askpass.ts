import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { simpleCommands } from "../opencode/wildcard";
import { stripElevation } from "./risk";

/**
 * The app side of sudo's password prompt. fml-askpass (run by sudo) connects
 * here; before showing anything we check that the caller is our helper, that
 * its parent is sudo, that sudo descends from our opencode process, and that
 * sudo is running a command the person just approved. Only then does the
 * password card appear, naming that exact command.
 *
 * In the Flatpak build sudo runs on the host (flatpak-spawn --host), outside
 * our pid namespace, so the process checks can't run. There the prompt names
 * the most recent approved sudo command, and only within two minutes of the
 * approval; that is weaker and documented as such.
 *
 * Residual risk: Node can't read SO_PEERCRED, so a malicious process of the
 * same user could claim a legitimate helper's pid. Such a process could
 * already read the user's keystrokes, so this is accepted and documented.
 */

export type ProcInfo = { pid: number; ppid: number; exe: string | null; argv: string[] };

export interface ProcessInspector {
  info(pid: number): Promise<ProcInfo | null>;
}

/** Reads /proc (Linux). */
export class ProcFs implements ProcessInspector {
  async info(pid: number): Promise<ProcInfo | null> {
    try {
      const [stat, cmdline] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/cmdline`, "utf8"),
      ]);
      // comm (field 2) is in parentheses and may contain spaces; ppid follows the state.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      let exe: string | null = null;
      try {
        exe = await readlink(`/proc/${pid}/exe`);
      } catch {
        // sudo is setuid root; its exe link isn't readable by the user
      }
      return { pid, ppid, exe, argv: cmdline.split("\0").filter(Boolean) };
    } catch {
      return null;
    }
  }
}

const run = promisify(execFile);

/** Uses `ps` (macOS development). */
export class PsInspector implements ProcessInspector {
  async info(pid: number): Promise<ProcInfo | null> {
    try {
      const { stdout } = await run("ps", ["-ww", "-o", "ppid=", "-o", "command=", "-p", String(pid)]);
      const m = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
      if (!m) return null;
      return { pid, ppid: Number(m[1]), exe: null, argv: m[2]!.split(/\s+/) };
    } catch {
      return null;
    }
  }
}

export type AskpassRequest = {
  id: string;
  /** The command sudo will run, as the person approved it. */
  command: string;
  /** 1 for the first try; higher means the previous password was wrong. */
  attempt: number;
};

type Message = { v: number; pid: number; ppid: number; prompt: string };

const unquote = (s: string) => s.replace(/['"]/g, "").replace(/\s+/g, " ").trim();

/** The commands an approved bash line will run under sudo, normalized for matching. */
export function elevatedCommands(command: string): string[] {
  return simpleCommands(command)
    .map((part) => stripElevation(part))
    .filter((p) => p.elevated && p.inner)
    .map((p) => unquote(p.inner));
}

/** What a sudo process is about to run, from its argv. */
export function sudoTarget(argv: string[]): string | null {
  if (!argv.length || basename(argv[0]!) !== "sudo") return null;
  const { inner } = stripElevation(["sudo", ...argv.slice(1)].join(" "));
  return inner ? unquote(inner) : null;
}

export type AskpassDeps = {
  socketPath: string;
  /** Absolute path of the bundled fml-askpass binary. */
  helperPath: string;
  /** The opencode process; sudo must descend from it. */
  rootPid(): number | undefined;
  /** Whether the person approved running this (normalized) command with sudo recently. */
  approved(command: string): boolean;
  inspector: ProcessInspector;
  /** Flatpak build: host processes are invisible, fall back to the latest approval. */
  flatpak?: boolean;
  latestApproved?(withinMs: number): string | null;
  show(req: AskpassRequest): void;
  hide(id: string): void;
  log?(line: string): void;
};

type Pending = { socket: Socket; req: AskpassRequest; sudoPid: number };

const MAX_ANCESTRY = 32;

export class AskpassServer {
  private server: Server | null = null;
  private pending = new Map<string, Pending>();
  /** sudo pid → how many prompts it has asked for (wrong passwords re-ask). */
  private attempts = new Map<number, number>();

  constructor(private readonly deps: AskpassDeps) {}

  async start(): Promise<void> {
    const dir = dirname(this.deps.socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await rm(this.deps.socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.deps.socketPath, () => resolve());
    });
    await chmod(this.deps.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.answer(id, null);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.deps.socketPath, { force: true });
  }

  list(): AskpassRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  /** The person typed a password (or cancelled with null). */
  answer(id: string, password: string | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.deps.hide(id);
    const body = password === null ? { ok: false } : { ok: true, password };
    p.socket.end(`${JSON.stringify(body)}\n`);
  }

  private accept(socket: Socket): void {
    let buf = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => {
      if (!handled) socket.destroy();
    });
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > 4096) return socket.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      socket.setTimeout(0);
      void this.handle(socket, buf.slice(0, nl));
    });
    socket.on("close", () => {
      for (const [id, p] of this.pending) {
        if (p.socket === socket) {
          this.pending.delete(id);
          this.deps.hide(id);
        }
      }
    });
    socket.on("error", () => undefined);
  }

  private refuse(socket: Socket, reason: string): void {
    this.deps.log?.(`askpass: refused (${reason})`);
    socket.end(`${JSON.stringify({ ok: false })}\n`);
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return this.refuse(socket, "bad request");
    }
    if (msg.v !== 1 || !Number.isInteger(msg.pid) || !Number.isInteger(msg.ppid)) return this.refuse(socket, "bad request");

    if (this.deps.flatpak) {
      const command = this.deps.latestApproved?.(120_000) ?? null;
      if (!command) return this.refuse(socket, "no recently approved sudo command");
      const attempt = (this.attempts.get(msg.ppid) ?? 0) + 1;
      this.attempts.set(msg.ppid, attempt);
      const req: AskpassRequest = { id: randomUUID(), command, attempt };
      this.pending.set(req.id, { socket, req, sudoPid: msg.ppid });
      this.deps.show(req);
      return;
    }

    const { inspector } = this.deps;
    const helper = await inspector.info(msg.pid);
    if (!helper || helper.ppid !== msg.ppid) return this.refuse(socket, "unknown helper process");
    const helperOk = helper.exe ? helper.exe === this.deps.helperPath : basename(helper.argv[0] ?? "") === "fml-askpass";
    if (!helperOk) return this.refuse(socket, "caller is not fml-askpass");

    const sudo = await inspector.info(msg.ppid);
    const command = sudo ? sudoTarget(sudo.argv) : null;
    if (!sudo || !command) return this.refuse(socket, "parent is not sudo");

    const root = this.deps.rootPid();
    if (!root || !(await this.descends(sudo.ppid, root))) return this.refuse(socket, "sudo was not started by the assistant");
    if (!this.deps.approved(command)) return this.refuse(socket, `not approved: ${command}`);

    const attempt = (this.attempts.get(sudo.pid) ?? 0) + 1;
    this.attempts.set(sudo.pid, attempt);
    const req: AskpassRequest = { id: randomUUID(), command, attempt };
    this.pending.set(req.id, { socket, req, sudoPid: sudo.pid });
    this.deps.show(req);
  }

  private async descends(pid: number, root: number): Promise<boolean> {
    let current = pid;
    for (let i = 0; i < MAX_ANCESTRY && current > 1; i++) {
      if (current === root) return true;
      const info = await this.deps.inspector.info(current);
      if (!info) return false;
      current = info.ppid;
    }
    return current === root;
  }
}

/** Remembers sudo commands the person approved, for a limited time. */
export class ApprovedSudo {
  private entries: Array<{ command: string; at: number }> = [];

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record every elevated command in an approved bash line. */
  add(bashCommand: string): void {
    const at = this.now();
    for (const command of elevatedCommands(bashCommand)) this.entries.push({ command, at });
  }

  has(command: string): boolean {
    this.prune();
    return this.entries.some((e) => e.command === command);
  }

  latest(withinMs: number): string | null {
    this.prune();
    const last = this.entries.at(-1);
    return last && last.at >= this.now() - withinMs ? last.command : null;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
  }
}
