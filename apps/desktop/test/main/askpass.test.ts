import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovedSudo,
  AskpassServer,
  elevatedCommands,
  sudoShim,
  sudoTarget,
  type AskpassRequest,
  type ProcInfo,
  type ProcessInspector,
} from "../../src/main/safety/askpass";

const HELPER = "/opt/fml/resources/bin/linux-x64/fml-askpass";
const OPENCODE = 100;

class FakeProcs implements ProcessInspector {
  procs = new Map<number, ProcInfo>();
  add(pid: number, ppid: number, argv: string[], exe: string | null = null) {
    this.procs.set(pid, { pid, ppid, argv, exe });
  }
  async info(pid: number) {
    return this.procs.get(pid) ?? null;
  }
}

/** A typical chain: opencode(100) → bash(200) → sudo(300) → fml-askpass(400). */
function chain(p: FakeProcs, sudoArgv = ["/usr/bin/sudo", "-A", "apt", "install", "vlc"]) {
  p.add(OPENCODE, 1, ["opencode", "serve"]);
  p.add(200, OPENCODE, ["/bin/bash", "-c", "sudo apt install vlc"]);
  p.add(300, 200, sudoArgv);
  p.add(400, 300, [HELPER, "[sudo] password for ana: "], HELPER);
}

function ask(socketPath: string, msg: object): Promise<{ ok: boolean; password?: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath, () => s.write(`${JSON.stringify(msg)}\n`));
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => (buf += c));
    s.on("end", () => resolve(JSON.parse(buf)));
    s.on("error", reject);
  });
}

describe("AskpassServer", () => {
  let dir: string;
  let procs: FakeProcs;
  let approved: ApprovedSudo;
  let shown: AskpassRequest[];
  let server: AskpassServer;
  let socketPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ap"));
    socketPath = join(dir, "rt", "s");
    procs = new FakeProcs();
    approved = new ApprovedSudo();
    shown = [];
    server = new AskpassServer({
      socketPath,
      helperPath: HELPER,
      rootPid: () => OPENCODE,
      approved: (c) => approved.has(c),
      inspector: procs,
      show: (r) => shown.push(r),
      hide: () => undefined,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a private socket", async () => {
    expect((await stat(join(dir, "rt"))).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("shows the prompt for an approved command and returns the password", async () => {
    chain(procs);
    approved.add("sudo apt install vlc");
    const answer = ask(socketPath, { v: 1, pid: 400, ppid: 300, prompt: "[sudo] password for ana: " });
    await expect.poll(() => shown.length).toBe(1);
    expect(shown[0]).toMatchObject({ command: "apt install vlc", attempt: 1 });
    server.answer(shown[0]!.id, "hunter2");
    expect(await answer).toEqual({ ok: true, password: "hunter2" });
  });

  it("counts retries after a wrong password", async () => {
    chain(procs);
    approved.add("sudo apt install vlc");
    const first = ask(socketPath, { v: 1, pid: 400, ppid: 300, prompt: "" });
    await expect.poll(() => shown.length).toBe(1);
    server.answer(shown[0]!.id, "wrong");
    await first;
    procs.add(401, 300, [HELPER], HELPER);
    const second = ask(socketPath, { v: 1, pid: 401, ppid: 300, prompt: "" });
    await expect.poll(() => shown.length).toBe(2);
    expect(shown[1]!.attempt).toBe(2);
    server.answer(shown[1]!.id, null);
    expect(await second).toEqual({ ok: false });
  });

  it.each([
    ["the command was never approved", () => chain(procs)],
    ["the caller is not our helper", () => {
      chain(procs);
      approved.add("sudo apt install vlc");
      procs.add(400, 300, ["/tmp/evil"], "/tmp/evil");
    }],
    ["the parent is not sudo", () => {
      chain(procs, ["/bin/bash", "-c", "x"]);
      approved.add("sudo apt install vlc");
    }],
    ["sudo was not started by the assistant", () => {
      chain(procs);
      approved.add("sudo apt install vlc");
      procs.add(200, 1, ["/bin/bash"]);
    }],
    ["sudo is running something else", () => {
      chain(procs, ["/usr/bin/sudo", "-A", "rm", "-rf", "/etc"]);
      approved.add("sudo apt install vlc");
    }],
  ])("refuses without showing anything when %s", async (_why, setup) => {
    setup();
    expect(await ask(socketPath, { v: 1, pid: 400, ppid: 300, prompt: "" })).toEqual({ ok: false });
    expect(shown).toEqual([]);
  });

  it("refuses a lying ppid", async () => {
    chain(procs);
    approved.add("sudo apt install vlc");
    expect(await ask(socketPath, { v: 1, pid: 400, ppid: 999, prompt: "" })).toEqual({ ok: false });
  });

  it("refuses malformed requests", async () => {
    expect(await ask(socketPath, { v: 2, pid: 1, ppid: 1, prompt: "" })).toEqual({ ok: false });
  });
});

describe("AskpassServer in Flatpak", () => {
  it("names the one running approved sudo command, and refuses otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ap"));
    let active: string | null = "systemctl restart NetworkManager";
    const shown: AskpassRequest[] = [];
    const server = new AskpassServer({
      socketPath: join(dir, "s"),
      helperPath: HELPER,
      rootPid: () => undefined,
      approved: () => false,
      inspector: new FakeProcs(),
      flatpak: true,
      activeSudo: () => active,
      show: (r) => shown.push(r),
      hide: () => undefined,
    });
    await server.start();
    try {
      const a = ask(join(dir, "s"), { v: 1, pid: 5, ppid: 4, prompt: "" });
      await expect.poll(() => shown.length).toBe(1);
      expect(shown[0]!.command).toBe("systemctl restart NetworkManager");
      server.answer(shown[0]!.id, "pw");
      expect(await a).toEqual({ ok: true, password: "pw" });

      active = null;
      expect(await ask(join(dir, "s"), { v: 1, pid: 6, ppid: 4, prompt: "" })).toEqual({ ok: false });
      expect(shown).toHaveLength(1);
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("matching helpers", () => {
  it("extracts every elevated command from a bash line", () => {
    expect(elevatedCommands("sudo apt update && sudo apt install -y vlc")).toEqual(["apt update", "apt install -y vlc"]);
    expect(elevatedCommands("echo 'x=1' | sudo tee /etc/sysctl.d/99.conf")).toEqual(["tee /etc/sysctl.d/99.conf"]);
    expect(elevatedCommands("ls -la")).toEqual([]);
  });

  it("reads sudo's target from its argv, ignoring quotes", () => {
    expect(sudoTarget(["/usr/bin/sudo", "-A", "apt", "install", "vlc"])).toBe("apt install vlc");
    expect(sudoTarget(["sudo", "-A", "sh", "-c", "echo hi"])).toBe("sh -c echo hi");
    expect(elevatedCommands("sudo sh -c 'echo hi'")).toEqual(["sh -c echo hi"]);
    expect(sudoTarget(["bash"])).toBeNull();
  });

  it("forgets approvals after the time limit", () => {
    let now = 0;
    const a = new ApprovedSudo(1000, () => now);
    a.add("sudo apt update");
    expect(a.has("apt update")).toBe(true);
    now = 2000;
    expect(a.has("apt update")).toBe(false);
  });
});

describe("sudoShim", () => {
  it("bakes in quoted paths and always uses askpass", () => {
    const shim = sudoShim("/run/user/1000/fix my linux/fml-askpass", "/run/user/1000/it's/s");
    expect(shim).toContain("export SUDO_ASKPASS='/run/user/1000/fix my linux/fml-askpass'");
    expect(shim).toContain("export FML_ASKPASS_SOCKET='/run/user/1000/it'\\''s/s'");
    expect(shim).toContain('exec "$candidate" -A "$@"');
  });
});
