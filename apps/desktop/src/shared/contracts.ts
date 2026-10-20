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
  | 'aegis:chat:event';

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
}

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
  if (keys !== 'content,conversationId,model,requestId') return null;
  const { conversationId, requestId, content, model } = value;
  if (!isUuid(conversationId) || !isUuid(requestId)) return null;
  if (typeof content !== 'string' || content.trim().length === 0 || content.length > MAX_PROMPT_CHARS) return null;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) return null;
  return { conversationId, requestId, content, model };
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
