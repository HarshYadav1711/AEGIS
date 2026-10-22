import {
  MAX_SPEECH_BYTES,
  parseMemoryRecord,
  parseTranscriptResult,
  parseVoiceInterpretation,
  parseVoiceStatus,
  parseWavHeader,
  type ChatResult,
  type MemoryRecord,
  type SpeakArgs,
  type SpeechResult,
  type TranscribeArgs,
  type TranscriptResult,
  type VoiceCorrectionArgs,
  type VoiceInterpretArgs,
  type VoiceInterpretation,
  type VoiceStatus,
} from '../src/shared/contracts';
import { CoreUnavailableError, type BackendManager } from './backend';
import { coreCall, errorFromResponse, failure } from './files';

const REQUEST_TIMEOUT_MS = 10_000;
/** The first status call lists Windows voices (one short PowerShell run). */
const STATUS_TIMEOUT_MS = 30_000;
/** A 60 s recording on a slow CPU, plus loading the model the first time. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;
/** The core bounds one synthesis at 60 s. */
const SPEAK_TIMEOUT_MS = 75_000;

/**
 * Main-process client for local voice. The renderer sends a finished recording
 * (already validated as 16 kHz mono PCM WAV), transcript text, ids and memory
 * ids only. No channel can approve a plan, run a tool or delete memory.
 *
 * Every pending transcription/synthesis is tracked so it can be cancelled when
 * the user presses Stop, when the window goes away, or when the app quits.
 */
export class VoiceService {
  private readonly backend: BackendManager;
  private readonly pending = new Map<string, AbortController>();

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  status(): Promise<ChatResult<VoiceStatus>> {
    return coreCall(this.backend, 'GET', '/voice/status', STATUS_TIMEOUT_MS, undefined, parseVoiceStatus);
  }

  async transcribe(args: TranscribeArgs): Promise<ChatResult<TranscriptResult>> {
    return this.track(args.requestId, TRANSCRIBE_TIMEOUT_MS, async (signal) => {
      const response = await this.backend.request('/voice/transcriptions', {
        method: 'POST',
        audio: { bytes: args.audio, requestId: args.requestId },
        signal,
      });
      if (!response.ok) return { ok: false, error: await errorFromResponse(response) };
      const value = parseTranscriptResult(await response.json());
      if (!value || value.requestId !== args.requestId) {
        return failure('invalid_core_response', 'The core returned data that does not match the contract.');
      }
      return { ok: true, value };
    });
  }

  interpret(args: VoiceInterpretArgs): Promise<ChatResult<VoiceInterpretation>> {
    const body = { text: args.text, conversation_id: args.conversationId, low_confidence: args.lowConfidence };
    return coreCall(this.backend, 'POST', '/voice/interpret', REQUEST_TIMEOUT_MS, body, parseVoiceInterpretation);
  }

  applyCorrection(args: VoiceCorrectionArgs): Promise<ChatResult<MemoryRecord>> {
    const body = {
      request_id: args.requestId,
      target_id: args.targetId,
      content: args.content,
      category: args.category,
      conversation_id: args.conversationId,
    };
    return coreCall(this.backend, 'POST', '/voice/memory-corrections', REQUEST_TIMEOUT_MS, body, (raw) =>
      typeof raw === 'object' && raw !== null ? parseMemoryRecord((raw as { memory?: unknown }).memory) : null,
    );
  }

  async speak(args: SpeakArgs): Promise<ChatResult<SpeechResult>> {
    return this.track(args.requestId, SPEAK_TIMEOUT_MS, async (signal) => {
      const response = await this.backend.request('/voice/speech', {
        method: 'POST',
        body: { request_id: args.requestId, text: args.text, voice: args.voice },
        signal,
      });
      if (!response.ok) return { ok: false, error: await errorFromResponse(response) };
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_SPEECH_BYTES) return failure('invalid_core_response', 'Speech audio exceeded the size limit.');
      const audio = new Uint8Array(await response.arrayBuffer());
      const header = response.headers;
      const info = parseWavHeader(audio);
      const numbers = ['x-aegis-synthesis-ms', 'x-aegis-audio-ms', 'x-aegis-spoken-chars'].map((h) =>
        Number(header.get(h)),
      );
      const voice = header.get('x-aegis-voice');
      if (audio.length > MAX_SPEECH_BYTES || !info || info.channels !== 1 || info.bitsPerSample !== 16 || !voice) {
        return failure('invalid_core_response', 'The core returned speech audio that does not match the contract.');
      }
      if (!numbers.every((n) => Number.isInteger(n) && n >= 0)) {
        return failure('invalid_core_response', 'The core returned speech audio that does not match the contract.');
      }
      const [synthesisMs, audioMs, spokenChars] = numbers as [number, number, number];
      return {
        ok: true,
        value: { audio, voice, synthesisMs, audioMs, spokenChars, truncated: header.get('x-aegis-truncated') === '1' },
      };
    });
  }

  /** Stop one pending job: abort the local request and ask the core to stop the work. */
  async cancel(requestId: string): Promise<ChatResult<true>> {
    this.pending.get(requestId)?.abort();
    const result = await coreCall(this.backend, 'POST', `/voice/jobs/${requestId}/cancel`, REQUEST_TIMEOUT_MS,
      undefined, (raw) => (typeof raw === 'object' && raw !== null ? true : null));
    return result.ok ? { ok: true, value: true } : result;
  }

  /** The renderer went away (reload, crash, close) or the app is quitting: nothing it asked for may keep running. */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) void this.cancel(requestId).catch(() => undefined);
  }

  private async track<T>(
    requestId: string,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<ChatResult<T>>,
  ): Promise<ChatResult<T>> {
    if (this.pending.has(requestId)) return failure('request_in_progress', 'This voice request is already running.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    this.pending.set(requestId, controller);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (error instanceof CoreUnavailableError) return failure('core_unavailable', error.message);
      if (controller.signal.aborted) {
        return controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout'
          ? failure('timeout', 'The local voice engine did not answer in time.')
          : failure('cancelled', 'Stopped.');
      }
      return failure('core_unavailable', 'Lost the connection to the local core.');
    } finally {
      clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }
}
