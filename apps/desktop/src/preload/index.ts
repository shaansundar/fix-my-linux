import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type FmlApi } from "../shared/ipc";

function on<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: FmlApi = {
  engine: {
    state: () => ipcRenderer.invoke(CH.engineState),
    onState: (cb) => on(CH.engineOnState, cb),
    restart: () => ipcRenderer.invoke(CH.engineRestart),
  },
  chat: {
    list: () => ipcRenderer.invoke(CH.chatList),
    open: (id) => ipcRenderer.invoke(CH.chatOpen, id),
    create: () => ipcRenderer.invoke(CH.chatCreate),
    send: (id, text, model) => ipcRenderer.invoke(CH.chatSend, id, text, model),
    stop: (id) => ipcRenderer.invoke(CH.chatStop, id),
    remove: (id) => ipcRenderer.invoke(CH.chatRemove, id),
    onEvent: (cb) => on(CH.chatEvent, cb),
  },
  approvals: {
    list: () => ipcRenderer.invoke(CH.approvalsList),
    decide: (id, decision) => ipcRenderer.invoke(CH.approvalsDecide, id, decision),
    onChange: (cb) => on(CH.approvalsChange, cb),
  },
  questions: {
    reply: (id, answers) => ipcRenderer.invoke(CH.questionReply, id, answers),
    reject: (id) => ipcRenderer.invoke(CH.questionReject, id),
  },
  models: {
    list: () => ipcRenderer.invoke(CH.modelsList),
  },
  activity: {
    list: () => ipcRenderer.invoke(CH.activityList),
    onEntry: (cb) => on(CH.activityEntry, cb),
  },
  notices: {
    onBlocked: (cb) => on(CH.blocked, cb),
  },
  account: {
    state: () => ipcRenderer.invoke(CH.accountState),
    onChange: (cb) => on(CH.accountChange, cb),
    startSignIn: (email) => ipcRenderer.invoke(CH.accountStart, email),
    verify: (email, code) => ipcRenderer.invoke(CH.accountVerify, email, code),
    subscribe: () => ipcRenderer.invoke(CH.accountSubscribe),
    manage: () => ipcRenderer.invoke(CH.accountManage),
    refresh: () => ipcRenderer.invoke(CH.accountRefresh),
    signOut: () => ipcRenderer.invoke(CH.accountSignOut),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    update: (patch) => ipcRenderer.invoke(CH.settingsUpdate, patch),
  },
  system: {
    facts: () => ipcRenderer.invoke(CH.systemFacts),
    health: () => ipcRenderer.invoke(CH.systemHealth),
    history: () => ipcRenderer.invoke(CH.systemHistory),
    onSample: (cb) => on(CH.systemSample, cb),
  },
  password: {
    list: () => ipcRenderer.invoke(CH.passwordList),
    answer: (id, password) => ipcRenderer.invoke(CH.passwordAnswer, id, password),
    onChange: (cb) => on(CH.passwordChange, cb),
  },
};

contextBridge.exposeInMainWorld("fml", api);
