// Contracts shared by Electron main, preload and renderer.
//
// This file must stay free of runtime imports and non-erasable TypeScript
// syntax (enums, namespaces) so that main (tsc/CommonJS), the renderer (Vite)
// and the Node test runner (type stripping) can all load it.

/** Every IPC channel the app uses. Preload exposes nothing else. */
export type IpcChannel =
  | 'aegis:backend:get-status'
  | 'aegis:backend:restart'
  | 'aegis:backend:status-changed'
  | 'aegis:app:get-info'
  | 'aegis:chat:list-conversations'
  | 'aegis:chat:create-conversation'
  | 'aegis:chat:get-conversation'
  | 'aegis:chat:send'
  | 'aegis:chat:cancel'
  | 'aegis:chat:event'
  | 'aegis:files:interpret'
  | 'aegis:files:choose-folder'
  | 'aegis:files:get-task'
  | 'aegis:files:list-tasks'
  | 'aegis:files:approve'
  | 'aegis:files:reject'
  | 'aegis:files:cancel'
  | 'aegis:files:replan'
  | 'aegis:files:event'
  | 'aegis:research:interpret'
  | 'aegis:research:get-task'
  | 'aegis:research:list-tasks'
  | 'aegis:research:approve'
  | 'aegis:research:reject'
  | 'aegis:research:cancel'
  | 'aegis:research:save'
  | 'aegis:research:open-report'
  | 'aegis:memory:list'
  | 'aegis:memory:add'
  | 'aegis:memory:correct'
  | 'aegis:memory:decide'
  | 'aegis:memory:set-settings'
  | 'aegis:vault:list'
  | 'aegis:vault:choose'
  | 'aegis:vault:reindex'
  | 'aegis:vault:set-write-area'
  | 'aegis:vault:remove'
  | 'aegis:vault:search'
  | 'aegis:vault:add-note'
  | 'aegis:vault:open-note'
  | 'aegis:repo:interpret'
  | 'aegis:repo:choose-repo'
  | 'aegis:repo:get-task'
  | 'aegis:repo:list-tasks'
  | 'aegis:repo:approve'
  | 'aegis:repo:reject'
  | 'aegis:repo:cancel'
  | 'aegis:repo:save'
  | 'aegis:repo:open-report'
  | 'aegis:repo:accept-proposal'
  | 'aegis:voice:status'
  | 'aegis:voice:transcribe'
  | 'aegis:voice:cancel'
  | 'aegis:voice:interpret'
  | 'aegis:voice:apply-correction'
  | 'aegis:voice:speak';

/**
 * Lifecycle of the local Python core as observed by Electron main.
 * - starting: process spawned, waiting for the ready handshake / first health
 * - online:   authenticated /health succeeded and reported status "ok"
 * - degraded: /health succeeded but the core reported a failing subsystem
 * - offline:  process exited or stopped answering health checks
 * - error:    the core could not be started at all
 */
export type BackendState = 'starting' | 'online' | 'degraded' | 'offline' | 'error';

export const BACKEND_STATES: readonly BackendState[] = [
  'starting',
  'online',
  'degraded',
  'offline',
  'error',
];

export interface DatabaseHealth {
  ok: boolean;
  schemaVersion: number | null;
  journalMode: string | null;
  fts5Available: boolean | null;
}

/** Redacted model-provider status as cached by the core. Contains no credentials. */
export interface ProviderHealth {
  id: string;
  baseUrl: string;
  reachable: boolean;
  detail: string;
  models: string[];
}

/** Validated subset of the core's GET /health response. */
export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: DatabaseHealth;
  capabilities: { chat: boolean };
  provider: ProviderHealth | null;
}

export interface BackendStatus {
  state: BackendState;
  /** Human-readable explanation. Never contains credentials. */
  detail: string;
  /** ISO timestamp of the most recent health attempt, if any. */
  checkedAt: string | null;
  /** Last successful health payload while online/degraded, otherwise null. */
  health: HealthSnapshot | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  /** True when running from source (not a packaged build). */
  isDevelopment: boolean;
}

// ---------------------------------------------------------------------------
// Conversation contracts (Phase 1)
// ---------------------------------------------------------------------------

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled';
export const TERMINAL_MESSAGE_STATUSES: readonly MessageStatus[] = ['complete', 'failed', 'cancelled'];

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  /** Model output is untrusted text: render it as plain text only. */
  content: string;
  status: MessageStatus;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  /** 'voice' when the user spoke the message (transcribed locally, confirmed in the app). */
  inputMode: InputMode;
}

export type InputMode = 'text' | 'voice';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: ChatMessageRecord[];
}

export interface ChatError {
  code: string;
  detail: string;
}

export type ChatResult<T> = { ok: true; value: T } | { ok: false; error: ChatError };

export interface SendMessageArgs {
  conversationId: string;
  /** Renderer-generated UUID; a retry with the same id never creates a second turn. */
  requestId: string;
  content: string;
  model: string;
  /** Provenance only; a spoken message gains no extra authority. */
  inputMode: InputMode;
}

/** Progress pushed on 'aegis:chat:event' while a send is in flight. */
export type ChatProgressEvent =
  | { type: 'accepted'; requestId: string; userMessage: ChatMessageRecord; assistantMessage: ChatMessageRecord }
  | { type: 'streaming'; requestId: string; messageId: string }
  | { type: 'delta'; requestId: string; messageId: string; text: string };

/**
 * How a send ended (the resolved value of `sendMessage`).
 * - complete / failed / cancelled: terminal state the core persisted.
 * - rejected: the core refused the request before creating a turn (nothing persisted).
 * - disconnected: the stream broke after the turn was accepted; the stored state is
 *   whatever the core recorded (it marks such replies failed/interrupted).
 */
export type ChatOutcome =
  | { type: 'complete' | 'cancelled'; message: ChatMessageRecord }
  | { type: 'failed'; message: ChatMessageRecord; error: ChatError }
  | { type: 'rejected'; error: ChatError }
  | { type: 'disconnected'; messageId: string | null; error: ChatError };

export const MAX_PROMPT_CHARS = 8000;

/** The only API the renderer can reach (window.aegis). */
export interface AegisBridge {
  getBackendStatus(): Promise<BackendStatus>;
  restartBackend(): Promise<BackendStatus>;
  onBackendStatus(listener: (status: BackendStatus) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  listConversations(): Promise<ChatResult<ConversationSummary[]>>;
  createConversation(): Promise<ChatResult<ConversationSummary>>;
  getConversation(conversationId: string): Promise<ChatResult<ConversationDetail>>;
  sendMessage(args: SendMessageArgs): Promise<ChatOutcome>;
  cancelGeneration(messageId: string): Promise<ChatResult<ChatMessageRecord>>;
  onChatEvent(listener: (event: ChatProgressEvent) => void): () => void;
  interpretFileRequest(args: InterpretFileRequestArgs): Promise<ChatResult<FileInterpretation>>;
  /** Opens the native folder picker in Electron main; the renderer never supplies a path. */
  chooseFolderForTask(taskId: string): Promise<ChatResult<FileTaskDetail | null>>;
  getFileTask(taskId: string): Promise<ChatResult<FileTaskDetail>>;
  listFileTasks(): Promise<ChatResult<FileTaskRecord[]>>;
  approveFilePlan(args: FilePlanDecisionArgs): Promise<ChatResult<FileTaskDetail>>;
  rejectFilePlan(args: FilePlanDecisionArgs): Promise<ChatResult<FileTaskDetail>>;
  cancelFileTask(taskId: string): Promise<ChatResult<FileTaskDetail>>;
  replanFileTask(taskId: string): Promise<ChatResult<FileTaskDetail>>;
  onFileTaskEvent(listener: (event: FileTaskProgressEvent) => void): () => void;
  interpretResearchRequest(args: InterpretResearchArgs): Promise<ChatResult<ResearchInterpretation>>;
  getResearchTask(taskId: string): Promise<ChatResult<ResearchTaskDetail>>;
  listResearchTasks(): Promise<ChatResult<ResearchTaskSummary[]>>;
  /** Approves the plan main last showed for this task (main attaches its digest). */
  approveResearchPlan(taskId: string): Promise<ChatResult<ResearchTaskDetail>>;
  rejectResearchPlan(taskId: string): Promise<ChatResult<ResearchTaskDetail>>;
  cancelResearchTask(taskId: string): Promise<ChatResult<ResearchTaskDetail>>;
  /** Opens the native folder picker in main; resolves with null if the user closes it. */
  saveResearchReport(taskId: string): Promise<ChatResult<ResearchTaskDetail | null>>;
  /** Opens the saved report (path known only to main and the core) in the default app. */
  openResearchReport(taskId: string): Promise<ChatResult<true>>;
  listMemories(args: MemoryQueryArgs): Promise<ChatResult<MemoryList>>;
  addMemory(args: AddMemoryArgs): Promise<ChatResult<{ memory: MemoryRecord; outcome: MemoryAddOutcome }>>;
  correctMemory(args: CorrectMemoryArgs): Promise<ChatResult<MemoryRecord>>;
  /** confirm / reject a memory, or permanently delete every version of it. */
  decideMemory(args: MemoryDecisionArgs): Promise<ChatResult<true>>;
  setMemorySettings(settings: MemorySettings): Promise<ChatResult<MemorySettings>>;
  listVaults(): Promise<ChatResult<VaultRecord[]>>;
  /** Opens the native folder picker in main; resolves with null if the user closes it. */
  chooseVault(): Promise<ChatResult<VaultRecord | null>>;
  reindexVault(vaultId: string): Promise<ChatResult<VaultRecord>>;
  setVaultWriteArea(args: VaultWriteAreaArgs): Promise<ChatResult<VaultRecord>>;
  /** Forgets the vault in AEGIS (index only); never touches its files. */
  removeVault(vaultId: string): Promise<ChatResult<true>>;
  searchVaults(query: string): Promise<ChatResult<VaultSearchResult>>;
  addVaultNote(args: AddVaultNoteArgs): Promise<ChatResult<VaultNote>>;
  /** Opens the note (path known only to main and the core) in the default Markdown app. */
  openVaultNote(noteId: string): Promise<ChatResult<true>>;
  interpretRepoRequest(args: InterpretResearchArgs): Promise<ChatResult<RepoInterpretation>>;
  /** Opens the native folder picker in main for the repository to inspect; null if the user closes it. */
  chooseRepoForTask(taskId: string): Promise<ChatResult<RepoTaskDetail | null>>;
  getRepoTask(taskId: string): Promise<ChatResult<RepoTaskDetail>>;
  listRepoTasks(): Promise<ChatResult<RepoTaskSummary[]>>;
  /** Approves the plan main last showed (main attaches its digest); vault consent is explicit. */
  approveRepoPlan(args: RepoApproveArgs): Promise<ChatResult<RepoTaskDetail>>;
  rejectRepoPlan(taskId: string): Promise<ChatResult<RepoTaskDetail>>;
  cancelRepoTask(taskId: string): Promise<ChatResult<RepoTaskDetail>>;
  /** Opens the native folder picker in main (never inside the repository); null if the user closes it. */
  saveRepoReport(taskId: string): Promise<ChatResult<RepoTaskDetail | null>>;
  openRepoReport(taskId: string): Promise<ChatResult<true>>;
  /** Stores one code-built memory proposal from the report as the user's own fact. */
  acceptRepoProposal(args: RepoProposalArgs): Promise<ChatResult<RepoProposalOutcome>>;
  getVoiceStatus(): Promise<ChatResult<VoiceStatus>>;
  /** One finished push-to-talk recording (16 kHz mono PCM16 WAV); transcribed locally, never stored. */
  transcribe(args: TranscribeArgs): Promise<ChatResult<TranscriptResult>>;
  /** Stops a pending transcription or speech synthesis by its request id. */
  cancelVoiceJob(requestId: string): Promise<ChatResult<true>>;
  /** Deterministic classification of a transcript; never writes anything. */
  interpretVoice(args: VoiceInterpretArgs): Promise<ChatResult<VoiceInterpretation>>;
  /** Applies a reviewed spoken memory correction (a click in the app; a new version, old one kept). */
  applyVoiceCorrection(args: VoiceCorrectionArgs): Promise<ChatResult<MemoryRecord>>;
  /** Local text-to-speech; the renderer plays the WAV and reports real playback. */
  speak(args: SpeakArgs): Promise<ChatResult<SpeechResult>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Parse the core's snake_case /health JSON into a HealthSnapshot.
 * Returns null for anything that does not match the contract exactly.
 */
export function parseHealthResponse(value: unknown): HealthSnapshot | null {
  if (!isRecord(value)) return null;
  const { status, service, version, uptime_seconds, database, capabilities, provider } = value;
  if (service !== 'aegis-core') return null;
  if (status !== 'ok' && status !== 'degraded') return null;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null;
  if (typeof uptime_seconds !== 'number' || !Number.isFinite(uptime_seconds) || uptime_seconds < 0) {
    return null;
  }
  if (!isRecord(database) || !isRecord(capabilities)) return null;
  const { ok, schema_version, journal_mode, fts5_available } = database;
  if (typeof ok !== 'boolean' || !isNullableNumber(schema_version)) return null;
  if (journal_mode !== null && typeof journal_mode !== 'string') return null;
  if (fts5_available !== null && typeof fts5_available !== 'boolean') return null;
  if (typeof capabilities.chat !== 'boolean') return null;
  const parsedProvider = provider === undefined || provider === null ? null : parseProvider(provider);
  if (parsedProvider === undefined) return null;
  return {
    status,
    version,
    uptimeSeconds: uptime_seconds,
    database: {
      ok,
      schemaVersion: schema_version,
      journalMode: journal_mode,
      fts5Available: fts5_available,
    },
    capabilities: { chat: capabilities.chat },
    provider: parsedProvider,
  };
}

/** Returns undefined (not null) when the value is present but malformed. */
function parseProvider(value: unknown): ProviderHealth | undefined {
  if (!isRecord(value)) return undefined;
  const { id, base_url, reachable, detail, models } = value;
  if (typeof id !== 'string' || typeof base_url !== 'string' || typeof reachable !== 'boolean') return undefined;
  if (typeof detail !== 'string' || !Array.isArray(models) || !models.every((m) => typeof m === 'string')) {
    return undefined;
  }
  return { id, baseUrl: base_url, reachable, detail, models: [...models] };
}

function isProviderHealth(value: unknown): value is ProviderHealth {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.reachable === 'boolean' &&
    typeof value.detail === 'string' &&
    Array.isArray(value.models) &&
    value.models.every((m) => typeof m === 'string')
  );
}

function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (!isRecord(value) || !isRecord(value.database) || !isRecord(value.capabilities)) return false;
  const db = value.database;
  return (
    (value.status === 'ok' || value.status === 'degraded') &&
    typeof value.version === 'string' &&
    typeof value.uptimeSeconds === 'number' &&
    typeof db.ok === 'boolean' &&
    isNullableNumber(db.schemaVersion) &&
    (db.journalMode === null || typeof db.journalMode === 'string') &&
    (db.fts5Available === null || typeof db.fts5Available === 'boolean') &&
    typeof value.capabilities.chat === 'boolean' &&
    (value.provider === null || isProviderHealth(value.provider))
  );
}

/** Runtime guard for status objects crossing the IPC boundary. */
export function isBackendStatus(value: unknown): value is BackendStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.state === 'string' &&
    (BACKEND_STATES as readonly string[]).includes(value.state) &&
    typeof value.detail === 'string' &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    (value.health === null || isHealthSnapshot(value.health))
  );
}

// ---------------------------------------------------------------------------
// Conversation payload parsing (core snake_case JSON → contracts) and IPC
// argument validation. Anything that does not match exactly is rejected.
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MESSAGE_STATUSES: readonly MessageStatus[] = ['pending', 'streaming', 'complete', 'failed', 'cancelled'];

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableInt(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

export function parseMessage(value: unknown): ChatMessageRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isUuid(v.conversation_id)) return null;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return null;
  if (v.role !== 'user' && v.role !== 'assistant') return null;
  if (typeof v.content !== 'string') return null;
  if (typeof v.status !== 'string' || !(MESSAGE_STATUSES as readonly string[]).includes(v.status)) return null;
  const nullableStrings = [v.provider, v.model, v.error_code, v.error_detail, v.finish_reason, v.completed_at];
  if (!nullableStrings.every(isNullableString) || typeof v.created_at !== 'string') return null;
  if (![v.prompt_tokens, v.completion_tokens, v.duration_ms].every(isNullableInt)) return null;
  if (v.input_mode !== 'text' && v.input_mode !== 'voice') return null;
  return {
    id: v.id,
    conversationId: v.conversation_id,
    seq: v.seq,
    role: v.role,
    content: v.content,
    status: v.status as MessageStatus,
    provider: v.provider as string | null,
    model: v.model as string | null,
    errorCode: v.error_code as string | null,
    errorDetail: v.error_detail as string | null,
    finishReason: v.finish_reason as string | null,
    promptTokens: v.prompt_tokens as number | null,
    completionTokens: v.completion_tokens as number | null,
    durationMs: v.duration_ms as number | null,
    createdAt: v.created_at,
    completedAt: v.completed_at as string | null,
    inputMode: v.input_mode,
  };
}

export function parseConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const { id, title, created_at, updated_at, message_count } = value;
  if (!isUuid(id) || typeof title !== 'string' || typeof created_at !== 'string') return null;
  if (typeof updated_at !== 'string' || !isNullableInt(message_count) || message_count === null) return null;
  return { id, title, createdAt: created_at, updatedAt: updated_at, messageCount: message_count };
}

function parseAll<T>(values: unknown, parse: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(values)) return null;
  const out: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

export function parseConversationList(value: unknown): ConversationSummary[] | null {
  return isRecord(value) ? parseAll(value.conversations, parseConversation) : null;
}

export function parseConversationDetail(value: unknown): ConversationDetail | null {
  if (!isRecord(value)) return null;
  const conversation = parseConversation(value.conversation);
  const messages = parseAll(value.messages, parseMessage);
  return conversation && messages ? { conversation, messages } : null;
}

function parseError(value: unknown): ChatError | null {
  if (!isRecord(value) || !isNullableString(value.code) || !isNullableString(value.detail)) return null;
  return { code: value.code ?? 'unknown', detail: value.detail ?? '' };
}

/** One NDJSON line from POST /conversations/{id}/messages, tagged with the request id. */
export function parseStreamEvent(
  requestId: string,
  value: unknown,
): ChatProgressEvent | Exclude<ChatOutcome, { type: 'rejected' | 'disconnected' }> | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'accepted': {
      const userMessage = parseMessage(value.user_message);
      const assistantMessage = parseMessage(value.assistant_message);
      return userMessage && assistantMessage ? { type: 'accepted', requestId, userMessage, assistantMessage } : null;
    }
    case 'streaming':
      return isUuid(value.message_id) ? { type: 'streaming', requestId, messageId: value.message_id } : null;
    case 'delta':
      return isUuid(value.message_id) && typeof value.text === 'string'
        ? { type: 'delta', requestId, messageId: value.message_id, text: value.text }
        : null;
    case 'complete':
    case 'cancelled': {
      const message = parseMessage(value.message);
      return message && message.status === value.type ? { type: value.type, message } : null;
    }
    case 'failed': {
      const message = parseMessage(value.message);
      const error = parseError(value.error);
      return message && error && message.status === 'failed' ? { type: 'failed', message, error } : null;
    }
    default:
      return null;
  }
}

/** Validate renderer-supplied send arguments before they reach the core. */
export function parseSendMessageArgs(value: unknown): SendMessageArgs | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'content,conversationId,inputMode,model,requestId') return null;
  const { conversationId, requestId, content, model, inputMode } = value;
  if (!isUuid(conversationId) || !isUuid(requestId)) return null;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_PROMPT_CHARS) return null;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) return null;
  if (inputMode !== 'text' && inputMode !== 'voice') return null;
  return { conversationId, requestId, content, model, inputMode };
}

export function isChatProgressEvent(value: unknown): value is ChatProgressEvent {
  if (!isRecord(value) || !isUuid(value.requestId)) return false;
  switch (value.type) {
    case 'accepted':
      return isRecord(value.userMessage) && isRecord(value.assistantMessage);
    case 'streaming':
      return isUuid(value.messageId);
    case 'delta':
      return isUuid(value.messageId) && typeof value.text === 'string';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// File-organization task contracts (Phase 2)
// ---------------------------------------------------------------------------

export type FileTaskStatus =
  | 'awaiting_folder'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'rejected';

export const FILE_TASK_STATUSES: readonly FileTaskStatus[] = [
  'awaiting_folder',
  'planning',
  'awaiting_approval',
  'executing',
  'completed',
  'partial',
  'failed',
  'unknown',
  'cancelled',
  'rejected',
];
export const TERMINAL_FILE_TASK_STATUSES: readonly FileTaskStatus[] = [
  'completed',
  'partial',
  'failed',
  'unknown',
  'cancelled',
  'rejected',
];

export type FileOperationStatus =
  | 'planned'
  | 'skipped'
  | 'started'
  | 'verified'
  | 'failed'
  | 'unknown'
  | 'not_attempted';
const FILE_OPERATION_STATUSES: readonly FileOperationStatus[] = [
  'planned',
  'skipped',
  'started',
  'verified',
  'failed',
  'unknown',
  'not_attempted',
];

export interface FileTaskRecord {
  id: string;
  /** The user's own request text (untrusted; render as plain text). */
  requestText: string;
  intentSource: 'model' | 'keyword_fallback';
  intentModel: string | null;
  intentDetail: string;
  status: FileTaskStatus;
  rootPath: string | null;
  currentPlanId: string | null;
  approvalDecision: 'approved' | 'rejected' | null;
  approvalAt: string | null;
  cancelRequested: boolean;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The plan digest stays in Electron main; the renderer approves by plan id only. */
export interface FilePlanRecord {
  id: string;
  status: string;
  rootPath: string;
  createdAt: string;
  expiresAt: string;
}

export interface FileOperationRecord {
  id: string;
  seq: number;
  action: 'move' | 'skip';
  sourceName: string;
  category: string | null;
  destRel: string | null;
  size: number | null;
  sha256: string | null;
  planReason: string | null;
  status: FileOperationStatus;
  detail: string | null;
  /** Observed checks after the move (true/false), or null when a check was not applicable. */
  verification: Record<string, boolean | null> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface FileTaskEventRecord {
  id: number;
  at: string;
  kind: string;
  detail: string;
}

export interface FileTaskDetail {
  task: FileTaskRecord;
  plan: FilePlanRecord | null;
  operations: FileOperationRecord[];
  events: FileTaskEventRecord[];
}

export interface FileInterpretation {
  intent: 'organize_by_type' | 'none';
  source: 'prefilter' | 'model' | 'keyword_fallback';
  model: string | null;
  detail: string;
  task: FileTaskDetail | null;
}

export interface InterpretFileRequestArgs {
  text: string;
  model: string | null;
}

export interface FilePlanDecisionArgs {
  taskId: string;
  planId: string;
}

/** Pushed by main on 'aegis:files:event': the folder picker closed with a choice and planning began. */
export interface FileTaskProgressEvent {
  type: 'planning';
  taskId: string;
}

export const MAX_FILE_REQUEST_CHARS = 2000;

function isVerificationRecord(value: unknown): value is Record<string, boolean | null> | null {
  return value === null || (isRecord(value) && Object.values(value).every((v) => v === null || typeof v === 'boolean'));
}

export function parseFileTask(value: unknown): FileTaskRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || typeof v.request_text !== 'string' || typeof v.intent_detail !== 'string') return null;
  if (v.intent_source !== 'model' && v.intent_source !== 'keyword_fallback') return null;
  if (typeof v.status !== 'string' || !(FILE_TASK_STATUSES as readonly string[]).includes(v.status)) return null;
  if (v.approval_decision !== null && v.approval_decision !== 'approved' && v.approval_decision !== 'rejected') {
    return null;
  }
  if (v.current_plan_id !== null && !isUuid(v.current_plan_id)) return null;
  const strings = [v.intent_model, v.root_path, v.approval_at, v.error_code, v.error_detail, v.started_at, v.finished_at];
  if (!strings.every(isNullableString)) return null;
  if (typeof v.created_at !== 'string' || typeof v.updated_at !== 'string') return null;
  if (v.cancel_requested !== 0 && v.cancel_requested !== 1) return null;
  return {
    id: v.id,
    requestText: v.request_text,
    intentSource: v.intent_source,
    intentModel: v.intent_model as string | null,
    intentDetail: v.intent_detail,
    status: v.status as FileTaskStatus,
    rootPath: v.root_path as string | null,
    currentPlanId: v.current_plan_id as string | null,
    approvalDecision: v.approval_decision as 'approved' | 'rejected' | null,
    approvalAt: v.approval_at as string | null,
    cancelRequested: v.cancel_requested === 1,
    errorCode: v.error_code as string | null,
    errorDetail: v.error_detail as string | null,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    startedAt: v.started_at as string | null,
    finishedAt: v.finished_at as string | null,
  };
}

function parseFileOperation(value: unknown): FileOperationRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return null;
  if (v.action !== 'move' && v.action !== 'skip') return null;
  if (typeof v.source_name !== 'string' || v.source_name.length === 0) return null;
  if (typeof v.status !== 'string' || !(FILE_OPERATION_STATUSES as readonly string[]).includes(v.status)) return null;
  const strings = [v.category, v.dest_rel, v.sha256, v.plan_reason, v.detail, v.started_at, v.finished_at];
  if (!strings.every(isNullableString) || !isNullableInt(v.size)) return null;
  if (!isVerificationRecord(v.verification)) return null;
  return {
    id: v.id,
    seq: v.seq,
    action: v.action,
    sourceName: v.source_name,
    category: v.category as string | null,
    destRel: v.dest_rel as string | null,
    size: v.size as number | null,
    sha256: v.sha256 as string | null,
    planReason: v.plan_reason as string | null,
    status: v.status as FileOperationStatus,
    detail: v.detail as string | null,
    verification: v.verification,
    startedAt: v.started_at as string | null,
    finishedAt: v.finished_at as string | null,
  };
}

function parseFileEvent(value: unknown): FileTaskEventRecord | null {
  if (!isRecord(value)) return null;
  const { id, at, kind, detail } = value;
  if (typeof id !== 'number' || !Number.isInteger(id) || typeof at !== 'string') return null;
  if (typeof kind !== 'string' || typeof detail !== 'string') return null;
  return { id, at, kind, detail };
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Main-process parse: the renderer-safe detail plus the plan digest that only main keeps. */
export function parseFileTaskDetailWithDigest(
  value: unknown,
): { detail: FileTaskDetail; digest: string | null } | null {
  if (!isRecord(value)) return null;
  const task = parseFileTask(value.task);
  const operations = parseAll(value.operations, parseFileOperation);
  const events = parseAll(value.events, parseFileEvent);
  if (!task || !operations || !events) return null;
  let plan: FilePlanRecord | null = null;
  let digest: string | null = null;
  if (value.plan !== null) {
    const p = value.plan;
    if (!isRecord(p) || !isUuid(p.id) || p.task_id !== task.id) return null;
    if (typeof p.digest !== 'string' || !DIGEST_PATTERN.test(p.digest)) return null;
    if (typeof p.status !== 'string' || typeof p.root_path !== 'string') return null;
    if (typeof p.created_at !== 'string' || typeof p.expires_at !== 'string') return null;
    plan = { id: p.id, status: p.status, rootPath: p.root_path, createdAt: p.created_at, expiresAt: p.expires_at };
    digest = p.digest;
  }
  return { detail: { task, plan, operations, events }, digest };
}

export function parseFileTaskList(value: unknown): FileTaskRecord[] | null {
  return isRecord(value) ? parseAll(value.tasks, parseFileTask) : null;
}

/** Validate renderer-supplied interpret arguments. */
export function parseInterpretArgs(value: unknown): InterpretFileRequestArgs | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'model,text') return null;
  const { text, model } = value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_FILE_REQUEST_CHARS) return null;
  if (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) return null;
  return { text, model };
}

/** Validate renderer-supplied approve/reject arguments: ids only, never paths or digests. */
export function parsePlanDecisionArgs(value: unknown): FilePlanDecisionArgs | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'planId,taskId') return null;
  const { taskId, planId } = value;
  return isUuid(taskId) && isUuid(planId) ? { taskId, planId } : null;
}

export function isFileTaskProgressEvent(value: unknown): value is FileTaskProgressEvent {
  return isRecord(value) && value.type === 'planning' && isUuid(value.taskId);
}

// ---------------------------------------------------------------------------
// Research task contracts (Phase 3)
// ---------------------------------------------------------------------------

export type ResearchTaskStatus =
  | 'awaiting_approval'
  | 'researching'
  | 'generating'
  | 'awaiting_save'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export const RESEARCH_TASK_STATUSES: readonly ResearchTaskStatus[] = [
  'awaiting_approval',
  'researching',
  'generating',
  'awaiting_save',
  'completed',
  'failed',
  'cancelled',
  'rejected',
];
export const TERMINAL_RESEARCH_STATUSES: readonly ResearchTaskStatus[] = ['completed', 'failed', 'cancelled', 'rejected'];

export type ResearchSourceStatus = 'planned' | 'rejected' | 'fetching' | 'extracted' | 'failed' | 'blocked' | 'skipped';
const RESEARCH_SOURCE_STATUSES: readonly ResearchSourceStatus[] = [
  'planned',
  'rejected',
  'fetching',
  'extracted',
  'failed',
  'blocked',
  'skipped',
];
export type FindingStatus = 'supported' | 'weak' | 'unsupported' | 'removed';
const FINDING_STATUSES: readonly FindingStatus[] = ['supported', 'weak', 'unsupported', 'removed'];

export interface ResearchTaskRecord {
  id: string;
  /** The user's own request text (untrusted; render as plain text). */
  requestText: string;
  question: string;
  keyTerms: string[];
  planSource: 'model' | 'keyword_fallback';
  planModel: string | null;
  planDetail: string;
  model: string | null;
  status: ResearchTaskStatus;
  cancelRequested: boolean;
  errorCode: string | null;
  errorDetail: string | null;
  /** Rendered by the core from verified records; shown as plain text, never as HTML. */
  reportMarkdown: string | null;
  reportSha256: string | null;
  savedPath: string | null;
  savedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResearchSourceRecord {
  id: string;
  seq: number;
  requestedUrl: string;
  finalUrl: string | null;
  canonicalUrl: string | null;
  status: ResearchSourceStatus;
  code: string | null;
  detail: string | null;
  httpStatus: number | null;
  title: string | null;
  sha256: string | null;
  textChars: number | null;
  truncated: boolean;
  retrievedAt: string | null;
}

export interface ResearchFinding {
  id: string;
  claim: string;
  citations: string[];
  invalidCitations: string[];
  quote: string;
  status: FindingStatus;
  reasons: string[];
}

export interface ResearchReport {
  question: string;
  generatedAt: string;
  findings: ResearchFinding[];
  uncertainties: string[];
  limitations: string[];
  evidenceSufficient: boolean;
}

export interface ResearchTaskDetail {
  task: ResearchTaskRecord;
  sources: ResearchSourceRecord[];
  report: ResearchReport | null;
  events: FileTaskEventRecord[];
}

export interface RefusedSource {
  url: string;
  code: string;
  detail: string;
}

export interface ResearchInterpretation {
  intent: 'research' | 'none';
  detail: string;
  refused: RefusedSource[];
  task: ResearchTaskDetail | null;
}

export interface ResearchTaskSummary {
  id: string;
  question: string;
  status: ResearchTaskStatus;
  savedPath: string | null;
  createdAt: string;
}

export interface InterpretResearchArgs {
  text: string;
  model: string;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isResearchStatus = (v: unknown): v is ResearchTaskStatus =>
  isString(v) && (RESEARCH_TASK_STATUSES as readonly string[]).includes(v);

function parseResearchTask(value: unknown): { task: ResearchTaskRecord; digest: string } | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isResearchStatus(v.status) || !isStringArray(v.key_terms)) return null;
  if (!isString(v.request_text) || !isString(v.question) || !isString(v.plan_detail)) return null;
  if (v.plan_source !== 'model' && v.plan_source !== 'keyword_fallback') return null;
  if (!isString(v.plan_digest) || !DIGEST_PATTERN.test(v.plan_digest)) return null;
  const optional = [
    v.plan_model,
    v.model,
    v.error_code,
    v.error_detail,
    v.report_markdown,
    v.report_sha256,
    v.saved_path,
    v.saved_at,
    v.started_at,
    v.finished_at,
  ];
  if (!optional.every(isNullableString) || !isString(v.created_at) || !isString(v.updated_at)) return null;
  if (v.cancel_requested !== 0 && v.cancel_requested !== 1) return null;
  return {
    digest: v.plan_digest,
    task: {
      id: v.id,
      requestText: v.request_text,
      question: v.question,
      keyTerms: v.key_terms,
      planSource: v.plan_source,
      planModel: v.plan_model as string | null,
      planDetail: v.plan_detail,
      model: v.model as string | null,
      status: v.status,
      cancelRequested: v.cancel_requested === 1,
      errorCode: v.error_code as string | null,
      errorDetail: v.error_detail as string | null,
      reportMarkdown: v.report_markdown as string | null,
      reportSha256: v.report_sha256 as string | null,
      savedPath: v.saved_path as string | null,
      savedAt: v.saved_at as string | null,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
      startedAt: v.started_at as string | null,
      finishedAt: v.finished_at as string | null,
    },
  };
}

function parseResearchSource(value: unknown): ResearchSourceRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || typeof v.seq !== 'number' || !Number.isInteger(v.seq) || !isString(v.requested_url)) {
    return null;
  }
  if (!isString(v.status) || !(RESEARCH_SOURCE_STATUSES as readonly string[]).includes(v.status)) return null;
  const strings = [v.final_url, v.canonical_url, v.code, v.detail, v.title, v.sha256, v.retrieved_at];
  if (!strings.every(isNullableString) || !isNullableInt(v.http_status) || !isNullableInt(v.text_chars)) return null;
  if (v.truncated !== 0 && v.truncated !== 1) return null;
  return {
    id: v.id,
    seq: v.seq,
    requestedUrl: v.requested_url,
    finalUrl: v.final_url as string | null,
    canonicalUrl: v.canonical_url as string | null,
    status: v.status as ResearchSourceStatus,
    code: v.code as string | null,
    detail: v.detail as string | null,
    httpStatus: v.http_status as number | null,
    title: v.title as string | null,
    sha256: v.sha256 as string | null,
    textChars: v.text_chars as number | null,
    truncated: v.truncated === 1,
    retrievedAt: v.retrieved_at as string | null,
  };
}

function parseFinding(value: unknown): ResearchFinding | null {
  if (!isRecord(value)) return null;
  const { id, claim, citations, invalid_citations, quote, status, reasons } = value;
  if (!isString(id) || !isString(claim) || !isString(quote) || !isStringArray(reasons)) return null;
  if (!isStringArray(citations) || !isStringArray(invalid_citations)) return null;
  if (!isString(status) || !(FINDING_STATUSES as readonly string[]).includes(status)) return null;
  return { id, claim, citations, invalidCitations: invalid_citations, quote, status: status as FindingStatus, reasons };
}

function parseReport(value: unknown): ResearchReport | null {
  if (!isRecord(value)) return null;
  const { question, generated_at, uncertainties, limitations, evidence_sufficient } = value;
  const findings = parseAll(value.findings, parseFinding);
  if (!findings || !isString(question) || !isString(generated_at) || typeof evidence_sufficient !== 'boolean') {
    return null;
  }
  if (!isStringArray(uncertainties) || !isStringArray(limitations)) return null;
  return {
    question,
    generatedAt: generated_at,
    findings,
    uncertainties,
    limitations,
    evidenceSufficient: evidence_sufficient,
  };
}

/** Main-process parse: the renderer-safe detail plus the plan digest that only main keeps. */
export function parseResearchDetailWithDigest(value: unknown): { detail: ResearchTaskDetail; digest: string } | null {
  if (!isRecord(value)) return null;
  const task = parseResearchTask(value.task);
  const sources = parseAll(value.sources, parseResearchSource);
  const events = parseAll(value.events, parseFileEvent);
  const report = value.report === null ? null : parseReport(value.report);
  if (!task || !sources || !events || (value.report !== null && report === null)) return null;
  return { detail: { task: task.task, sources, report, events }, digest: task.digest };
}

export function parseResearchTaskList(value: unknown): ResearchTaskSummary[] | null {
  if (!isRecord(value)) return null;
  return parseAll(value.tasks, (t) => {
    if (!isRecord(t) || !isUuid(t.id) || !isString(t.question) || !isResearchStatus(t.status)) return null;
    if (!isNullableString(t.saved_path) || !isString(t.created_at)) return null;
    return { id: t.id, question: t.question, status: t.status, savedPath: t.saved_path, createdAt: t.created_at };
  });
}

export function parseRefusedSources(value: unknown): RefusedSource[] | null {
  return parseAll(value, (r) =>
    isRecord(r) && isString(r.url) && isString(r.code) && isString(r.detail)
      ? { url: r.url, code: r.code, detail: r.detail }
      : null,
  );
}

/** Validate renderer-supplied research arguments: the request text and a model name, nothing else. */
export function parseInterpretResearchArgs(value: unknown): InterpretResearchArgs | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'model,text') return null;
  const { text, model } = value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_FILE_REQUEST_CHARS) return null;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) return null;
  return { text, model };
}

// ---------------------------------------------------------------------------
// Memory contracts (workstream M0)
// ---------------------------------------------------------------------------

export type MemoryKind = 'fact' | 'preference' | 'inference' | 'experience';
export type MemoryStatus = 'candidate' | 'active' | 'disputed' | 'superseded' | 'rejected';
export type MemoryVerification = 'user_stated' | 'user_confirmed' | 'tool_verified' | 'model_proposed';
const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'inference', 'experience'];
const MEMORY_STATUSES: readonly MemoryStatus[] = ['candidate', 'active', 'disputed', 'superseded', 'rejected'];
const MEMORY_VERIFICATIONS: readonly MemoryVerification[] = ['user_stated', 'user_confirmed', 'tool_verified', 'model_proposed'];
export const MAX_MEMORY_CHARS = 500;
const MAX_MEMORY_QUERY = 200;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** The internal event a memory came from, as recorded by the core (never from model output). */
export interface MemorySource {
  kind: string;
  sourceType: string;
  sourceId: string | null;
  conversationId: string | null;
  at: string;
  detail: string;
}

export interface MemoryRecord {
  id: string;
  lineageId: string;
  version: number;
  kind: MemoryKind;
  subject: string | null;
  /** User- or model-originated text: render as plain text only. */
  content: string;
  scope: string;
  status: MemoryStatus;
  verification: MemoryVerification;
  supersedesId: string | null;
  supersededBy: string | null;
  conflictsWith: string | null;
  observedAt: string;
  recordedAt: string;
  expiresAt: string | null;
  statusReason: string | null;
  expired: boolean;
  /** Active and unexpired: the only memories ever given to the model. */
  current: boolean;
  source: MemorySource | null;
  usedCount: number;
}

export interface MemorySettings {
  captureEnabled: boolean;
  project: string | null;
}

export interface MemoryList {
  memories: MemoryRecord[];
  settings: MemorySettings;
}

export interface MemoryQueryArgs {
  query: string;
  includeHistory: boolean;
}

export interface AddMemoryArgs {
  content: string;
  kind: 'fact' | 'preference';
  subject: string | null;
  scope: 'global' | 'project';
  /** YYYY-MM-DD, or null for no expiry. */
  expiresOn: string | null;
}

export interface CorrectMemoryArgs {
  id: string;
  content: string;
}

export interface MemoryDecisionArgs {
  id: string;
  action: 'confirm' | 'reject' | 'delete';
}

export type MemoryAddOutcome = 'saved' | 'duplicate' | 'disputed';

const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  isString(v) && (values as readonly string[]).includes(v);

function hasExactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(',') === keys;
}

function parseMemorySource(value: unknown): MemorySource | null {
  if (!isRecord(value)) return null;
  const { kind, source_type, source_id, conversation_id, at, detail } = value;
  if (!isString(kind) || !isString(source_type) || !isString(at) || !isString(detail)) return null;
  if (!isNullableString(source_id) || !isNullableString(conversation_id)) return null;
  return { kind, sourceType: source_type, sourceId: source_id, conversationId: conversation_id, at, detail };
}

export function parseMemoryRecord(value: unknown): MemoryRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isUuid(v.lineage_id) || typeof v.version !== 'number' || !Number.isInteger(v.version)) return null;
  if (!oneOf(MEMORY_KINDS, v.kind) || !oneOf(MEMORY_STATUSES, v.status)) return null;
  if (!oneOf(MEMORY_VERIFICATIONS, v.verification) || !isString(v.content) || !isString(v.scope)) return null;
  const optional = [v.subject, v.supersedes_id, v.superseded_by, v.conflicts_with, v.expires_at, v.status_reason];
  if (!optional.every(isNullableString) || !isString(v.observed_at) || !isString(v.recorded_at)) return null;
  if (typeof v.expired !== 'boolean' || typeof v.current !== 'boolean' || !isNullableInt(v.used_count)) return null;
  const source = v.source === null ? null : parseMemorySource(v.source);
  if (v.source !== null && source === null) return null;
  return {
    id: v.id,
    lineageId: v.lineage_id,
    version: v.version,
    kind: v.kind,
    subject: v.subject as string | null,
    content: v.content,
    scope: v.scope,
    status: v.status,
    verification: v.verification,
    supersedesId: v.supersedes_id as string | null,
    supersededBy: v.superseded_by as string | null,
    conflictsWith: v.conflicts_with as string | null,
    observedAt: v.observed_at,
    recordedAt: v.recorded_at,
    expiresAt: v.expires_at as string | null,
    statusReason: v.status_reason as string | null,
    expired: v.expired,
    current: v.current,
    source,
    usedCount: (v.used_count as number | null) ?? 0,
  };
}

export function parseMemorySettings(value: unknown): MemorySettings | null {
  if (!isRecord(value) || typeof value.capture_enabled !== 'boolean' || !isNullableString(value.project)) return null;
  return { captureEnabled: value.capture_enabled, project: value.project };
}

export function parseMemoryList(value: unknown): MemoryList | null {
  if (!isRecord(value)) return null;
  const memories = parseAll(value.memories, parseMemoryRecord);
  const settings = parseMemorySettings(value.settings);
  return memories && settings ? { memories, settings } : null;
}

/** Validate renderer-supplied memory arguments. Status, verification, source and scope names are never accepted. */
export function parseMemoryQueryArgs(value: unknown): MemoryQueryArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'includeHistory,query')) return null;
  const { query, includeHistory } = value;
  if (!isString(query) || query.length > MAX_MEMORY_QUERY || typeof includeHistory !== 'boolean') return null;
  return { query, includeHistory };
}

function isMemoryText(v: unknown): v is string {
  return isString(v) && v.trim().length > 0 && v.length <= MAX_MEMORY_CHARS && !v.includes('\u0000');
}

export function parseAddMemoryArgs(value: unknown): AddMemoryArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'content,expiresOn,kind,scope,subject')) return null;
  const { content, kind, subject, scope, expiresOn } = value;
  if (!isMemoryText(content) || (kind !== 'fact' && kind !== 'preference')) return null;
  if (!(subject === null || (isString(subject) && subject.length <= 60))) return null;
  if (scope !== 'global' && scope !== 'project') return null;
  if (!(expiresOn === null || (isString(expiresOn) && /^\d{4}-\d{2}-\d{2}$/.test(expiresOn)))) return null;
  return { content, kind, subject, scope, expiresOn };
}

export function parseCorrectMemoryArgs(value: unknown): CorrectMemoryArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'content,id')) return null;
  return isUuid(value.id) && isMemoryText(value.content) ? { id: value.id, content: value.content } : null;
}

export function parseMemoryDecisionArgs(value: unknown): MemoryDecisionArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'action,id') || !isUuid(value.id)) return null;
  const { action } = value;
  return action === 'confirm' || action === 'reject' || action === 'delete' ? { id: value.id, action } : null;
}

export function parseMemorySettingsArgs(value: unknown): MemorySettings | null {
  if (!isRecord(value) || !hasExactKeys(value, 'captureEnabled,project')) return null;
  const { captureEnabled, project } = value;
  if (typeof captureEnabled !== 'boolean') return null;
  if (!(project === null || (isString(project) && PROJECT_PATTERN.test(project)))) return null;
  return { captureEnabled, project };
}

// ---------------------------------------------------------------------------
// Vault contracts (M0A). Markdown files are the authority; this is AEGIS's index of them.
// ---------------------------------------------------------------------------

export type VaultIndexStatus = 'never' | 'indexing' | 'ok' | 'partial' | 'failed';
export type VaultNoteStatus = 'indexed' | 'skipped_secret' | 'skipped_large' | 'unreadable' | 'deleted';
const VAULT_INDEX_STATUSES: readonly VaultIndexStatus[] = ['never', 'indexing', 'ok', 'partial', 'failed'];
const VAULT_NOTE_STATUSES: readonly VaultNoteStatus[] = ['indexed', 'skipped_secret', 'skipped_large', 'unreadable', 'deleted'];
export const MAX_VAULT_NOTE_CHARS = 20_000;

export interface VaultRecord {
  id: string;
  rootPath: string;
  /** 'existing': a vault Obsidian already opened (read-only by default); 'new': an empty folder AEGIS set up. */
  kind: 'existing' | 'new';
  /** null = read-only for AEGIS; otherwise the only sub-folder AEGIS may create notes in. */
  writeArea: string | null;
  createdAt: string;
  indexedAt: string | null;
  indexStatus: VaultIndexStatus;
  indexDetail: string;
  counts: Record<string, number>;
}

export interface VaultNote {
  id: string;
  vaultId: string;
  vaultRoot: string;
  relPath: string;
  status: VaultNoteStatus;
  /** From AEGIS's own write records only: 'aegis_user' = written by AEGIS from text you typed, unchanged since. */
  author: 'user' | 'aegis_user';
  /** Note text is untrusted: render as plain text only. */
  title: string;
  tags: string[];
  modifiedAt: string | null;
  indexedAt: string;
  firstSeenAt: string;
  version: number;
  snippet: string | null;
}

export interface VaultSearchResult {
  notes: VaultNote[];
  vaults: VaultRecord[];
}

export interface AddVaultNoteArgs {
  vaultId: string;
  title: string;
  body: string;
}

export interface VaultWriteAreaArgs {
  vaultId: string;
  enabled: boolean;
}

function parseVault(value: unknown): VaultRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isString(v.root_path) || (v.kind !== 'existing' && v.kind !== 'new')) return null;
  if (!isNullableString(v.write_area) || !isString(v.created_at) || !isNullableString(v.indexed_at)) return null;
  if (!oneOf(VAULT_INDEX_STATUSES, v.index_status) || !isString(v.index_detail) || !isRecord(v.counts)) return null;
  const counts: Record<string, number> = {};
  for (const [key, n] of Object.entries(v.counts)) {
    if (typeof n !== 'number' || !Number.isInteger(n)) return null;
    counts[key] = n;
  }
  return {
    id: v.id,
    rootPath: v.root_path,
    kind: v.kind,
    writeArea: v.write_area,
    createdAt: v.created_at,
    indexedAt: v.indexed_at,
    indexStatus: v.index_status,
    indexDetail: v.index_detail,
    counts,
  };
}

function parseVaultNote(value: unknown): VaultNote | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !isUuid(v.vault_id) || !isString(v.vault_root) || !isString(v.rel_path)) return null;
  if (!oneOf(VAULT_NOTE_STATUSES, v.status) || (v.author !== 'user' && v.author !== 'aegis_user')) return null;
  if (!isString(v.title) || !isStringArray(v.tags) || !isNullableString(v.modified_at)) return null;
  if (!isString(v.indexed_at) || !isString(v.first_seen_at) || !isNullableInt(v.version)) return null;
  if (!(v.snippet === undefined || isNullableString(v.snippet))) return null;
  return {
    id: v.id,
    vaultId: v.vault_id,
    vaultRoot: v.vault_root,
    relPath: v.rel_path,
    status: v.status,
    author: v.author,
    title: v.title,
    tags: v.tags,
    modifiedAt: v.modified_at,
    indexedAt: v.indexed_at,
    firstSeenAt: v.first_seen_at,
    version: (v.version as number | null) ?? 1,
    snippet: (v.snippet as string | null | undefined) ?? null,
  };
}

export function parseVaultList(value: unknown): VaultRecord[] | null {
  return isRecord(value) ? parseAll(value.vaults, parseVault) : null;
}

export function parseVaultEnvelope(value: unknown): VaultRecord | null {
  return isRecord(value) ? parseVault(value.vault) : null;
}

export function parseVaultNoteEnvelope(value: unknown): VaultNote | null {
  return isRecord(value) ? parseVaultNote(value.note) : null;
}

export function parseVaultSearch(value: unknown): VaultSearchResult | null {
  if (!isRecord(value)) return null;
  const notes = parseAll(value.notes, parseVaultNote);
  const vaults = parseAll(value.vaults, parseVault);
  return notes && vaults ? { notes, vaults } : null;
}

/** Renderer arguments: ids, a query and typed note text only. No path ever comes from the renderer. */
export function parseVaultQuery(value: unknown): string | null {
  return isString(value) && value.length <= 200 ? value : null;
}

export function parseAddVaultNoteArgs(value: unknown): AddVaultNoteArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'body,title,vaultId') || !isUuid(value.vaultId)) return null;
  const { title, body } = value;
  if (!isString(title) || !title.trim() || title.length > 120) return null;
  if (!isString(body) || !body.trim() || body.length > MAX_VAULT_NOTE_CHARS || body.includes('\u0000')) return null;
  return { vaultId: value.vaultId, title, body };
}

export function parseVaultWriteAreaArgs(value: unknown): VaultWriteAreaArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'enabled,vaultId') || !isUuid(value.vaultId)) return null;
  return typeof value.enabled === 'boolean' ? { vaultId: value.vaultId, enabled: value.enabled } : null;
}

// ---------------------------------------------------------------------------
// Repository investigation contracts (Phase 4)
// ---------------------------------------------------------------------------

export type RepoTaskStatus =
  | 'awaiting_repo'
  | 'awaiting_approval'
  | 'inspecting'
  | 'generating'
  | 'awaiting_save'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export const REPO_TASK_STATUSES: readonly RepoTaskStatus[] = [
  'awaiting_repo',
  'awaiting_approval',
  'inspecting',
  'generating',
  'awaiting_save',
  'completed',
  'failed',
  'cancelled',
  'rejected',
];
export const TERMINAL_REPO_STATUSES: readonly RepoTaskStatus[] = ['completed', 'failed', 'cancelled', 'rejected'];

export type RepoFindingStatus =
  | 'likely_issue'
  | 'plausible_concern'
  | 'best_practice'
  | 'insufficient_evidence'
  | 'removed';
const REPO_FINDING_STATUSES: readonly RepoFindingStatus[] = [
  'likely_issue',
  'plausible_concern',
  'best_practice',
  'insufficient_evidence',
  'removed',
];
/**
 * How far a checked quote backs the claim (lexical test in the core, not semantic proof). A real quote at the
 * cited lines proves only that the code is there: 'needs_review' means a human must judge the claim.
 */
export type RepoFindingSupport = 'supported' | 'needs_review';
const REPO_FINDING_SUPPORT: readonly RepoFindingSupport[] = ['supported', 'needs_review'];

export interface RepoTaskRecord {
  id: string;
  /** The user's own request text (untrusted; render as plain text). */
  requestText: string;
  model: string;
  status: RepoTaskStatus;
  repoName: string | null;
  rootPath: string | null;
  vaultConsent: boolean;
  cancelRequested: boolean;
  errorCode: string | null;
  errorDetail: string | null;
  /** Rendered by the core from verified records; shown as plain text, never as HTML. */
  reportMarkdown: string | null;
  reportSha256: string | null;
  savedPath: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A deterministic check result (code, not model) with its file/line reference. */
export interface RepoCheck {
  id: string;
  title: string;
  severity: string;
  path: string | null;
  line: number | null;
}

export interface RepoMemoryRef {
  id: string;
  kind: MemoryKind;
  verification: MemoryVerification;
  scope: string;
  content: string;
  recordedAt: string;
  version: number;
}

export interface RepoVaultRef {
  noteId: string;
  title: string;
  relPath: string;
  author: 'user' | 'aegis_user';
  version: number;
  sha256: string;
}

export interface RepoPlan {
  repoName: string;
  rootPath: string;
  modelIsLocal: boolean;
  filesSeen: number;
  filesRead: number;
  excluded: Record<string, number>;
  sensitivePaths: string[];
  languages: { name: string; files: number; lines: number }[];
  frameworks: { label: string; manifest: string; line: number | null }[];
  testFiles: number;
  components: { name: string; files: number; lines: number }[];
  context: { id: string; path: string; start: number; end: number; reason: string }[];
  checks: RepoCheck[];
  suspiciousFiles: string[];
  memory: RepoMemoryRef[];
  vaultNotes: RepoVaultRef[];
}

export interface RepoModelFinding {
  id: string;
  status: RepoFindingStatus;
  title: string;
  detail: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  recommendation: string;
  reasons: string[];
  /** Null for insufficient/removed findings and for reports stored before support levels existed. */
  support: RepoFindingSupport | null;
}

export interface RepoHypothesis {
  problem: string;
  explanations: { explanation: string; supporting: string; contradicting: string }[];
  verificationSteps: string[];
}

export interface RepoReport {
  summary: string;
  findings: RepoModelFinding[];
  hypotheses: RepoHypothesis[];
  memory: { ref: string; content: string; label: string; scope: string; used: boolean; check: string }[];
  vault: (RepoVaultRef & { status: string; detail: string | null })[];
  proposals: { subject: string; content: string }[];
  limitations: string[];
  uncertainties: string[];
  unchanged: boolean;
  entriesCompared: number;
  excerptsVerified: number;
}

export interface RepoTaskDetail {
  task: RepoTaskRecord;
  plan: RepoPlan | null;
  report: RepoReport | null;
  events: FileTaskEventRecord[];
}

export interface RepoInterpretation {
  intent: 'repo' | 'none';
  detail: string;
  task: RepoTaskDetail | null;
}

export interface RepoTaskSummary {
  id: string;
  repoName: string | null;
  status: RepoTaskStatus;
  savedPath: string | null;
  createdAt: string;
}

export interface RepoApproveArgs {
  taskId: string;
  /** Explicit consent for the listed vault notes to enter this task's (local) model context. */
  useVaultNotes: boolean;
}

export interface RepoProposalArgs {
  taskId: string;
  index: number;
}

export interface RepoProposalOutcome {
  outcome: MemoryAddOutcome;
  detail: RepoTaskDetail;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNullableIntAny = (v: unknown): v is number | null => v === null || isInt(v);

function parseRepoTask(value: unknown): { task: RepoTaskRecord; digest: string | null } | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (!isUuid(v.id) || !oneOf(REPO_TASK_STATUSES, v.status) || !isString(v.request_text) || !isString(v.model)) {
    return null;
  }
  const optional = [
    v.repo_name,
    v.root_path,
    v.error_code,
    v.error_detail,
    v.report_markdown,
    v.report_sha256,
    v.saved_path,
    v.finished_at,
    v.plan_digest,
  ];
  if (!optional.every(isNullableString) || !isString(v.created_at)) return null;
  if ((v.vault_consent !== 0 && v.vault_consent !== 1) || (v.cancel_requested !== 0 && v.cancel_requested !== 1)) {
    return null;
  }
  if (v.plan_digest !== null && !DIGEST_PATTERN.test(v.plan_digest as string)) return null;
  return {
    digest: v.plan_digest as string | null,
    task: {
      id: v.id,
      requestText: v.request_text,
      model: v.model,
      status: v.status,
      repoName: v.repo_name as string | null,
      rootPath: v.root_path as string | null,
      vaultConsent: v.vault_consent === 1,
      cancelRequested: v.cancel_requested === 1,
      errorCode: v.error_code as string | null,
      errorDetail: v.error_detail as string | null,
      reportMarkdown: v.report_markdown as string | null,
      reportSha256: v.report_sha256 as string | null,
      savedPath: v.saved_path as string | null,
      createdAt: v.created_at,
      finishedAt: v.finished_at as string | null,
    },
  };
}

function parseCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) {
    if (!isInt(n)) return null;
    out[key] = n;
  }
  return out;
}

function parseVaultRef(v: unknown): RepoVaultRef | null {
  if (!isRecord(v) || !isUuid(v.note_id) || !isString(v.title) || !isString(v.rel_path) || !isInt(v.version)) {
    return null;
  }
  if ((v.author !== 'user' && v.author !== 'aegis_user') || !isString(v.sha256)) return null;
  return { noteId: v.note_id, title: v.title, relPath: v.rel_path, author: v.author, version: v.version, sha256: v.sha256 };
}

function parseRepoPlan(value: unknown): RepoPlan | null {
  if (!isRecord(value) || !isRecord(value.facts)) return null;
  const f = value.facts;
  if (!isString(value.repo_name) || !isString(value.root_path) || typeof value.model_is_local !== 'boolean') return null;
  if (!isInt(f.files_seen) || !isInt(f.files_read) || !isRecord(f.languages) || !isRecord(f.tests)) return null;
  const excluded = parseCounts(f.excluded);
  const excludedPaths = parseAll(f.excluded_paths, (p) =>
    isRecord(p) && isString(p.path) && isString(p.reason) ? { path: p.path, reason: p.reason } : null,
  );
  const languages: RepoPlan['languages'] = [];
  for (const [name, stats] of Object.entries(f.languages)) {
    if (!isRecord(stats) || !isInt(stats.files) || !isInt(stats.lines)) return null;
    languages.push({ name, files: stats.files, lines: stats.lines });
  }
  const frameworks = parseAll(f.frameworks, (x) =>
    isRecord(x) && isString(x.label) && isString(x.manifest) && isNullableIntAny(x.line)
      ? { label: x.label, manifest: x.manifest, line: x.line }
      : null,
  );
  const components = parseAll(f.components, (x) =>
    isRecord(x) && isString(x.name) && isInt(x.files) && isInt(x.lines)
      ? { name: x.name, files: x.files, lines: x.lines }
      : null,
  );
  const context = parseAll(f.context, (x) =>
    isRecord(x) && isString(x.id) && isString(x.path) && isInt(x.start) && isInt(x.end) && isString(x.reason)
      ? { id: x.id, path: x.path, start: x.start, end: x.end, reason: x.reason }
      : null,
  );
  const checks = parseAll(f.findings, (x) =>
    isRecord(x) &&
    isString(x.id) &&
    isString(x.title) &&
    isString(x.severity) &&
    isNullableString(x.path) &&
    isNullableIntAny(x.line)
      ? { id: x.id, title: x.title, severity: x.severity, path: x.path, line: x.line }
      : null,
  );
  const memory = parseAll(value.memory, (m) =>
    isRecord(m) &&
    isUuid(m.id) &&
    oneOf(MEMORY_KINDS, m.kind) &&
    oneOf(MEMORY_VERIFICATIONS, m.verification) &&
    isString(m.scope) &&
    isString(m.content) &&
    isString(m.recorded_at) &&
    isInt(m.version)
      ? {
          id: m.id,
          kind: m.kind,
          verification: m.verification,
          scope: m.scope,
          content: m.content,
          recordedAt: m.recorded_at,
          version: m.version,
        }
      : null,
  );
  const vaultNotes = parseAll(value.vault_notes, parseVaultRef);
  if (!excluded || !excludedPaths || !frameworks || !components || !context || !checks || !memory || !vaultNotes) {
    return null;
  }
  if (!isInt(f.tests.files) || !isStringArray(f.suspicious_files)) return null;
  return {
    repoName: value.repo_name,
    rootPath: value.root_path,
    modelIsLocal: value.model_is_local,
    filesSeen: f.files_seen,
    filesRead: f.files_read,
    excluded,
    sensitivePaths: excludedPaths.filter((p) => p.reason.startsWith('sensitive')).map((p) => p.path),
    languages,
    frameworks,
    testFiles: f.tests.files,
    components,
    context,
    checks,
    suspiciousFiles: f.suspicious_files,
    memory,
    vaultNotes,
  };
}

function parseRepoFinding(x: unknown): RepoModelFinding | null {
  if (!isRecord(x) || !isString(x.id) || !oneOf(REPO_FINDING_STATUSES, x.status) || !isString(x.title)) return null;
  if (!isString(x.detail) || !isNullableString(x.path) || !isNullableIntAny(x.start_line)) return null;
  if (!isNullableIntAny(x.end_line) || !isString(x.quote) || !isString(x.recommendation)) return null;
  if (!isStringArray(x.reasons)) return null;
  const support = x.support ?? null;
  if (support !== null && !oneOf(REPO_FINDING_SUPPORT, support)) return null;
  if (support !== null && (x.status === 'insufficient_evidence' || x.status === 'removed')) return null;
  return {
    id: x.id,
    status: x.status,
    support,
    title: x.title,
    detail: x.detail,
    path: x.path,
    startLine: x.start_line,
    endLine: x.end_line,
    quote: x.quote,
    recommendation: x.recommendation,
    reasons: x.reasons,
  };
}

function parseHypothesis(h: unknown): RepoHypothesis | null {
  if (!isRecord(h) || !isString(h.problem) || !isStringArray(h.verification_steps)) return null;
  const explanations = parseAll(h.explanations, (e) =>
    isRecord(e) && isString(e.explanation) && isString(e.supporting) && isString(e.contradicting)
      ? { explanation: e.explanation, supporting: e.supporting, contradicting: e.contradicting }
      : null,
  );
  return explanations ? { problem: h.problem, explanations, verificationSteps: h.verification_steps } : null;
}

function parseRepoReport(value: unknown): RepoReport | null {
  if (!isRecord(value) || !isString(value.summary) || !isRecord(value.verification)) return null;
  const findings = parseAll(value.model_findings, parseRepoFinding);
  const hypotheses = parseAll(value.hypotheses, parseHypothesis);
  const memory = parseAll(value.memory, (m) =>
    isRecord(m) &&
    isString(m.ref) &&
    isString(m.content) &&
    isString(m.label) &&
    isString(m.scope) &&
    typeof m.used === 'boolean' &&
    isString(m.check)
      ? { ref: m.ref, content: m.content, label: m.label, scope: m.scope, used: m.used, check: m.check }
      : null,
  );
  const vault = parseAll(value.vault, (n) => {
    const ref = parseVaultRef(n);
    if (!ref || !isRecord(n) || !isString(n.status)) return null;
    if (!(n.detail === undefined || isNullableString(n.detail))) return null;
    return { ...ref, status: n.status, detail: (n.detail as string | null | undefined) ?? null };
  });
  const proposals = parseAll(value.proposals, (p) =>
    isRecord(p) && isString(p.subject) && isString(p.content) ? { subject: p.subject, content: p.content } : null,
  );
  const v = value.verification;
  if (!findings || !hypotheses || !memory || !vault || !proposals) return null;
  if (!isStringArray(value.limitations) || !isStringArray(value.uncertainties)) return null;
  if (typeof v.unchanged !== 'boolean' || !isInt(v.entries) || !isInt(v.excerpts_verified)) return null;
  return {
    summary: value.summary,
    findings,
    hypotheses,
    memory,
    vault,
    proposals,
    limitations: value.limitations,
    uncertainties: value.uncertainties,
    unchanged: v.unchanged,
    entriesCompared: v.entries,
    excerptsVerified: v.excerpts_verified,
  };
}

/** Main-process parse: the renderer-safe detail plus the plan digest that only main keeps. */
export function parseRepoDetailWithDigest(value: unknown): { detail: RepoTaskDetail; digest: string | null } | null {
  if (!isRecord(value)) return null;
  const task = parseRepoTask(value.task);
  const events = parseAll(value.events, parseFileEvent);
  const plan = value.plan === null ? null : parseRepoPlan(value.plan);
  const report = value.report === null ? null : parseRepoReport(value.report);
  if (!task || !events || (value.plan !== null && !plan) || (value.report !== null && !report)) return null;
  return { detail: { task: task.task, plan, report, events }, digest: task.digest };
}

export function parseRepoTaskList(value: unknown): RepoTaskSummary[] | null {
  if (!isRecord(value)) return null;
  return parseAll(value.tasks, (t) => {
    if (!isRecord(t) || !isUuid(t.id) || !oneOf(REPO_TASK_STATUSES, t.status) || !isString(t.created_at)) return null;
    if (!isNullableString(t.repo_name) || !isNullableString(t.saved_path)) return null;
    return { id: t.id, repoName: t.repo_name, status: t.status, savedPath: t.saved_path, createdAt: t.created_at };
  });
}

/** Renderer arguments carry ids and a consent flag only: never a path, file list, note id or digest. */
export function parseRepoApproveArgs(value: unknown): RepoApproveArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'taskId,useVaultNotes') || !isUuid(value.taskId)) return null;
  return typeof value.useVaultNotes === 'boolean' ? { taskId: value.taskId, useVaultNotes: value.useVaultNotes } : null;
}

export function parseRepoProposalArgs(value: unknown): RepoProposalArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'index,taskId') || !isUuid(value.taskId)) return null;
  return isInt(value.index) && value.index >= 0 && value.index < 10 ? { taskId: value.taskId, index: value.index } : null;
}

// ---------------------------------------------------------------------------
// Voice contracts (Phase 5)
// ---------------------------------------------------------------------------

export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 60;
/** WAV header + 60 s of 16 kHz mono 16-bit samples. */
export const MAX_RECORDING_BYTES = 44 + MAX_RECORDING_SECONDS * VOICE_SAMPLE_RATE * 2;
/** Text sent for speech is cut here; the core speaks at most its own (smaller) limit of it. */
export const MAX_SPEAK_TEXT_CHARS = 20_000;
export const MAX_SPEECH_BYTES = 16 * 1024 * 1024;

export interface VoiceStatus {
  stt: { engine: string; model: string; available: boolean; detail: string };
  tts: { engine: string; available: boolean; detail: string; voices: string[] };
  limits: { sampleRate: number; maxSeconds: number; maxSpeakChars: number };
}

export interface TranscribeArgs {
  requestId: string;
  audio: Uint8Array;
}

export type TranscriptStatus = 'ok' | 'silence' | 'unintelligible';

export interface TranscriptResult {
  requestId: string;
  status: TranscriptStatus;
  text: string;
  audioMs: number;
  processingMs: number;
  engine: string;
  model: string;
  lowConfidence: boolean;
}

export type VoiceCommandKind = 'chat' | 'recall' | 'remember' | 'correct' | 'forget' | 'approval' | 'empty';
export const VOICE_COMMAND_KINDS: readonly VoiceCommandKind[] = [
  'chat',
  'recall',
  'remember',
  'correct',
  'forget',
  'approval',
  'empty',
];
export type VoiceCategory =
  | 'explicit_correction'
  | 'project_exception'
  | 'temporary'
  | 'transcription_doubt'
  | 'conflicting_claim';
export const VOICE_CATEGORIES: readonly VoiceCategory[] = [
  'explicit_correction',
  'project_exception',
  'temporary',
  'transcription_doubt',
  'conflicting_claim',
];
export type CorrectionCategory = Exclude<VoiceCategory, 'conflicting_claim'>;

export interface VoiceInterpretArgs {
  text: string;
  conversationId: string | null;
  lowConfidence: boolean;
}

export interface VoiceInterpretation {
  kind: VoiceCommandKind;
  text: string;
  reviewRequired: boolean;
  reason: string;
  category: VoiceCategory | null;
  body: string | null;
  target: MemoryRecord | null;
  candidates: MemoryRecord[];
  proposedContent: string | null;
  conflict: MemoryRecord | null;
}

export interface VoiceCorrectionArgs {
  requestId: string;
  targetId: string;
  content: string;
  category: CorrectionCategory;
  conversationId: string | null;
}

export interface SpeakArgs {
  requestId: string;
  text: string;
  voice: string | null;
}

export interface SpeechResult {
  audio: Uint8Array;
  voice: string;
  synthesisMs: number;
  audioMs: number;
  spokenChars: number;
  truncated: boolean;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
}

/** Minimal RIFF/WAVE PCM header check (the fmt chunk must come first, as the app writes it). */
export function parseWavHeader(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(20, true) !== 1) return null; // PCM
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  let offset = 20 + view.getUint32(16, true);
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === 'data') {
      return size <= bytes.length - offset - 8 ? { sampleRate, channels, bitsPerSample, dataBytes: size } : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** A push-to-talk recording from the renderer: exactly the format the core accepts, within the size limit. */
export function parseTranscribeArgs(value: unknown): TranscribeArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'audio,requestId') || !isUuid(value.requestId)) return null;
  const audio = value.audio;
  if (!(audio instanceof Uint8Array) || audio.length > MAX_RECORDING_BYTES) return null;
  const info = parseWavHeader(audio);
  if (!info || info.sampleRate !== VOICE_SAMPLE_RATE || info.channels !== 1 || info.bitsPerSample !== 16) return null;
  return { requestId: value.requestId, audio };
}

export function parseVoiceInterpretArgs(value: unknown): VoiceInterpretArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'conversationId,lowConfidence,text')) return null;
  const { text, conversationId, lowConfidence } = value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 2000) return null;
  if (conversationId !== null && !isUuid(conversationId)) return null;
  return typeof lowConfidence === 'boolean' ? { text, conversationId, lowConfidence } : null;
}

export function parseVoiceCorrectionArgs(value: unknown): VoiceCorrectionArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'category,content,conversationId,requestId,targetId')) return null;
  const { requestId, targetId, content, category, conversationId } = value;
  if (!isUuid(requestId) || !isUuid(targetId) || (conversationId !== null && !isUuid(conversationId))) return null;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_MEMORY_CHARS) return null;
  if (category === 'conflicting_claim' || !oneOf(VOICE_CATEGORIES, category)) return null;
  return { requestId, targetId, content, category: category as CorrectionCategory, conversationId };
}

export function parseSpeakArgs(value: unknown): SpeakArgs | null {
  if (!isRecord(value) || !hasExactKeys(value, 'requestId,text,voice') || !isUuid(value.requestId)) return null;
  const { text, voice } = value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_SPEAK_TEXT_CHARS) return null;
  if (voice !== null && (typeof voice !== 'string' || !/^[A-Za-z0-9 ()._-]{1,80}$/.test(voice))) return null;
  return { requestId: value.requestId, text, voice };
}

export function parseVoiceStatus(value: unknown): VoiceStatus | null {
  if (!isRecord(value) || !isRecord(value.stt) || !isRecord(value.tts) || !isRecord(value.limits)) return null;
  const { stt, tts, limits } = value;
  if (!isString(stt.engine) || !isString(stt.model) || typeof stt.available !== 'boolean' || !isString(stt.detail)) {
    return null;
  }
  if (!isString(tts.engine) || typeof tts.available !== 'boolean' || !isString(tts.detail)) return null;
  if (!Array.isArray(tts.voices) || !tts.voices.every(isString)) return null;
  if (!isInt(limits.sample_rate) || !isInt(limits.max_seconds) || !isInt(limits.max_speak_chars)) return null;
  return {
    stt: { engine: stt.engine, model: stt.model, available: stt.available, detail: stt.detail },
    tts: { engine: tts.engine, available: tts.available, detail: tts.detail, voices: tts.voices as string[] },
    limits: { sampleRate: limits.sample_rate, maxSeconds: limits.max_seconds, maxSpeakChars: limits.max_speak_chars },
  };
}

export function parseTranscriptResult(value: unknown): TranscriptResult | null {
  if (!isRecord(value) || !isUuid(value.request_id)) return null;
  const v = value;
  if (v.status !== 'ok' && v.status !== 'silence' && v.status !== 'unintelligible') return null;
  if (!isString(v.text) || v.text.length > 20_000 || !isInt(v.audio_ms) || !isInt(v.processing_ms)) return null;
  if (v.audio_ms < 0 || v.processing_ms < 0) return null;
  if (!isString(v.engine) || !isString(v.model) || typeof v.low_confidence !== 'boolean') return null;
  return {
    requestId: value.request_id,
    status: v.status,
    text: v.text,
    audioMs: v.audio_ms,
    processingMs: v.processing_ms,
    engine: v.engine,
    model: v.model,
    lowConfidence: v.low_confidence,
  };
}

export function parseVoiceInterpretation(value: unknown): VoiceInterpretation | null {
  if (!isRecord(value) || !oneOf(VOICE_COMMAND_KINDS, value.kind)) return null;
  const v = value;
  if (!isString(v.text) || typeof v.review_required !== 'boolean' || !isString(v.reason)) return null;
  if (v.category !== null && !oneOf(VOICE_CATEGORIES, v.category)) return null;
  if (!isNullableString(v.body) || !isNullableString(v.proposed_content)) return null;
  const target = v.target === null ? null : parseMemoryRecord(v.target);
  const conflict = v.conflict === null ? null : parseMemoryRecord(v.conflict);
  const candidates = parseAll(v.candidates, parseMemoryRecord);
  if ((v.target !== null && !target) || (v.conflict !== null && !conflict) || !candidates) return null;
  return {
    kind: v.kind as VoiceCommandKind,
    text: v.text,
    reviewRequired: v.review_required,
    reason: v.reason,
    category: v.category as VoiceCategory | null,
    body: v.body as string | null,
    target,
    candidates,
    proposedContent: v.proposed_content as string | null,
    conflict,
  };
}
