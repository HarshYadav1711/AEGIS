import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS as CONTRACT_MAX_SECONDS,
  VOICE_SAMPLE_RATE as CONTRACT_RATE,
  type VoiceInterpretation,
  parseSpeakArgs,
  parseTranscribeArgs,
  parseTranscriptResult,
  parseVoiceCorrectionArgs,
  parseVoiceInterpretArgs,
  parseVoiceInterpretation,
  parseVoiceStatus,
  parseWavHeader,
} from '../src/shared/contracts.ts';
import { isMicrophoneRequest } from '../src/shared/permissions.ts';
import {
  concat,
  downsample,
  encodeWav,
  levelFromRms,
  MAX_RECORDING_SECONDS,
  recordingToWav,
  rms,
  rmsFromBytes,
  VOICE_SAMPLE_RATE,
} from '../src/voice/audio.ts';
import { canAutoSend, correctionCategory, microphoneError, proposeRevision } from '../src/voice/voiceModel.ts';

const RID = '0b7b5bb4-7f1e-4c4e-9f0e-6a1f6f0f2a10';
const MID = '6f1d2c1e-8a0b-4c55-9d3e-0f6a7b8c9d01';
const CID = '6d9f8f4e-2c41-4a8b-9a51-9ad8e8a3c7e1';

function tone(seconds: number, rate: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate);
  return out;
}

function coreMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: MID,
    lineage_id: MID,
    version: 1,
    kind: 'fact',
    subject: null,
    content: 'my preferred development workflow uses manual commits.',
    scope: 'global',
    status: 'active',
    verification: 'user_stated',
    source_event_id: MID,
    supersedes_id: null,
    superseded_by: null,
    conflicts_with: null,
    observed_at: '2026-10-22T00:00:00.000+00:00',
    recorded_at: '2026-10-22T00:00:00.000+00:00',
    expires_at: null,
    status_at: '2026-10-22T00:00:00.000+00:00',
    status_reason: null,
    expired: false,
    current: true,
    used_count: 1,
    source: {
      kind: 'remember',
      source_type: 'user_message',
      source_id: MID,
      conversation_id: CID,
      at: '2026-10-22T00:00:00.000+00:00',
      detail: 'Explicit remember instruction, spoken (local transcript, confirmed by the user in the app).',
    },
    ...overrides,
  };
}

// ------------------------------------------------------------------ audio encoding (renderer side)

test('renderer audio constants match the contract', () => {
  assert.equal(VOICE_SAMPLE_RATE, CONTRACT_RATE);
  assert.equal(MAX_RECORDING_SECONDS, CONTRACT_MAX_SECONDS);
});

test('a 48 kHz capture becomes a 16 kHz mono 16-bit WAV the core accepts', () => {
  const recording = recordingToWav([tone(0.5, 48_000), tone(0.5, 48_000)], 48_000);
  assert.ok(recording.ok);
  if (!recording.ok) return;
  assert.equal(Math.round(recording.seconds * 100) / 100, 1);
  assert.deepEqual(parseWavHeader(recording.wav), { sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes: 32_000 });
  assert.ok(parseTranscribeArgs({ requestId: RID, audio: recording.wav }));
});

test('downsampling averages windows and never upsamples', () => {
  assert.deepEqual([...downsample(new Float32Array([1, 1, 1, 0, 0, 0]), 48_000, 16_000)], [1, 0]);
  assert.throws(() => downsample(new Float32Array(10), 8_000, 16_000));
  assert.equal(concat([new Float32Array(3), new Float32Array(2)]).length, 5);
});

test('samples are clipped, and levels map silence to 0 and loud audio near 1', () => {
  const wav = encodeWav(new Float32Array([2, -2, 0]));
  const view = new DataView(wav.buffer);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(rms(new Float32Array(100))), 0);
  assert.ok(levelFromRms(rms(tone(0.1, 16_000, 0.5))) > 0.9);
  assert.equal(rmsFromBytes(new Uint8Array(64).fill(128)), 0);
});

test('an empty capture is never sent', () => {
  assert.deepEqual(recordingToWav([], 48_000), { ok: false, reason: 'empty' });
});

// ------------------------------------------------------------------ IPC argument validation (main side)

test('transcription arguments must be exactly one well-formed recording', () => {
  const wav = encodeWav(tone(1, 16_000));
  assert.ok(parseTranscribeArgs({ requestId: RID, audio: wav }));
  const stereo = encodeWav(tone(1, 16_000));
  new DataView(stereo.buffer).setUint16(22, 2, true);
  const fast = encodeWav(tone(1, 16_000));
  new DataView(fast.buffer).setUint32(24, 44_100, true);
  const bad: unknown[] = [
    null,
    { requestId: RID },
    { requestId: 'nope', audio: wav },
    { requestId: RID, audio: [...wav] }, // a plain array is not audio bytes
    { requestId: RID, audio: new TextEncoder().encode('RIFF....WAVEnot really') },
    { requestId: RID, audio: stereo },
    { requestId: RID, audio: fast },
    { requestId: RID, audio: new Uint8Array(MAX_RECORDING_BYTES + 1) },
    { requestId: RID, audio: wav, path: 'C:\\Windows\\win.ini' },
  ];
  for (const value of bad) assert.equal(parseTranscribeArgs(value), null);
});

test('interpretation, correction and speech arguments are strict', () => {
  assert.deepEqual(parseVoiceInterpretArgs({ text: 'hi', conversationId: null, lowConfidence: false }), {
    text: 'hi',
    conversationId: null,
    lowConfidence: false,
  });
  assert.equal(parseVoiceInterpretArgs({ text: ' ', conversationId: null, lowConfidence: false }), null);
  assert.equal(parseVoiceInterpretArgs({ text: 'hi', conversationId: 'x', lowConfidence: false }), null);

  const correction = { requestId: RID, targetId: MID, content: 'New text.', category: 'project_exception', conversationId: CID };
  assert.deepEqual(parseVoiceCorrectionArgs(correction), correction);
  for (const bad of [
    { ...correction, category: 'conflicting_claim' },
    { ...correction, category: 'approve' },
    { ...correction, content: 'x'.repeat(501) },
    { ...correction, status: 'active' },
    { ...correction, verification: 'tool_verified' },
  ]) {
    assert.equal(parseVoiceCorrectionArgs(bad), null, JSON.stringify(bad));
  }

  assert.deepEqual(parseSpeakArgs({ requestId: RID, text: 'Hello.', voice: 'Microsoft Zira Desktop' }), {
    requestId: RID,
    text: 'Hello.',
    voice: 'Microsoft Zira Desktop',
  });
  for (const voice of ['$(calc)', 'Zira; Start-Process', 'a'.repeat(81)]) {
    assert.equal(parseSpeakArgs({ requestId: RID, text: 'Hello.', voice }), null, voice);
  }
});

// ------------------------------------------------------------------ core responses

test('core voice responses are parsed and checked', () => {
  const status = parseVoiceStatus({
    stt: { engine: 'faster-whisper', model: 'base.en', available: true, detail: 'ok' },
    tts: { engine: 'windows-sapi', available: true, detail: 'ok', voices: ['Microsoft Zira Desktop'] },
    limits: { sample_rate: 16000, max_seconds: 60, max_speak_chars: 1200 },
  });
  assert.equal(status?.stt.model, 'base.en');
  assert.equal(status?.limits.maxSeconds, 60);

  const transcript = {
    request_id: RID, status: 'ok', text: 'Hello', audio_ms: 1200, processing_ms: 700,
    engine: 'faster-whisper', model: 'base.en', low_confidence: false,
  };
  assert.equal(parseTranscriptResult(transcript)?.text, 'Hello');
  assert.equal(parseTranscriptResult({ ...transcript, status: 'guessed' }), null);
  assert.equal(parseTranscriptResult({ ...transcript, audio_ms: -1 }), null);

  const interpretation = {
    kind: 'correct', text: 'Correct that memory: only in my test repository', review_required: true,
    reason: 'Review it.', category: 'project_exception', body: 'only in my test repository',
    target: coreMemory(), candidates: [coreMemory()], proposed_content: 'x (correction: y).', conflict: null,
  };
  const parsed = parseVoiceInterpretation(interpretation);
  assert.equal(parsed?.target?.id, MID);
  assert.equal(parsed?.candidates.length, 1);
  assert.equal(parseVoiceInterpretation({ ...interpretation, kind: 'delete_everything' }), null);
  assert.equal(parseVoiceInterpretation({ ...interpretation, target: { id: MID } }), null);
});

// ------------------------------------------------------------------ flow rules

test('microphone failures are explained, not hidden', () => {
  assert.equal(microphoneError('NotAllowedError').code, 'mic_denied');
  assert.match(microphoneError('NotAllowedError').detail, /Privacy & security/);
  assert.equal(microphoneError('NotFoundError').code, 'mic_not_found');
  assert.equal(microphoneError('OverconstrainedError').code, 'mic_not_found');
  assert.equal(microphoneError('NotReadableError').code, 'mic_unreadable');
  assert.equal(microphoneError('Weird').code, 'mic_error');
});

test('only plain questions may be sent without review', () => {
  const base: Omit<VoiceInterpretation, 'kind'> = {
    text: 'x', reviewRequired: false, reason: '', category: null, body: null, target: null, candidates: [],
    proposedContent: null, conflict: null,
  };
  assert.ok(canAutoSend({ ...base, kind: 'chat' }, true));
  assert.ok(canAutoSend({ ...base, kind: 'recall' }, true));
  assert.ok(!canAutoSend({ ...base, kind: 'chat' }, false));
  for (const kind of ['remember', 'correct', 'forget', 'approval', 'empty'] as const) {
    assert.ok(!canAutoSend({ ...base, kind }, true), kind);
  }
  assert.ok(!canAutoSend({ ...base, kind: 'chat', reviewRequired: true }, true));
  assert.equal(correctionCategory({ ...base, kind: 'correct', category: 'conflicting_claim' }), 'explicit_correction');
});

test('client-side revision proposal matches the core rule', () => {
  assert.equal(
    proposeRevision(
      'my preferred development workflow uses manual commits.',
      'this exception applies only to my test repository.',
      'project_exception',
    ),
    'My preferred development workflow uses manual commits (correction: this exception applies only to my test repository).',
  );
  assert.equal(proposeRevision('old', 'my workflow uses automatic commits', 'explicit_correction'), 'My workflow uses automatic commits.');
});

test('only microphone capture from the app page is permitted', () => {
  const isApp = (url: string) => url === 'file:///app/index.html';
  const app = 'file:///app/index.html';
  assert.ok(isMicrophoneRequest(isApp, 'media', app, true, ['audio']));
  assert.ok(!isMicrophoneRequest(isApp, 'media', app, true, ['audio', 'video']), 'camera');
  assert.ok(!isMicrophoneRequest(isApp, 'media', app, true, ['video']), 'camera only');
  assert.ok(!isMicrophoneRequest(isApp, 'media', app, true, []), 'unspecified');
  assert.ok(!isMicrophoneRequest(isApp, 'media', app, true, undefined), 'unspecified');
  assert.ok(!isMicrophoneRequest(isApp, 'media', 'https://evil.example/', true, ['audio']), 'other page');
  assert.ok(!isMicrophoneRequest(isApp, 'media', app, false, ['audio']), 'subframe');
  for (const other of ['display-capture', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
    assert.ok(!isMicrophoneRequest(isApp, other, app, true, ['audio']), other);
  }
});
