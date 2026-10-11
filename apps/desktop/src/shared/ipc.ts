/** The API the preload script exposes to the renderer as `window.fml`. */
import type { AccountState } from "./account";
import type { ApprovalDecision, AuditEntry, PendingApproval } from "./approvals";
import type { OpencodeEvent, SessionView } from "./session";

export type EngineState =
  | { state: "signed-out" }
  | { state: "starting" }
  | { state: "ready" }
  | { state: "error"; message: string };

export type SessionSummary = { id: string; title: string; updatedAt: number };

export type ModelOption = { id: string; name: string; free: boolean; recommended: boolean };

export type BlockedNotice = {
  code: string;
  message: string;
  status: number;
  resetsAt?: string;
};

/** sudo is waiting for the administrator password. */
export type PasswordRequest = { id: string; command: string; attempt: number };

export type Unsubscribe = () => void;

export type FmlApi = {
  engine: {
    state(): Promise<EngineState>;
    onState(cb: (s: EngineState) => void): Unsubscribe;
    restart(): Promise<void>;
  };
  chat: {
    list(): Promise<SessionSummary[]>;
    open(sessionID: string): Promise<SessionView>;
    create(): Promise<string>;
    send(sessionID: string, text: string, modelID?: string): Promise<void>;
    stop(sessionID: string): Promise<void>;
    remove(sessionID: string): Promise<void>;
    onEvent(cb: (e: OpencodeEvent) => void): Unsubscribe;
  };
  approvals: {
    list(): Promise<PendingApproval[]>;
    decide(id: string, decision: ApprovalDecision): Promise<void>;
    onChange(cb: (pending: PendingApproval[]) => void): Unsubscribe;
  };
  questions: {
    reply(id: string, answers: string[][]): Promise<void>;
    reject(id: string): Promise<void>;
  };
  models: {
    list(): Promise<ModelOption[]>;
  };
  activity: {
    list(): Promise<AuditEntry[]>;
    onEntry(cb: (e: AuditEntry) => void): Unsubscribe;
  };
  notices: {
    onBlocked(cb: (n: BlockedNotice) => void): Unsubscribe;
  };
  account: {
    state(): Promise<AccountState>;
    onChange(cb: (s: AccountState) => void): Unsubscribe;
    startSignIn(email: string): Promise<void>;
    verify(email: string, code: string): Promise<void>;
    /** Opens the payment page in the browser and watches for the subscription. */
    subscribe(): Promise<void>;
    /** Opens the billing portal in the browser. */
    manage(): Promise<void>;
    refresh(): Promise<void>;
    signOut(): Promise<void>;
  };
  password: {
    list(): Promise<PasswordRequest[]>;
    /** null cancels; the password is never stored. */
    answer(id: string, password: string | null): Promise<void>;
    onChange(cb: (pending: PasswordRequest[]) => void): Unsubscribe;
  };
};

/** Channel names, so main and preload can't drift apart. */
export const CH = {
  engineState: "engine:state",
  engineOnState: "engine:on-state",
  engineRestart: "engine:restart",
  chatList: "chat:list",
  chatOpen: "chat:open",
  chatCreate: "chat:create",
  chatSend: "chat:send",
  chatStop: "chat:stop",
  chatRemove: "chat:remove",
  chatEvent: "chat:event",
  approvalsList: "approvals:list",
  approvalsDecide: "approvals:decide",
  approvalsChange: "approvals:change",
  questionReply: "question:reply",
  questionReject: "question:reject",
  modelsList: "models:list",
  activityList: "activity:list",
  activityEntry: "activity:entry",
  blocked: "notices:blocked",
  accountState: "account:state",
  accountChange: "account:change",
  accountStart: "account:start",
  accountVerify: "account:verify",
  accountSubscribe: "account:subscribe",
  accountManage: "account:manage",
  accountRefresh: "account:refresh",
  accountSignOut: "account:signout",
  passwordList: "password:list",
  passwordAnswer: "password:answer",
  passwordChange: "password:change",
} as const;
