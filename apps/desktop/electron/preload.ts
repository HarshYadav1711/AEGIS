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
  FileInterpretation,
  FileTaskDetail,
  FileTaskProgressEvent,
  FileTaskRecord,
  IpcChannel,
  MemoryAddOutcome,
  MemoryList,
  MemoryRecord,
  MemorySettings,
  ResearchInterpretation,
  ResearchTaskDetail,
  ResearchTaskSummary,
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
  filesInterpret: 'aegis:files:interpret',
  filesChooseFolder: 'aegis:files:choose-folder',
  filesGetTask: 'aegis:files:get-task',
  filesListTasks: 'aegis:files:list-tasks',
  filesApprove: 'aegis:files:approve',
  filesReject: 'aegis:files:reject',
  filesCancel: 'aegis:files:cancel',
  filesReplan: 'aegis:files:replan',
  filesEvent: 'aegis:files:event',
  researchInterpret: 'aegis:research:interpret',
  researchGetTask: 'aegis:research:get-task',
  researchListTasks: 'aegis:research:list-tasks',
  researchApprove: 'aegis:research:approve',
  researchReject: 'aegis:research:reject',
  researchCancel: 'aegis:research:cancel',
  researchSave: 'aegis:research:save',
  researchOpenReport: 'aegis:research:open-report',
  memoryList: 'aegis:memory:list',
  memoryAdd: 'aegis:memory:add',
  memoryCorrect: 'aegis:memory:correct',
  memoryDecide: 'aegis:memory:decide',
  memorySetSettings: 'aegis:memory:set-settings',
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
  interpretFileRequest: (args) =>
    ipcRenderer.invoke(channels.filesInterpret, args) as Promise<ChatResult<FileInterpretation>>,
  chooseFolderForTask: (taskId) =>
    ipcRenderer.invoke(channels.filesChooseFolder, taskId) as Promise<ChatResult<FileTaskDetail | null>>,
  getFileTask: (taskId) => ipcRenderer.invoke(channels.filesGetTask, taskId) as Promise<ChatResult<FileTaskDetail>>,
  listFileTasks: () => ipcRenderer.invoke(channels.filesListTasks) as Promise<ChatResult<FileTaskRecord[]>>,
  approveFilePlan: (args) => ipcRenderer.invoke(channels.filesApprove, args) as Promise<ChatResult<FileTaskDetail>>,
  rejectFilePlan: (args) => ipcRenderer.invoke(channels.filesReject, args) as Promise<ChatResult<FileTaskDetail>>,
  cancelFileTask: (taskId) => ipcRenderer.invoke(channels.filesCancel, taskId) as Promise<ChatResult<FileTaskDetail>>,
  replanFileTask: (taskId) => ipcRenderer.invoke(channels.filesReplan, taskId) as Promise<ChatResult<FileTaskDetail>>,
  onFileTaskEvent: (listener) => subscribe<FileTaskProgressEvent>(channels.filesEvent, listener),
  interpretResearchRequest: (args) =>
    ipcRenderer.invoke(channels.researchInterpret, args) as Promise<ChatResult<ResearchInterpretation>>,
  getResearchTask: (taskId) =>
    ipcRenderer.invoke(channels.researchGetTask, taskId) as Promise<ChatResult<ResearchTaskDetail>>,
  listResearchTasks: () => ipcRenderer.invoke(channels.researchListTasks) as Promise<ChatResult<ResearchTaskSummary[]>>,
  approveResearchPlan: (taskId) =>
    ipcRenderer.invoke(channels.researchApprove, taskId) as Promise<ChatResult<ResearchTaskDetail>>,
  rejectResearchPlan: (taskId) =>
    ipcRenderer.invoke(channels.researchReject, taskId) as Promise<ChatResult<ResearchTaskDetail>>,
  cancelResearchTask: (taskId) =>
    ipcRenderer.invoke(channels.researchCancel, taskId) as Promise<ChatResult<ResearchTaskDetail>>,
  saveResearchReport: (taskId) =>
    ipcRenderer.invoke(channels.researchSave, taskId) as Promise<ChatResult<ResearchTaskDetail | null>>,
  openResearchReport: (taskId) => ipcRenderer.invoke(channels.researchOpenReport, taskId) as Promise<ChatResult<true>>,
  listMemories: (args) => ipcRenderer.invoke(channels.memoryList, args) as Promise<ChatResult<MemoryList>>,
  addMemory: (args) =>
    ipcRenderer.invoke(channels.memoryAdd, args) as Promise<
      ChatResult<{ memory: MemoryRecord; outcome: MemoryAddOutcome }>
    >,
  correctMemory: (args) => ipcRenderer.invoke(channels.memoryCorrect, args) as Promise<ChatResult<MemoryRecord>>,
  decideMemory: (args) => ipcRenderer.invoke(channels.memoryDecide, args) as Promise<ChatResult<true>>,
  setMemorySettings: (settings) =>
    ipcRenderer.invoke(channels.memorySetSettings, settings) as Promise<ChatResult<MemorySettings>>,
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(bridge));
