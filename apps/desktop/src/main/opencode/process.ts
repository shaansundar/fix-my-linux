import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const LISTENING = /opencode server listening on (http:\/\/[^\s]+)/;

export type ProcessOptions = {
  binary: string;
  env: Record<string, string>;
  cwd: string;
  startTimeoutMs?: number;
  onLog?: (line: string) => void;
};

/** One `opencode serve` process bound to a random loopback port. */
export class OpencodeProcess {
  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    private readonly exited: Promise<number | null>,
  ) {}

  static start(opts: ProcessOptions): Promise<OpencodeProcess> {
    const child = spawn(opts.binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error(`opencode did not start within ${opts.startTimeoutMs ?? 20000}ms`));
        child.kill("SIGKILL");
      }, opts.startTimeoutMs ?? 20000);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const onLine = (line: string) => {
        opts.onLog?.(line);
        const m = LISTENING.exec(line);
        if (m?.[1] && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(new OpencodeProcess(child, m[1].replace(/\/$/, ""), exited));
        }
      };
      lines(child.stdout!, onLine);
      lines(child.stderr!, (l) => opts.onLog?.(l));

      child.once("error", (err) => fail(new Error(`failed to start opencode: ${err.message}`)));
      child.once("exit", (code, signal) => fail(new Error(`opencode exited before listening (code ${code}, signal ${signal})`)));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves with the exit code once the process is gone. */
  waitForExit(): Promise<number | null> {
    return this.exited;
  }

  async stop(graceMs = 3000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(timer);
  }
}

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  });
}

export type SupervisorEvents = {
  ready: [url: string];
  down: [reason: string];
  failed: [error: Error];
};

/**
 * Keeps opencode running: restarts it with exponential backoff when it dies,
 * and gives up after repeated fast failures so the UI can show an error.
 */
export class Supervisor extends EventEmitter<SupervisorEvents> {
  private current: OpencodeProcess | null = null;
  private stopping = false;
  private failures = 0;
  private startedAt = 0;

  constructor(
    private readonly options: () => ProcessOptions,
    private readonly maxFailures = 5,
  ) {
    super();
  }

  get url(): string | null {
    return this.current?.url ?? null;
  }

  get pid(): number | undefined {
    return this.current?.pid;
  }

  async start(): Promise<string> {
    this.stopping = false;
    const proc = await OpencodeProcess.start(this.options());
    this.current = proc;
    this.startedAt = Date.now();
    this.emit("ready", proc.url);
    void this.watch(proc);
    return proc.url;
  }

  private async watch(proc: OpencodeProcess): Promise<void> {
    const code = await proc.waitForExit();
    if (this.stopping || this.current !== proc) return;
    this.current = null;
    // A process that ran for a while earned a fresh set of retries.
    if (Date.now() - this.startedAt > 60_000) this.failures = 0;
    this.emit("down", `opencode exited with code ${code}`);
    await this.restart();
  }

  private async restart(): Promise<void> {
    while (!this.stopping) {
      this.failures++;
      if (this.failures > this.maxFailures) {
        this.emit("failed", new Error("opencode keeps crashing"));
        return;
      }
      await delay(Math.min(500 * 2 ** (this.failures - 1), 8000));
      if (this.stopping) return;
      try {
        await this.start();
        return;
      } catch (err) {
        this.emit("down", err instanceof Error ? err.message : String(err));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.current;
    this.current = null;
    await proc?.stop();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
