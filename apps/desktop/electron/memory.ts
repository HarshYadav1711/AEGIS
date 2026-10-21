import {
  parseMemoryList,
  parseMemoryRecord,
  parseMemorySettings,
  type AddMemoryArgs,
  type ChatResult,
  type CorrectMemoryArgs,
  type MemoryAddOutcome,
  type MemoryDecisionArgs,
  type MemoryList,
  type MemoryQueryArgs,
  type MemoryRecord,
  type MemorySettings,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import { coreCall } from './files';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Main-process client for the memory store. The renderer sends text and ids
 * only; status, verification and provenance are decided by the core.
 */
export class MemoryService {
  private readonly backend: BackendManager;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  list(args: MemoryQueryArgs): Promise<ChatResult<MemoryList>> {
    const query = `q=${encodeURIComponent(args.query)}&history=${args.includeHistory ? 1 : 0}`;
    return coreCall(this.backend, 'GET', `/memory?${query}`, REQUEST_TIMEOUT_MS, undefined, parseMemoryList);
  }

  add(args: AddMemoryArgs): Promise<ChatResult<{ memory: MemoryRecord; outcome: MemoryAddOutcome }>> {
    const body = {
      content: args.content,
      kind: args.kind,
      subject: args.subject,
      scope: args.scope,
      expires_on: args.expiresOn,
    };
    return coreCall(this.backend, 'POST', '/memory', REQUEST_TIMEOUT_MS, body, (raw) => {
      if (typeof raw !== 'object' || raw === null) return null;
      const { memory, outcome } = raw as { memory?: unknown; outcome?: unknown };
      const record = parseMemoryRecord(memory);
      if (!record || (outcome !== 'saved' && outcome !== 'duplicate' && outcome !== 'disputed')) return null;
      return { memory: record, outcome };
    });
  }

  correct(args: CorrectMemoryArgs): Promise<ChatResult<MemoryRecord>> {
    return coreCall(this.backend, 'POST', `/memory/${args.id}/correct`, REQUEST_TIMEOUT_MS, { content: args.content },
      (raw) => (typeof raw === 'object' && raw !== null ? parseMemoryRecord((raw as { memory?: unknown }).memory) : null));
  }

  decide(args: MemoryDecisionArgs): Promise<ChatResult<true>> {
    return coreCall(this.backend, 'POST', `/memory/${args.id}/${args.action}`, REQUEST_TIMEOUT_MS, undefined,
      (raw) => (typeof raw === 'object' && raw !== null ? true : null));
  }

  setSettings(settings: MemorySettings): Promise<ChatResult<MemorySettings>> {
    const body = { capture_enabled: settings.captureEnabled, project: settings.project };
    return coreCall(this.backend, 'POST', '/memory/settings', REQUEST_TIMEOUT_MS, body, parseMemorySettings);
  }
}
