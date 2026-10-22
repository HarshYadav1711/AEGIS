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
  VaultNote,
  VaultRecord,
  VaultSearchResult,
  ResearchInterpretation,
  ResearchTaskDetail,
  ResearchTaskSummary,
  RepoInterpretation,
  RepoProposalOutcome,
  RepoTaskDetail,
  RepoTaskSummary,
  SpeechResult,
  TranscriptResult,
  VoiceInterpretation,
  VoiceStatus,
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
  vaultList: 'aegis:vault:list',
  vaultChoose: 'aegis:vault:choose',
  vaultReindex: 'aegis:vault:reindex',
  vaultSetWriteArea: 'aegis:vault:set-write-area',
  vaultRemove: 'aegis:vault:remove',
  vaultSearch: 'aegis:vault:search',
  vaultAddNote: 'aegis:vault:add-note',
  vaultOpenNote: 'aegis:vault:open-note',
  repoInterpret: 'aegis:repo:interpret',
  repoChoose: 'aegis:repo:choose-repo',
  repoGetTask: 'aegis:repo:get-task',
  repoListTasks: 'aegis:repo:list-tasks',
  repoApprove: 'aegis:repo:approve',
  repoReject: 'aegis:repo:reject',
  repoCancel: 'aegis:repo:cancel',
  repoSave: 'aegis:repo:save',
  repoOpenReport: 'aegis:repo:open-report',
  repoAcceptProposal: 'aegis:repo:accept-proposal',
  voiceStatus: 'aegis:voice:status',
  voiceTranscribe: 'aegis:voice:transcribe',
  voiceCancel: 'aegis:voice:cancel',
  voiceInterpret: 'aegis:voice:interpret',
  voiceApplyCorrection: 'aegis:voice:apply-correction',
  voiceSpeak: 'aegis:voice:speak',
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
  listVaults: () => ipcRenderer.invoke(channels.vaultList) as Promise<ChatResult<VaultRecord[]>>,
  chooseVault: () => ipcRenderer.invoke(channels.vaultChoose) as Promise<ChatResult<VaultRecord | null>>,
  reindexVault: (id) => ipcRenderer.invoke(channels.vaultReindex, id) as Promise<ChatResult<VaultRecord>>,
  setVaultWriteArea: (args) => ipcRenderer.invoke(channels.vaultSetWriteArea, args) as Promise<ChatResult<VaultRecord>>,
  removeVault: (id) => ipcRenderer.invoke(channels.vaultRemove, id) as Promise<ChatResult<true>>,
  searchVaults: (query) => ipcRenderer.invoke(channels.vaultSearch, query) as Promise<ChatResult<VaultSearchResult>>,
  addVaultNote: (args) => ipcRenderer.invoke(channels.vaultAddNote, args) as Promise<ChatResult<VaultNote>>,
  openVaultNote: (id) => ipcRenderer.invoke(channels.vaultOpenNote, id) as Promise<ChatResult<true>>,
  interpretRepoRequest: (args) =>
    ipcRenderer.invoke(channels.repoInterpret, args) as Promise<ChatResult<RepoInterpretation>>,
  chooseRepoForTask: (taskId) =>
    ipcRenderer.invoke(channels.repoChoose, taskId) as Promise<ChatResult<RepoTaskDetail | null>>,
  getRepoTask: (taskId) => ipcRenderer.invoke(channels.repoGetTask, taskId) as Promise<ChatResult<RepoTaskDetail>>,
  listRepoTasks: () => ipcRenderer.invoke(channels.repoListTasks) as Promise<ChatResult<RepoTaskSummary[]>>,
  approveRepoPlan: (args) => ipcRenderer.invoke(channels.repoApprove, args) as Promise<ChatResult<RepoTaskDetail>>,
  rejectRepoPlan: (taskId) => ipcRenderer.invoke(channels.repoReject, taskId) as Promise<ChatResult<RepoTaskDetail>>,
  cancelRepoTask: (taskId) => ipcRenderer.invoke(channels.repoCancel, taskId) as Promise<ChatResult<RepoTaskDetail>>,
  saveRepoReport: (taskId) =>
    ipcRenderer.invoke(channels.repoSave, taskId) as Promise<ChatResult<RepoTaskDetail | null>>,
  openRepoReport: (taskId) => ipcRenderer.invoke(channels.repoOpenReport, taskId) as Promise<ChatResult<true>>,
  acceptRepoProposal: (args) =>
    ipcRenderer.invoke(channels.repoAcceptProposal, args) as Promise<ChatResult<RepoProposalOutcome>>,
  getVoiceStatus: () => ipcRenderer.invoke(channels.voiceStatus) as Promise<ChatResult<VoiceStatus>>,
  transcribe: (args) => ipcRenderer.invoke(channels.voiceTranscribe, args) as Promise<ChatResult<TranscriptResult>>,
  cancelVoiceJob: (requestId) => ipcRenderer.invoke(channels.voiceCancel, requestId) as Promise<ChatResult<true>>,
  interpretVoice: (args) =>
    ipcRenderer.invoke(channels.voiceInterpret, args) as Promise<ChatResult<VoiceInterpretation>>,
  applyVoiceCorrection: (args) =>
    ipcRenderer.invoke(channels.voiceApplyCorrection, args) as Promise<ChatResult<MemoryRecord>>,
  speak: (args) => ipcRenderer.invoke(channels.voiceSpeak, args) as Promise<ChatResult<SpeechResult>>,
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(bridge));
