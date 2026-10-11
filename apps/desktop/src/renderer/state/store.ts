import { useSyncExternalStore } from "react";
import type { AccountState } from "../../shared/account";
import type { ApprovalDecision, AuditEntry, PendingApproval } from "../../shared/approvals";
import type { BlockedNotice, EngineState, FmlApi, ModelOption, PasswordRequest, SessionSummary } from "../../shared/ipc";
import { emptyState, reduce, type ChatState, type OpencodeEvent } from "../../shared/session";

export type View =
  | { kind: "chat"; sessionID: string | null }
  | { kind: "home" }
  | { kind: "activity" }
  | { kind: "settings" };

export type AppState = {
  engine: EngineState;
  sessions: SessionSummary[];
  chat: ChatState;
  approvals: PendingApproval[];
  models: ModelOption[];
  model: string | null;
  view: View;
  notice: BlockedNotice | null;
  activity: AuditEntry[];
  passwords: PasswordRequest[];
  account: AccountState;
  /** A message is on its way (between pressing send and the session going busy). */
  sending: boolean;
  error: string | null;
};

const initial: AppState = {
  engine: { state: "starting" },
  sessions: [],
  chat: emptyState,
  approvals: [],
  models: [],
  model: null,
  view: { kind: "chat", sessionID: null },
  notice: null,
  activity: [],
  passwords: [],
  account: { status: "signed-out", weakStorage: false },
  sending: false,
  error: null,
};

/** A tiny external store; the renderer's single source of truth. */
export function createStore(api: FmlApi) {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    for (const l of listeners) l();
  };
  const fail = (err: unknown) => set({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err), sending: false });

  let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshSessions = () => {
    if (sessionsTimer) return;
    sessionsTimer = setTimeout(async () => {
      sessionsTimer = null;
      try {
        set({ sessions: await api.chat.list() });
      } catch {
        // the engine may be restarting; the next event retries
      }
    }, 150);
  };

  const onReady = async () => {
    try {
      const [sessions, models, approvals, activity, passwords] = await Promise.all([
        api.chat.list(),
        api.models.list(),
        api.approvals.list(),
        api.activity.list(),
        api.password.list(),
      ]);
      set((s) => ({
        sessions,
        models,
        approvals,
        activity,
        passwords,
        model: s.model && models.some((m) => m.id === s.model) ? s.model : (models.find((m) => m.recommended)?.id ?? models[0]?.id ?? null),
      }));
    } catch (err) {
      fail(err);
    }
  };

  const actions = {
    async init() {
      api.engine.onState((engine) => {
        set({ engine });
        if (engine.state === "ready") void onReady();
      });
      api.chat.onEvent((e: OpencodeEvent) => {
        set((s) => ({
          chat: reduce(s.chat, e),
          sending: e.type === "session.status" ? false : s.sending,
        }));
        if (e.type === "session.created" || e.type === "session.updated" || e.type === "session.deleted") refreshSessions();
      });
      api.approvals.onChange((approvals) => set({ approvals }));
      api.activity.onEntry((entry) =>
        set((s) => ({ activity: [entry, ...s.activity.filter((a) => a.id !== entry.id)] })),
      );
      api.notices.onBlocked((notice) => set({ notice, sending: false }));
      api.password.onChange((passwords) => set({ passwords }));
      api.account.onChange((account) =>
        set((s) => ({
          account,
          // A fresh account state supersedes an old paywall or budget notice.
          notice: account.account?.state === "active" ? null : s.notice,
        })),
      );
      set({ account: await api.account.state() });
      const engine = await api.engine.state();
      set({ engine });
      if (engine.state === "ready") await onReady();
    },

    navigate(view: View) {
      set({ view, error: null });
      if (view.kind === "chat" && view.sessionID) void actions.open(view.sessionID);
    },

    async open(sessionID: string) {
      try {
        const view = await api.chat.open(sessionID);
        set((s) => ({ chat: { sessions: { ...s.chat.sessions, [sessionID]: view } } }));
      } catch (err) {
        fail(err);
      }
    },

    newChat() {
      set({ view: { kind: "chat", sessionID: null }, error: null });
    },

    async send(text: string) {
      const view = state.view;
      if (view.kind !== "chat" || !text.trim()) return;
      set({ sending: true, error: null });
      try {
        let id = view.sessionID;
        if (!id) {
          id = await api.chat.create();
          set({ view: { kind: "chat", sessionID: id } });
        }
        await api.chat.send(id, text, state.model ?? undefined);
      } catch (err) {
        fail(err);
      }
    },

    async stop() {
      const view = state.view;
      if (view.kind !== "chat" || !view.sessionID) return;
      await api.chat.stop(view.sessionID).catch(fail);
    },

    async remove(sessionID: string) {
      await api.chat.remove(sessionID).catch(fail);
      if (state.view.kind === "chat" && state.view.sessionID === sessionID) actions.newChat();
      refreshSessions();
    },

    async decide(id: string, decision: ApprovalDecision) {
      await api.approvals.decide(id, decision).catch(fail);
    },

    async answer(questionID: string, answers: string[][]) {
      await api.questions.reply(questionID, answers).catch(fail);
    },

    async dismissQuestion(questionID: string) {
      await api.questions.reject(questionID).catch(fail);
    },

    async startSignIn(email: string) {
      await api.account.startSignIn(email);
    },

    async verify(email: string, code: string) {
      await api.account.verify(email, code);
    },

    async subscribe() {
      await api.account.subscribe().catch(fail);
    },

    async manage() {
      await api.account.manage().catch(fail);
    },

    async refreshAccount() {
      await api.account.refresh().catch(fail);
    },

    async signOut() {
      await api.account.signOut().catch(fail);
      set({ view: { kind: "chat", sessionID: null }, sessions: [], chat: emptyState });
    },

    async answerPassword(id: string, password: string | null) {
      await api.password.answer(id, password).catch(fail);
    },

    setModel(model: string) {
      set({ model });
    },

    dismissNotice() {
      set({ notice: null });
    },

    dismissError() {
      set({ error: null });
    },

    async restartEngine() {
      await api.engine.restart().catch(fail);
    },
  };

  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    actions,
  };
}

export type Store = ReturnType<typeof createStore>;

let singleton: Store | null = null;
export function store(): Store {
  if (!singleton) singleton = createStore(window.fml);
  return singleton;
}

export function useApp<T>(select: (s: AppState) => T): T {
  const s = store();
  return useSyncExternalStore(s.subscribe, () => select(s.get()));
}
