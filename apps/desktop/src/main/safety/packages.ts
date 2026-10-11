import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { PackageChange } from "../../shared/approvals";
import { hostCommand } from "../host";
import { stripElevation } from "./risk";
import { parse } from "./shell";

/**
 * Previews what a package command will really do, using the package
 * manager's own dry run, so the approval card can show "this also removes
 * 40 packages" before anyone clicks Allow. apt only for now: its simulation
 * needs no root and has a stable, parseable output.
 */

const APT_VERBS = new Set(["install", "remove", "purge", "autoremove", "upgrade", "full-upgrade", "dist-upgrade", "reinstall"]);
/**
 * Flags kept in the dry run so it matches the real one. Everything else is
 * dropped: the arguments come from the agent, and options like -o and -c
 * can set hook commands.
 */
const SAFE_FLAGS = new Set(["--no-install-recommends", "--install-recommends", "--install-suggests", "--reinstall", "--purge", "--only-upgrade", "-f", "--fix-broken", "--auto-remove", "--autoremove"]);

/** Options that take a value and can set hooks: dropped together with the value. */
const DROP_WITH_VALUE = new Set(["-o", "--option", "-c", "--config-file"]);
/** Options that take a harmless value that changes the result: kept with it. */
const KEEP_WITH_VALUE = new Set(["-t", "--target-release", "-a", "--host-architecture"]);

/** The apt-get arguments to simulate, or null if the command isn't a single apt change. */
export function aptSimulation(command: string): string[] | null {
  const parsed = parse(command);
  if (!parsed.ok) return null;
  for (const c of parsed.commands) {
    const words = c.argv.map((w) => (w.dynamic || w.glob ? null : w.text));
    if (words.some((w) => w === null)) continue;
    const { inner } = stripElevation((words as string[]).join(" "));
    const tokens = inner.split(/\s+/).filter(Boolean);
    const tool = tokens[0] ? basename(tokens[0]) : "";
    if (tool !== "apt" && tool !== "apt-get") continue;
    let verb: string | null = null;
    const flags: string[] = [];
    const packages: string[] = [];
    const rest = tokens.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (DROP_WITH_VALUE.has(t)) {
        i++;
        continue;
      }
      if (KEEP_WITH_VALUE.has(t)) {
        const value = rest[++i];
        if (value && /^[A-Za-z0-9.+:~_-]+$/.test(value)) flags.push(t, value);
        continue;
      }
      if (t.startsWith("-")) {
        if (SAFE_FLAGS.has(t)) flags.push(t);
        continue;
      }
      if (verb === null) verb = t;
      else if (/^[A-Za-z0-9.+:~_=/-]+$/.test(t)) packages.push(t);
    }
    if (!verb || !APT_VERBS.has(verb)) continue;
    return ["-s", verb, ...flags, ...packages];
  }
  return null;
}

/** Parses `apt-get -s` output into the changes it lists. */
export function parseAptSimulation(out: string): PackageChange[] {
  const changes: PackageChange[] = [];
  for (const line of out.split("\n")) {
    const inst = /^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)/.exec(line);
    if (inst) {
      const [, name, from, to] = inst;
      changes.push(from ? { kind: "update", name: name!, detail: `${from} → ${to}` } : { kind: "add", name: name!, detail: to! });
      continue;
    }
    const remv = /^Remv (\S+)(?: \[([^\]]+)\])?/.exec(line);
    if (remv) changes.push({ kind: "remove", name: remv[1]!, detail: remv[2] ?? "" });
  }
  return changes;
}

const run = promisify(execFile);

export type Preview = (command: string) => Promise<PackageChange[] | null>;

/** Runs the dry run with a fixed program and argument list (no shell), on the host in Flatpak. */
export function packagePreview(flatpak: boolean): Preview {
  return async (command) => {
    const args = aptSimulation(command);
    if (!args) return null;
    // An absolute path: the dry run starts before anyone approves anything, so a
    // program planted earlier in PATH (~/.local/bin) must not run instead.
    const c = hostCommand(flatpak, "/usr/bin/apt-get", args, { LANG: "C", LC_ALL: "C", DEBIAN_FRONTEND: "noninteractive" });
    try {
      const { stdout } = await run(c.file, c.args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...c.env } });
      return parseAptSimulation(stdout);
    } catch {
      return null;
    }
  };
}
