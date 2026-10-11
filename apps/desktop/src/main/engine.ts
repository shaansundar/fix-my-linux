import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ApprovalDecision, AuditEntry, PendingApproval } from "../shared/approvals";
import type { BlockedNotice, EngineState, ModelOption, PasswordRequest, SessionSummary } from "../shared/ipc";
import { emptySession, emptyState, explanationFor, hydrate, reduce, type ChatState, type OpencodeEvent, type SessionView } from "../shared/session";
import { fetchBackendCatalog, fetchPublicCatalog, freePlan, isFree, writeCatalog, type CatalogResponse } from "./catalog";
import { askpassPath, binaryPath, pickVariant } from "./opencode/binary";
import { AGENT_ID, buildConfig, PROVIDER_ID } from "./opencode/config";
import { buildOpencodeEnv } from "./opencode/env";
import { sessionDenyRules } from "./opencode/permissions";
import { Supervisor } from "./opencode/process";
import { ModelRelay, type Upstream } from "./relay";
import { ApprovedSudo, AskpassServer, elevatedCommands, ProcFs, PsInspector, sudoShim } from "./safety/askpass";
import { AuditLog } from "./safety/audit";
import { ApprovalBroker, type PermissionRequest } from "./safety/broker";
import { packagePreview } from "./safety/packages";

export type EngineMode =
  /** Production: our backend proxies Zen and serves the catalog. */
  | { kind: "backend"; apiBase: string }
  /** Development: talk to Zen directly with a personal key; free models only. */
  | { kind: "dev-zen"; zenKey: string }
  /** Tests and E2E: any upstream plus a catalog file ({ provider, plan }). */
  | { kind: "custom"; upstreamURL: string; upstreamKey: string; catalogFile: string };

export type EngineDeps = {
  mode: EngineMode;
  resourcesDir: string;
  dataDir: string;
  home: string;
  flatpak: boolean;
  askpassSocket: string;
  deviceToken(): string | null;
  alwaysAsk(): boolean;
  emit: {
    state(s: EngineState): void;
    event(e: OpencodeEvent): void;
    approvals(pending: PendingApproval[]): void;
    activity(e: AuditEntry): void;
    blocked(n: BlockedNotice): void;
    passwords(pending: PasswordRequest[]): void;
  };
  log?(line: string): void;
  cpuinfo?(): Promise<string>;
};

/** Events the renderer needs; everything else stays in the main process. */
const FORWARDED = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "todo.updated",
  "question.asked",
  "question.replied",
  "question.rejected",
]);

export class Engine {
  private relay: ModelRelay | null = null;
  private supervisor: Supervisor | null = null;
  private client: OpencodeClient | null = null;
  private catalog: CatalogResponse | null = null;
  private chat: ChatState = emptyState;
  private pumpAbort: AbortController | null = null;
  private state: EngineState = { state: "starting" };
  readonly audit: AuditLog;
  readonly broker: ApprovalBroker;
  private readonly approvedSudo = new ApprovedSudo();
  private askpass: AskpassServer | null = null;
  private worktree = "/";

  constructor(private readonly deps: EngineDeps) {
    this.audit = new AuditLog(join(deps.dataDir, "activity.jsonl"));
    this.audit.onEntry((e) => deps.emit.activity(e));
    this.broker = new ApprovalBroker({
      reply: async (requestID, reply, message) => {
        await this.requireClient().permission.reply({ requestID, reply, ...(message ? { message } : {}) });
      },
      explanationFor: (req) => (req.tool ? explanationFor(this.chat, req.sessionID, req.tool.messageID, req.tool.callID) : null),
      show: () => deps.emit.approvals(this.broker.list()),
      hide: () => deps.emit.approvals(this.broker.list()),
      audit: (e) => {
        // A command the person allowed may now ask for the sudo password.
        if (e.kind === "command" && (e.decision === "approved" || e.decision === "approved-similar")) {
          this.approvedSudo.add(e.subject);
        }
        this.audit.record(e);
      },
      home: deps.home,
      policy: () => ({ home: deps.home, cwd: deps.home, appData: deps.dataDir }),
      worktree: () => this.worktree,
      alwaysAsk: () => deps.alwaysAsk(),
      previewPackages: process.platform === "linux" ? packagePreview(deps.flatpak) : undefined,
      sandboxed: deps.flatpak,
    });
  }

  getState(): EngineState {
    return this.state;
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.deps.emit.state(s);
  }

  async start(): Promise<void> {
    this.setState({ state: "starting" });
    try {
      await mkdir(this.deps.dataDir, { recursive: true, mode: 0o700 });
      await this.audit.load();
      this.catalog = await this.loadCatalog();
      const modelsPath = join(this.deps.dataDir, "models.json");
      await writeCatalog(modelsPath, this.catalog.provider);

      const nonce = randomBytes(24).toString("hex");
      this.relay = new ModelRelay(nonce, () => this.upstream());
      this.relay.on("blocked", (b) => this.deps.emit.blocked(b));
      this.relay.on("error", (err) => this.deps.log?.(`relay: ${err.message}`));
      const relayOrigin = await this.relay.start();

      const variant = pickVariant(process.platform, process.arch, (await this.deps.cpuinfo?.()) ?? (await readCpuinfo()));
      // The shim and (for Flatpak, where sudo runs on the host) the helper live
      // in the private runtime dir, which the host can see too.
      const runtime = dirname(this.deps.askpassSocket);
      const shimDir = join(runtime, "shim");
      await mkdir(shimDir, { recursive: true, mode: 0o700 });
      let askpassBin = askpassPath(this.deps.resourcesDir, variant);
      if (this.deps.flatpak) {
        const hostVisible = join(runtime, "fml-askpass");
        await copyFile(askpassBin, hostVisible);
        askpassBin = hostVisible;
      }
      await writeFile(join(shimDir, "sudo"), sudoShim(askpassBin, this.deps.askpassSocket), { mode: 0o700 });
      this.askpass = new AskpassServer({
        socketPath: this.deps.askpassSocket,
        helperPath: askpassBin,
        rootPid: () => this.supervisor?.pid,
        approved: (c) => this.approvedSudo.has(c),
        activeSudo: () => this.activeSudo(),
        flatpak: this.deps.flatpak,
        inspector: process.platform === "linux" ? new ProcFs() : new PsInspector(),
        show: () => this.deps.emit.passwords(this.askpass?.list() ?? []),
        hide: () => this.deps.emit.passwords(this.askpass?.list() ?? []),
        log: (l) => this.deps.log?.(l),
      });
      await this.askpass.start();
      const password = randomBytes(24).toString("hex");
      const config = buildConfig({
        relayOrigin,
        relayNonce: nonce,
        plan: this.catalog.plan,
        promptFile: join(this.deps.resourcesDir, "prompts/fixer.md"),
        shellPath: join(this.deps.resourcesDir, "shell/bash"),
      });
      const env = buildOpencodeEnv({
        base: process.env,
        dataDir: join(this.deps.dataDir, "opencode"),
        serverPassword: password,
        configContent: JSON.stringify(config),
        modelsPath,
        shimDir,
        shellDir: join(this.deps.resourcesDir, "shell"),
        flatpak: this.deps.flatpak,
      });

      this.supervisor = new Supervisor(() => ({
        binary: binaryPath(this.deps.resourcesDir, variant),
        env,
        cwd: this.deps.home,
        onLog: (l) => this.deps.log?.(`[opencode] ${l}`),
      }));
      this.supervisor.on("ready", (url) => {
        this.client = createOpencodeClient({
          baseUrl: url,
          directory: this.deps.home,
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        });
        void this.pump();
        void this.client.path
          .get({ directory: this.deps.home })
          .then((r) => {
            const wt = (r.data as { worktree?: string } | undefined)?.worktree;
            if (wt) this.worktree = wt;
          })
          .catch(() => undefined);
        this.setState({ state: "ready" });
      });
      this.supervisor.on("down", (reason) => {
        this.deps.log?.(`opencode down: ${reason}`);
        this.pumpAbort?.abort();
        this.setState({ state: "starting" });
      });
      this.supervisor.on("failed", (err) => this.setState({ state: "error", message: err.message }));
      await this.supervisor.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`engine start failed: ${message}`);
      await this.stop();
      this.setState({ state: "error", message });
    }
  }

  async stop(): Promise<void> {
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    await this.supervisor?.stop();
    this.supervisor = null;
    await this.relay?.stop();
    this.relay = null;
    await this.askpass?.stop();
    this.askpass = null;
    this.client = null;
  }

  /**
   * For Flatpak: the approved sudo command that is running, if it is the only
   * command running anywhere. Anything else is ambiguous and gets no prompt.
   */
  private activeSudo(): string | null {
    const running: string[] = [];
    for (const session of Object.values(this.chat.sessions)) {
      for (const m of session.messages) {
        if (m.role !== "assistant") continue;
        for (const it of m.items) {
          if (it.kind === "tool" && it.tool === "bash" && (it.status === "running" || it.status === "pending")) running.push(it.subject);
        }
      }
    }
    if (running.length !== 1) return null;
    const elevated = elevatedCommands(running[0]!);
    return elevated.length === 1 && this.approvedSudo.has(elevated[0]!) ? elevated[0]! : null;
  }

  passwords(): PasswordRequest[] {
    return this.askpass?.list() ?? [];
  }

  answerPassword(id: string, password: string | null): void {
    this.askpass?.answer(id, password);
  }

  /** Restart opencode, e.g. after the plan changed (new model list). */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private upstream(): Upstream {
    const mode = this.deps.mode;
    switch (mode.kind) {
      case "backend":
        return { baseURL: `${mode.apiBase}/zen/v1`, credential: () => this.deps.deviceToken(), style: "bearer" };
      case "dev-zen":
        return { baseURL: "https://opencode.ai/zen/v1", credential: () => mode.zenKey, style: "preserve" };
      case "custom":
        return { baseURL: mode.upstreamURL, credential: () => mode.upstreamKey, style: "preserve" };
    }
  }

  private async loadCatalog(): Promise<CatalogResponse> {
    const mode = this.deps.mode;
    switch (mode.kind) {
      case "backend": {
        const token = this.deps.deviceToken();
        if (!token) throw new Error("not signed in");
        return fetchBackendCatalog(mode.apiBase, token, AbortSignal.timeout(15000));
      }
      case "dev-zen":
        return freePlan(await fetchPublicCatalog(AbortSignal.timeout(15000)));
      case "custom":
        return JSON.parse(await readFile(mode.catalogFile, "utf8")) as CatalogResponse;
    }
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("the assistant is still starting");
    return this.client;
  }

  /** Reads opencode's event stream until aborted, reconnecting if it drops. */
  private async pump(): Promise<void> {
    this.pumpAbort?.abort();
    const abort = new AbortController();
    this.pumpAbort = abort;
    let delay = 250;
    while (!abort.signal.aborted && this.client) {
      try {
        const sub = await this.client.event.subscribe({ directory: this.deps.home }, { signal: abort.signal });
        delay = 250;
        for await (const raw of sub.stream) {
          this.handle(raw as OpencodeEvent);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        this.deps.log?.(`event stream: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  private handle(e: OpencodeEvent): void {
    const before = this.chat;
    this.chat = reduce(this.chat, e);
    const p = e.properties ?? {};

    if (e.type === "permission.asked") {
      void this.broker.onAsked(p as unknown as PermissionRequest).catch((err) => this.deps.log?.(`broker: ${String(err)}`));
    } else if (e.type === "permission.replied") {
      this.broker.onReplied(String(p["requestID"]));
    } else if (e.type === "session.deleted") {
      this.broker.forgetSession(String(p["sessionID"] ?? ""));
    } else if (e.type === "message.part.updated") {
      const part = p["part"] as { type?: string; tool?: string; callID?: string; state?: Record<string, unknown> } | undefined;
      const status = part?.state?.["status"];
      if (part?.type === "tool" && (status === "completed" || status === "error")) {
        const sessionID = String(p["sessionID"] ?? "");
        const input = (part.state?.["input"] ?? {}) as Record<string, unknown>;
        const meta = (part.state?.["metadata"] ?? {}) as Record<string, unknown>;
        const error = String(part.state?.["error"] ?? "");
        this.audit.toolFinished({
          sessionID,
          callID: part.callID ?? "",
          tool: part.tool ?? "",
          subject: String(input["command"] ?? input["filePath"] ?? input["url"] ?? ""),
          ok: status === "completed",
          exitCode: typeof meta["exit"] === "number" ? meta["exit"] : null,
          rejected: /rejected permission|blocked by Fix My Linux/i.test(error),
        });
      }
    }
    if (FORWARDED.has(e.type) && this.chat !== before) this.deps.emit.event(e);
    else if (e.type.startsWith("question.")) this.deps.emit.event(e);
  }

  // ── Chat API ────────────────────────────────────────────────

  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.requireClient().session.list({ directory: this.deps.home });
    const sessions = (res.data ?? []) as Array<{ id: string; title?: string; parentID?: string; time?: { updated?: number } }>;
    return sessions
      .filter((s) => !s.parentID)
      .map((s) => ({ id: s.id, title: s.title ?? "", updatedAt: s.time?.updated ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async openSession(sessionID: string): Promise<SessionView> {
    const client = this.requireClient();
    const [info, messages] = await Promise.all([
      client.session.get({ sessionID }),
      client.session.messages({ sessionID }),
    ]);
    const title = (info.data as { title?: string } | undefined)?.title ?? "";
    const history = (messages.data ?? []) as unknown as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    const view = hydrate(emptySession(sessionID, title), history);
    const live = this.chat.sessions[sessionID];
    const merged: SessionView = live ? { ...view, todos: live.todos, status: live.status, questions: live.questions } : view;
    this.chat = { sessions: { ...this.chat.sessions, [sessionID]: merged } };
    return merged;
  }

  async createSession(): Promise<string> {
    const res = await this.requireClient().session.create({ permission: sessionDenyRules() });
    const id = (res.data as { id?: string } | undefined)?.id;
    if (!id) throw new Error("could not start a new chat");
    return id;
  }

  async send(sessionID: string, text: string, modelID?: string): Promise<void> {
    const plan = this.catalog?.plan;
    if (!plan) throw new Error("the assistant is still starting");
    const model = modelID && plan.allowed.includes(modelID) ? modelID : plan.defaultModel;
    await this.requireClient().session.promptAsync({
      sessionID,
      agent: AGENT_ID,
      model: { providerID: PROVIDER_ID, modelID: model },
      parts: [{ type: "text", text }],
    });
  }

  async stopSession(sessionID: string): Promise<void> {
    await this.requireClient().session.abort({ sessionID });
  }

  async removeSession(sessionID: string): Promise<void> {
    await this.requireClient().session.delete({ sessionID });
    this.broker.forgetSession(sessionID);
  }

  async decide(id: string, decision: ApprovalDecision): Promise<void> {
    await this.broker.decide(id, decision);
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    await this.requireClient().question.reply({ requestID, answers });
  }

  async rejectQuestion(requestID: string): Promise<void> {
    await this.requireClient().question.reject({ requestID });
  }

  models(): ModelOption[] {
    if (!this.catalog) return [];
    const { provider, plan } = this.catalog;
    return plan.allowed
      .map((id) => provider.models[id])
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ id: m.id, name: m.name, free: isFree(m), recommended: m.id === plan.defaultModel }));
  }
}

async function readCpuinfo(): Promise<string> {
  try {
    return await readFile("/proc/cpuinfo", "utf8");
  } catch {
    return "";
  }
}
