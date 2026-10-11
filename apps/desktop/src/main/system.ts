import { execFile } from "node:child_process";
import { access, readFile, statfs } from "node:fs/promises";
import { cpus, freemem, hostname, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import type { HealthItem, SystemFact, SystemSample } from "../shared/system";
import { hostCommand } from "./host";

/**
 * What the Home screen shows: facts about the computer, live usage samples,
 * and a quick read-only health check. All of it is read locally by the app
 * (no AI involved, nothing sent anywhere) using fixed commands. In the
 * Flatpak build, anything about the installed system (os-release, package
 * managers, services) is read on the host; the kernel, /proc and the home
 * folder are shared with the sandbox.
 */

const run = promisify(execFile);

async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseOsRelease(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/** MemAvailable is what's really free on Linux; os.freemem() ignores reclaimable cache. */
export function parseMeminfo(raw: string): { totalKB: number; availableKB: number } | null {
  const total = /^MemTotal:\s+(\d+)/m.exec(raw);
  const avail = /^MemAvailable:\s+(\d+)/m.exec(raw);
  if (!total || !avail) return null;
  return { totalKB: Number(total[1]), availableKB: Number(avail[1]) };
}

/** Sums received/sent bytes over real interfaces in /proc/net/dev. */
export function parseNetDev(raw: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of raw.split("\n").slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!.trim();
    if (name === "lo" || name.startsWith("docker") || name.startsWith("veth") || name.startsWith("virbr")) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    rx += f[0] ?? 0;
    tx += f[8] ?? 0;
  }
  return { rx, tx };
}

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)} GB`;
}

const MANAGERS: Array<[name: string, path: string]> = [
  ["apt", "/usr/bin/apt"],
  ["dnf", "/usr/bin/dnf"],
  ["pacman", "/usr/bin/pacman"],
  ["zypper", "/usr/bin/zypper"],
  ["Flatpak", "/usr/bin/flatpak"],
  ["Snap", "/usr/bin/snap"],
];

async function osRelease(flatpak: boolean): Promise<string> {
  if (!flatpak) return (await text("/etc/os-release")) ?? "";
  // Flatpak exposes the host's copy; older versions don't, so ask the host.
  return (await text("/run/host/os-release")) ?? (await lines("cat", ["/etc/os-release"], true)).join("\n");
}

async function installedManagers(flatpak: boolean): Promise<string[]> {
  if (!flatpak) {
    const found = await Promise.all(MANAGERS.map(async ([name, path]) => ((await exists(path)) ? name : null)));
    return found.filter((n): n is string => n !== null);
  }
  // One host round trip: a fixed script, with the paths passed as arguments.
  const present = new Set(
    await lines("/bin/sh", ["-c", 'for p in "$@"; do [ -x "$p" ] && echo "$p"; done; exit 0', "fml", ...MANAGERS.map(([, p]) => p)], true),
  );
  return MANAGERS.filter(([, p]) => present.has(p)).map(([name]) => name);
}

export async function facts(home: string, flatpak = false): Promise<SystemFact[]> {
  const os = parseOsRelease(await osRelease(flatpak));
  const cpu = cpus();
  const disk = await statfs(home).catch(() => null);
  const managers = await installedManagers(flatpak);
  const out: SystemFact[] = [
    {
      key: "system",
      title: os["PRETTY_NAME"] ?? (process.platform === "darwin" ? "macOS (development)" : "Linux"),
      body: `${process.platform === "linux" ? "Linux" : "Darwin"} kernel ${release()}${process.env["XDG_CURRENT_DESKTOP"] ? `, ${process.env["XDG_CURRENT_DESKTOP"]} desktop` : ""}${process.env["XDG_SESSION_TYPE"] ? ` on ${process.env["XDG_SESSION_TYPE"] === "wayland" ? "Wayland" : "X11"}` : ""}.`,
      detail: hostname(),
      source: "/etc/os-release",
    },
    {
      key: "hardware",
      title: cpu[0]?.model.replace(/\s+/g, " ").trim() ?? "Processor",
      body: `${cpu.length} processor threads and ${gib(totalmem())} of memory.`,
      detail: `${cpu.length} threads`,
      source: "lscpu",
    },
  ];
  if (disk) {
    const total = disk.blocks * disk.bsize;
    const free = disk.bavail * disk.bsize;
    out.push({
      key: "disk",
      title: "Storage",
      body: `${gib(free)} free of ${gib(total)} on the disk with your home folder.`,
      detail: `${Math.round((1 - free / total) * 100)}% used`,
      source: "df -h ~",
    });
  }
  if (managers.length) {
    out.push({
      key: "software",
      title: "Installing software",
      body: `This computer installs apps with ${managers.join(", ")}.`,
      detail: `${managers.length} available`,
      source: "which apt dnf pacman flatpak snap",
    });
  }
  return out;
}

/** Samples CPU, memory, disk and network usage; call sample() on an interval. */
export class Sampler {
  private prevCpu = cpuTimes();
  private prevNet: { rx: number; tx: number; at: number } | null = null;

  constructor(private readonly home: string) {}

  async sample(): Promise<SystemSample> {
    const now = cpuTimes();
    const dTotal = now.total - this.prevCpu.total;
    const cpu = dTotal > 0 ? Math.max(0, Math.min(100, (1 - (now.idle - this.prevCpu.idle) / dTotal) * 100)) : 0;
    this.prevCpu = now;

    const mem = parseMeminfo((await text("/proc/meminfo")) ?? "");
    const memory = mem ? (1 - mem.availableKB / mem.totalKB) * 100 : (1 - freemem() / totalmem()) * 100;

    const disk = await statfs(this.home).catch(() => null);
    const diskUsed = disk ? (1 - disk.bavail / disk.blocks) * 100 : 0;

    let rxRate = 0;
    let txRate = 0;
    const netRaw = await text("/proc/net/dev");
    if (netRaw) {
      const n = parseNetDev(netRaw);
      const at = Date.now();
      if (this.prevNet && at > this.prevNet.at) {
        const secs = (at - this.prevNet.at) / 1000;
        rxRate = Math.max(0, (n.rx - this.prevNet.rx) / secs);
        txRate = Math.max(0, (n.tx - this.prevNet.tx) / secs);
      }
      this.prevNet = { ...n, at };
    }
    return { time: Date.now() / 1000, cpu, memory, disk: diskUsed, rxRate, txRate };
  }
}

async function lines(cmd: string, args: string[], flatpak: boolean): Promise<string[]> {
  const c = hostCommand(flatpak, cmd, args);
  try {
    const { stdout } = await run(c.file, c.args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

/** A quick read-only health check; each finding comes with a plain request for the assistant. */
export async function health(home: string, flatpak = false): Promise<HealthItem[]> {
  const items: HealthItem[] = [];

  const disk = await statfs(home).catch(() => null);
  if (disk) {
    const used = 1 - disk.bavail / disk.blocks;
    if (used >= 0.9) {
      items.push({
        key: "disk",
        title: `Your disk is ${Math.round(used * 100)}% full`,
        body: "When the disk fills up, apps stop saving and updates fail. I can find what's taking space and clear the safe stuff.",
        confidence: used >= 0.95 ? "high" : "medium",
        prompt: "My disk is almost full. Can you find what's taking up space and clear what's safe to remove?",
      });
    }
  }

  const mem = parseMeminfo((await text("/proc/meminfo")) ?? "");
  if (mem && mem.availableKB / mem.totalKB < 0.1) {
    items.push({
      key: "memory",
      title: "Your computer is low on memory",
      body: "Things may feel slow. I can see which apps are using the most memory.",
      confidence: "medium",
      prompt: "My computer feels slow and seems low on memory. Can you find out what's using it?",
    });
  }

  if (process.platform === "linux") {
    const failed = await lines("systemctl", ["--failed", "--no-legend", "--plain", "--no-pager"], flatpak);
    if (failed.length) {
      const names = failed.map((l) => l.split(/\s+/)[0]).filter(Boolean);
      items.push({
        key: "services",
        title: `${failed.length} system service${failed.length === 1 ? "" : "s"} failed to start`,
        body: `Something didn't start properly (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}). I can look into why.`,
        confidence: "high",
        prompt: `These system services failed to start: ${names.join(", ")}. Can you find out why and fix them if it's safe?`,
      });
    }
  }

  const days = uptime() / 86400;
  if (days > 30) {
    items.push({
      key: "uptime",
      title: `Your computer hasn't restarted in ${Math.floor(days)} days`,
      body: "Some updates only take effect after a restart.",
      confidence: "medium",
      prompt: "My computer hasn't been restarted in a long time. Are there updates waiting for a restart?",
    });
  }
  return items;
}
