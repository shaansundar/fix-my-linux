import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { ApprovalDecision } from "../shared/approvals";
import { CH } from "../shared/ipc";
import type { EngineState } from "../shared/ipc";
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

export function registerIpc(win: () => BrowserWindow | null, engine: () => Engine | null, actions: { restart(): Promise<void>; state(): EngineState }): void {
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

  handle(CH.modelsList, () => engine()?.models() ?? []);
  handle(CH.activityList, () => engine()?.audit.list() ?? []);
}
