import {
  parseConversation,
  parseConversationDetail,
  parseConversationList,
  parseMessage,
  parseStreamEvent,
  type ChatError,
  type ChatMessageRecord,
  type ChatOutcome,
  type ChatProgressEvent,
  type ChatResult,
  type ConversationDetail,
  type ConversationSummary,
  type SendMessageArgs,
} from '../src/shared/contracts';
import { CoreUnavailableError, type BackendManager } from './backend';

const REQUEST_TIMEOUT_MS = 10_000;
/** The core bounds a generation at 300 s; this only catches a stream that goes silent beyond that. */
const STREAM_IDLE_TIMEOUT_MS = 330_000;
const MAX_STREAM_LINE = 2_000_000;

/**
 * Main-process conversation client. Proxies the fixed set of conversation
 * calls to the core and validates every payload in both directions. The
 * renderer never learns the core's port or token.
 */
export class ChatService {
  private readonly backend: BackendManager;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  listConversations(): Promise<ChatResult<ConversationSummary[]>> {
    return this.json('GET', '/conversations', parseConversationList);
  }

  createConversation(): Promise<ChatResult<ConversationSummary>> {
    return this.json('POST', '/conversations', (v) =>
      typeof v === 'object' && v !== null ? parseConversation((v as { conversation?: unknown }).conversation) : null,
    );
  }

  getConversation(conversationId: string): Promise<ChatResult<ConversationDetail>> {
    return this.json('GET', `/conversations/${conversationId}`, parseConversationDetail);
  }

  cancel(messageId: string): Promise<ChatResult<ChatMessageRecord>> {
    return this.json('POST', `/generations/${messageId}/cancel`, (v) =>
      typeof v === 'object' && v !== null ? parseMessage((v as { message?: unknown }).message) : null,
    );
  }

  /** Stream one turn. Progress goes to `emit`; the resolved value is the terminal outcome. */
  async send(args: SendMessageArgs, emit: (event: ChatProgressEvent) => void): Promise<ChatOutcome> {
    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('stream idle timeout')), STREAM_IDLE_TIMEOUT_MS);
    };
    let acceptedMessageId: string | null = null;
    let responseStarted = false;

    try {
      touch();
      const response = await this.backend.request(`/conversations/${args.conversationId}/messages`, {
        method: 'POST',
        body: { client_request_id: args.requestId, content: args.content, model: args.model },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        return { type: 'rejected', error: await errorFromResponse(response) };
      }
      responseStarted = true;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_STREAM_LINE) throw new ProtocolError('oversized stream line from core');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = parseStreamEvent(args.requestId, JSON.parse(line) as unknown);
          if (!event) throw new ProtocolError('core sent a stream event that does not match the contract');
          if (event.type === 'accepted') {
            acceptedMessageId = event.assistantMessage.id;
            emit(event);
          } else if (event.type === 'streaming' || event.type === 'delta') {
            emit(event);
          } else {
            void reader.cancel().catch(() => undefined);
            return event;
          }
        }
      }
      return disconnected(acceptedMessageId, 'stream_ended', 'The core closed the reply stream without a final status.');
    } catch (error) {
      if (error instanceof CoreUnavailableError) {
        return { type: 'rejected', error: { code: 'core_unavailable', detail: error.message } };
      }
      if (error instanceof ProtocolError || error instanceof SyntaxError) {
        controller.abort();
        return disconnected(acceptedMessageId, 'invalid_core_response', error.message);
      }
      const detail = controller.signal.aborted
        ? 'No data from the core for too long; the request was abandoned.'
        : 'Lost the connection to the local core during the request.';
      // Before any response the core cannot have stored the turn; after it, it may have.
      if (!responseStarted) return { type: 'rejected', error: { code: 'core_unavailable', detail } };
      return disconnected(acceptedMessageId, 'core_disconnected', detail);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  private async json<T>(method: 'GET' | 'POST', path: string, parse: (value: unknown) => T | null): Promise<ChatResult<T>> {
    try {
      const response = await this.backend.request(path, { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return { ok: false, error: await errorFromResponse(response) };
      const value = parse(await response.json());
      if (value === null) {
        return { ok: false, error: { code: 'invalid_core_response', detail: 'The core returned data that does not match the contract.' } };
      }
      return { ok: true, value };
    } catch (error) {
      const detail = error instanceof CoreUnavailableError ? error.message : 'Could not reach the local core.';
      return { ok: false, error: { code: 'core_unavailable', detail } };
    }
  }
}

class ProtocolError extends Error {}

function disconnected(messageId: string | null, code: string, detail: string): ChatOutcome {
  return { type: 'disconnected', messageId, error: { code, detail } };
}

async function errorFromResponse(response: Response): Promise<ChatError> {
  let code = `http_${response.status}`;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') code = body.detail;
    else if (response.status === 422) code = 'invalid_request';
  } catch {
    /* non-JSON error body: keep the HTTP status code */
  }
  return { code, detail: describeCoreError(code, response.status) };
}

function describeCoreError(code: string, status: number): string {
  switch (code) {
    case 'generation_in_progress':
      return 'A reply is already being generated in this conversation.';
    case 'conversation_not_found':
      return 'This conversation no longer exists.';
    case 'request_id_reused':
      return 'This request id was already used for a different conversation.';
    case 'invalid_request':
      return 'The core rejected the message as invalid.';
    case 'database_unavailable':
      return 'The local database is unavailable (see Diagnostics).';
    default:
      return `The core refused the request (HTTP ${status}).`;
  }
}
