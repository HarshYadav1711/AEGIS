// Sandboxed preload. It may only require 'electron', so the contracts module is
// imported for types alone and channel names are inlined (checked by `satisfies`).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  AegisBridge,
  AppInfo,
  BackendStatus,
  ChatMessageRecord,
  ChatOutcome,
  ChatProgressEvent,
  ChatResult,
  ConversationDetail,
  ConversationSummary,
  IpcChannel,
} from '../src/shared/contracts';

const channels = {
  getStatus: 'aegis:backend:get-status',
  restart: 'aegis:backend:restart',
  statusChanged: 'aegis:backend:status-changed',
  appInfo: 'aegis:app:get-info',
  listConversations: 'aegis:chat:list-conversations',
  createConversation: 'aegis:chat:create-conversation',
  getConversation: 'aegis:chat:get-conversation',
  send: 'aegis:chat:send',
  cancel: 'aegis:chat:cancel',
  chatEvent: 'aegis:chat:event',
} as const satisfies Record<string, IpcChannel>;

/** Subscribe without ever handing the renderer the IpcRendererEvent (which exposes `sender`). */
function subscribe<T>(channel: IpcChannel, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: AegisBridge = {
  getBackendStatus: () => ipcRenderer.invoke(channels.getStatus) as Promise<BackendStatus>,
  restartBackend: () => ipcRenderer.invoke(channels.restart) as Promise<BackendStatus>,
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo) as Promise<AppInfo>,
  onBackendStatus: (listener) => subscribe<BackendStatus>(channels.statusChanged, listener),
  listConversations: () =>
    ipcRenderer.invoke(channels.listConversations) as Promise<ChatResult<ConversationSummary[]>>,
  createConversation: () =>
    ipcRenderer.invoke(channels.createConversation) as Promise<ChatResult<ConversationSummary>>,
  getConversation: (id) => ipcRenderer.invoke(channels.getConversation, id) as Promise<ChatResult<ConversationDetail>>,
  sendMessage: (args) => ipcRenderer.invoke(channels.send, args) as Promise<ChatOutcome>,
  cancelGeneration: (id) => ipcRenderer.invoke(channels.cancel, id) as Promise<ChatResult<ChatMessageRecord>>,
  onChatEvent: (listener) => subscribe<ChatProgressEvent>(channels.chatEvent, listener),
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(bridge));
