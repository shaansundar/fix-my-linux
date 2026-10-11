import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ApprovalDecision } from "../shared/approvals";
import { CH } from "../shared/ipc";
import type { AccountState } from "../shared/account";
import type { EngineState } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import type { HealthItem, SystemFact, SystemSample } from "../shared/system";
import type { Engine } from "./engine";

const DECISIONS = new Set<ApprovalDecision>(["once", "similar", "reject"]);

/** Only our own page may call into the main process. */
function trusted(event: IpcMainInvokeEvent, win: BrowserWindow): boolean {
  if (event.sender !== win.webContents) return false;
  const url = event.senderFrame?.url ?? "";
  const dev = process.env["ELECTRON_RENDERER_URL"];
  return url.startsWith("file://") || (!!dev && url.startsWith(dev));
}

function str(v: unknown, name: string, max = 20000): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`invalid ${name}`);
  return v;
}

export function registerIpc(win: () => BrowserWindow | null, engine: () => Engine | null, actions: {
    restart(): Promise<void>;
    state(): EngineState;
    system: { facts(): Promise<SystemFact[]>; health(): Promise<HealthItem[]>; history(): SystemSample[] };
    settings: { get(): Settings; update(patch: unknown): Promise<Settings> };
    account: {
      state(): AccountState;
      start(email: string): Promise<void>;
      verify(email: string, code: string): Promise<void>;
      subscribe(): Promise<void>;
      manage(): Promise<void>;
      refresh(): Promise<void>;
      signOut(): Promise<void>;
    };
  }): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const w = win();
      if (!w || !trusted(event, w)) throw new Error("untrusted sender");
      return fn(...args);
    });
  };
  const need = () => {
    const e = engine();
    if (!e) throw new Error("the assistant is not running");
    return e;
  };

  handle(CH.engineState, () => actions.state());
  handle(CH.engineRestart, () => actions.restart());

  handle(CH.chatList, () => need().listSessions());
  handle(CH.chatOpen, (id) => need().openSession(str(id, "session")));
  handle(CH.chatCreate, () => need().createSession());
  handle(CH.chatSend, (id, text, model) =>
    need().send(str(id, "session"), str(text, "message"), typeof model === "string" ? model : undefined),
  );
  handle(CH.chatStop, (id) => need().stopSession(str(id, "session")));
  handle(CH.chatRemove, (id) => need().removeSession(str(id, "session")));

  handle(CH.approvalsList, () => engine()?.broker.list() ?? []);
  handle(CH.approvalsDecide, (id, decision) => {
    if (!DECISIONS.has(decision as ApprovalDecision)) throw new Error("invalid decision");
    return need().decide(str(id, "approval"), decision as ApprovalDecision);
  });

  handle(CH.questionReply, (id, answers) => {
    if (!Array.isArray(answers) || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"))) {
      throw new Error("invalid answers");
    }
    return need().replyQuestion(str(id, "question"), answers as string[][]);
  });
  handle(CH.questionReject, (id) => need().rejectQuestion(str(id, "question")));

  handle(CH.accountState, () => actions.account.state());
  handle(CH.accountStart, (email) => actions.account.start(str(email, "email", 254)));
  handle(CH.accountVerify, (email, code) => actions.account.verify(str(email, "email", 254), str(code, "code", 12)));
  handle(CH.accountSubscribe, () => actions.account.subscribe());
  handle(CH.accountManage, () => actions.account.manage());
  handle(CH.accountRefresh, () => actions.account.refresh());
  handle(CH.accountSignOut, () => actions.account.signOut());

  handle(CH.settingsGet, () => actions.settings.get());
  handle(CH.settingsUpdate, (patch) => actions.settings.update(patch));
  handle(CH.systemFacts, () => actions.system.facts());
  handle(CH.systemHealth, () => actions.system.health());
  handle(CH.systemHistory, () => actions.system.history());

  handle(CH.passwordList, () => engine()?.passwords() ?? []);
  handle(CH.passwordAnswer, (id, password) => {
    if (password !== null && (typeof password !== "string" || password.length > 1024)) throw new Error("invalid password");
    engine()?.answerPassword(str(id, "request"), password as string | null);
  });

  handle(CH.modelsList, () => engine()?.models() ?? []);
  handle(CH.activityList, () => engine()?.audit.list() ?? []);
}
