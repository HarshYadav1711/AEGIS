import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceActivity } from '../orb/orbModel';
import {
  MAX_RECORDING_SECONDS,
  MAX_SPEAK_TEXT_CHARS,
  type CorrectionCategory,
  type MemoryRecord,
  type TranscriptResult,
  type VoiceInterpretation,
  type VoiceStatus,
} from '../shared/contracts';
import { levelFromRms, recordingToWav, rms, rmsFromBytes } from '../voice/audio';
import {
  canAutoSend,
  microphoneError,
  type VoiceError,
  type VoiceOutcome,
  type VoicePhase,
} from '../voice/voiceModel';

/** How long Done / Cancelled / Error stay on the orb after a voice step. */
const SETTLE_MS = 2_500;
const PREFS_KEY = 'aegis.voice.preferences';
/** Stop a little before the core's limit so the WAV always fits. */
const AUTO_STOP_SECONDS = MAX_RECORDING_SECONDS - 0.5;

export interface MicDevice {
  id: string;
  label: string;
}

export interface VoicePreferences {
  /** Send ordinary questions without showing the transcript first (memory changes are always shown). */
  autoSend: boolean;
  /** Read replies to spoken requests aloud with the local Windows voice. */
  speakReplies: boolean;
  voice: string | null;
}

/** Measured on this machine for the last voice step; nothing here is estimated. */
export interface VoiceMetrics {
  recordedMs: number | null;
  /** Core-measured speech recognition time for the recording. */
  transcribeMs: number | null;
  /** Renderer-measured round trip: stop pressed → transcript shown. */
  transcriptRoundTripMs: number | null;
  /** Core-measured speech synthesis time. */
  synthesisMs: number | null;
  /** Renderer-measured: speak requested → audio actually playing. */
  speechStartMs: number | null;
  speechAudioMs: number | null;
  spokenChars: number | null;
  truncated: boolean;
}

export interface VoiceReview {
  transcript: TranscriptResult | null;
  interpretation: VoiceInterpretation | null;
  /** Stable per review, so a retried "Apply" never writes twice. */
  correctionRequestId: string;
  conversationId: string | null;
}

export interface VoiceState {
  status: VoiceStatus | null;
  statusError: string | null;
  phase: VoicePhase;
  activity: VoiceActivity;
  error: VoiceError | null;
  notice: string | null;
  devices: MicDevice[];
  deviceId: string;
  elapsedMs: number;
  review: VoiceReview | null;
  metrics: VoiceMetrics;
  preferences: VoicePreferences;
  /** Live audio level for the orb, or null when no audio is being captured or played. */
  levelSource: (() => number) | null;
  /** Instant level for the in-panel meter (same source). */
  level: () => number;
  canStart: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  send: (text: string) => void;
  discard: () => void;
  applyCorrection: (target: MemoryRecord, content: string, category: CorrectionCategory) => void;
  speak: (text: string, kind: 'reply' | 'status') => void;
  stopSpeaking: () => void;
  setDeviceId: (id: string) => void;
  setPreferences: (next: VoicePreferences) => void;
  dismissError: () => void;
}

interface Options {
  coreOnline: boolean;
  /** Why a new recording cannot start (busy task, no model, …), or null. */
  blockedReason: string | null;
  conversationId: string | null;
  /** Route reviewed text exactly like typed text (input mode voice). Resolves false if it was not accepted. */
  submit: (text: string) => Promise<boolean>;
  onMemoryChanged: () => void;
}

const EMPTY_METRICS: VoiceMetrics = {
  recordedMs: null,
  transcribeMs: null,
  transcriptRoundTripMs: null,
  synthesisMs: null,
  speechStartMs: null,
  speechAudioMs: null,
  spokenChars: null,
  truncated: false,
};

function loadPreferences(): VoicePreferences {
  const fallback: VoicePreferences = { autoSend: true, speakReplies: true, voice: null };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<VoicePreferences> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      autoSend: typeof raw.autoSend === 'boolean' ? raw.autoSend : fallback.autoSend,
      speakReplies: typeof raw.speakReplies === 'boolean' ? raw.speakReplies : fallback.speakReplies,
      voice: typeof raw.voice === 'string' ? raw.voice : null,
    };
  } catch {
    return fallback;
  }
}

interface Capture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  startedAt: number;
  timer: number;
}

interface Playback {
  context: AudioContext;
  source: AudioBufferSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * Push-to-talk voice, driven only by real events: the microphone is on exactly
 * between start() and stop()/cancel() (or the 60 s limit, a lost device, or the
 * page going away); "speaking" is set only once synthesized audio is playing.
 */
export function useVoice({ coreOnline, blockedReason, conversationId, submit, onMemoryChanged }: Options): VoiceState {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  const [outcome, setOutcome] = useState<VoiceOutcome>('none');
  const [error, setError] = useState<VoiceError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [review, setReview] = useState<VoiceReview | null>(null);
  const [metrics, setMetrics] = useState<VoiceMetrics>(EMPTY_METRICS);
  const [preferences, setPreferencesState] = useState<VoicePreferences>(loadPreferences);

  const phaseRef = useRef<VoicePhase>('idle');
  const captureRef = useRef<Capture | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const micLevel = useRef(0);
  const abortRequest = useRef(false);
  const transcriptionId = useRef<string | null>(null);
  const speechId = useRef<string | null>(null);
  const settleTimer = useRef<number | null>(null);
  const prefsRef = useRef(preferences);
  const conversationRef = useRef(conversationId);
  const submitRef = useRef(submit);
  const memoryChangedRef = useRef(onMemoryChanged);
  const stopSpeakingRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    prefsRef.current = preferences;
    conversationRef.current = conversationId;
    submitRef.current = submit;
    memoryChangedRef.current = onMemoryChanged;
  });

  const setPhase = (next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const finish = useCallback((result: VoiceOutcome) => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    setOutcome(result);
    settleTimer.current = result === 'none' ? null : window.setTimeout(() => setOutcome('none'), SETTLE_MS);
  }, []);

  const fail = useCallback(
    (code: string, detail: string) => {
      setError({ code, detail });
      setPhase('idle');
      finish('failed');
    },
    [finish],
  );

  // ------------------------------------------------------------ engine status and devices

  useEffect(() => {
    if (!coreOnline) return;
    let live = true;
    void window.aegis?.getVoiceStatus().then((result) => {
      if (!live) return;
      if (result.ok) {
        setStatus(result.value);
        setStatusError(null);
      } else {
        setStatus(null);
        setStatusError(result.error.detail);
      }
    });
    return () => {
      live = false;
    };
  }, [coreOnline]);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
      setDevices(
        inputs.map((d, i) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      );
      setDeviceId((current) => (current && !inputs.some((d) => d.deviceId === current) ? '' : current));
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    const timer = window.setTimeout(() => void refreshDevices(), 0);
    media.addEventListener('devicechange', refreshDevices);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  // ------------------------------------------------------------ capture

  const releaseCapture = useCallback((): Capture | null => {
    const capture = captureRef.current;
    captureRef.current = null;
    micLevel.current = 0;
    if (!capture) return null;
    window.clearInterval(capture.timer);
    capture.processor.onaudioprocess = null;
    capture.processor.disconnect();
    capture.source.disconnect();
    for (const track of capture.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    void capture.context.close().catch(() => undefined);
    return capture;
  }, []);

  const interpretAndRoute = useCallback(
    async (transcript: TranscriptResult) => {
      const bridge = window.aegis;
      if (!bridge) return;
      const conversation = conversationRef.current;
      const base: VoiceReview = {
        transcript,
        interpretation: null,
        correctionRequestId: crypto.randomUUID(),
        conversationId: conversation,
      };
      if (transcript.status === 'silence') {
        setNotice('No speech was detected in the recording. Nothing was sent.');
        setPhase('idle');
        finish('none');
        return;
      }
      if (transcript.status === 'unintelligible' || !transcript.text.trim()) {
        setReview(base);
        setNotice('The speech engine could not make out any words. Type what you meant, or try again.');
        setPhase('review');
        return;
      }
      setPhase('interpreting');
      const result = await bridge.interpretVoice({
        text: transcript.text,
        conversationId: conversation,
        lowConfidence: transcript.lowConfidence,
      });
      if (!result.ok) {
        setReview(base);
        setError(result.error);
        setPhase('review');
        return;
      }
      if (canAutoSend(result.value, prefsRef.current.autoSend)) {
        setPhase('idle');
        const accepted = await submitRef.current(transcript.text);
        if (!accepted) {
          setReview({ ...base, interpretation: result.value });
          setPhase('review');
        }
        return;
      }
      setReview({ ...base, interpretation: result.value });
      setPhase('review');
    },
    [finish],
  );

  const transcribe = useCallback(
    async (capture: Capture) => {
      const bridge = window.aegis;
      if (!bridge) return;
      const recording = recordingToWav(capture.chunks, capture.context.sampleRate);
      capture.chunks.length = 0;
      if (!recording.ok) {
        fail('empty_recording', recording.reason === 'empty' ? 'Nothing was recorded.' : 'The recording was too long.');
        return;
      }
      const requestId = crypto.randomUUID();
      transcriptionId.current = requestId;
      setPhase('transcribing');
      const stoppedAt = performance.now();
      const result = await bridge.transcribe({ requestId, audio: recording.wav });
      if (transcriptionId.current !== requestId) return; // cancelled meanwhile; the UI already moved on
      transcriptionId.current = null;
      if (!result.ok) {
        if (result.error.code === 'cancelled') {
          setNotice('Transcription stopped. Nothing was sent.');
          setPhase('idle');
          finish('cancelled');
        } else fail(result.error.code, result.error.detail);
        return;
      }
      setMetrics((m) => ({
        ...m,
        recordedMs: Math.round(recording.seconds * 1000),
        transcribeMs: result.value.processingMs,
        transcriptRoundTripMs: Math.round(performance.now() - stoppedAt),
      }));
      console.info(
        `[aegis-voice] transcript status=${result.value.status} audio_ms=${result.value.audioMs} ` +
          `stt_ms=${result.value.processingMs} roundtrip_ms=${Math.round(performance.now() - stoppedAt)} ` +
          `engine=${result.value.engine}/${result.value.model}`,
      );
      await interpretAndRoute(result.value);
    },
    [fail, finish, interpretAndRoute],
  );

  const stop = useCallback(() => {
    if (phaseRef.current === 'requesting') {
      abortRequest.current = true;
      return;
    }
    if (phaseRef.current !== 'listening') return;
    const capture = releaseCapture();
    if (capture) void transcribe(capture);
  }, [releaseCapture, transcribe]);

  const start = useCallback(() => {
    // Pressing the microphone while AEGIS talks interrupts the speech first (barge-in by button, not by sound).
    if (phaseRef.current === 'speaking' || phaseRef.current === 'synthesizing') stopSpeakingRef.current();
    if (phaseRef.current !== 'idle' || captureRef.current) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      fail('mic_unsupported', 'Microphone capture is not available in this window.');
      return;
    }
    setError(null);
    setNotice(null);
    setReview(null);
    setMetrics(EMPTY_METRICS);
    abortRequest.current = false;
    setPhase('requesting');
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await media.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      } catch (caught) {
        const problem = microphoneError(caught instanceof DOMException ? caught.name : '');
        fail(problem.code, problem.detail);
        return;
      }
      if (abortRequest.current || phaseRef.current !== 'requesting') {
        for (const track of stream.getTracks()) track.stop();
        setPhase('idle');
        finish('cancelled');
        return;
      }
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const capture: Capture = {
        stream,
        context,
        source,
        processor,
        chunks: [],
        startedAt: performance.now(),
        timer: 0,
      };
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        capture.chunks.push(new Float32Array(data));
        micLevel.current = levelFromRms(rms(data));
      };
      source.connect(processor);
      processor.connect(context.destination); // required for processing to run; the output stays silent
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          // The device was unplugged or disabled mid-recording: stop honestly, keep nothing.
          if (captureRef.current !== capture) return;
          releaseCapture();
          fail('mic_lost', 'The microphone stopped (unplugged or disabled). The recording was discarded.');
          void refreshDevices();
        };
      }
      capture.timer = window.setInterval(() => {
        const elapsed = performance.now() - capture.startedAt;
        setElapsedMs(elapsed);
        if (elapsed >= AUTO_STOP_SECONDS * 1000 && captureRef.current === capture) {
          setNotice(`Recording stopped at the ${MAX_RECORDING_SECONDS} s limit.`);
          const finished = releaseCapture();
          if (finished) void transcribe(finished);
        }
      }, 200);
      captureRef.current = capture;
      await context.resume().catch(() => undefined);
      setElapsedMs(0);
      setPhase('listening');
      finish('none');
      void refreshDevices(); // labels become available once permission is granted
    })();
  }, [deviceId, fail, finish, refreshDevices, releaseCapture, transcribe]);

  // ------------------------------------------------------------ speech playback

  const releasePlayback = useCallback(() => {
    const playback = playbackRef.current;
    playbackRef.current = null;
    if (!playback) return;
    playback.source.onended = null;
    try {
      playback.source.stop();
    } catch {
      /* already stopped */
    }
    playback.source.disconnect();
    void playback.context.close().catch(() => undefined);
  }, []);

  const stopSpeaking = useCallback(() => {
    const pending = speechId.current;
    speechId.current = null;
    if (pending) void window.aegis?.cancelVoiceJob(pending);
    const wasSpeaking = playbackRef.current !== null;
    releasePlayback();
    if (pending || wasSpeaking) {
      if (phaseRef.current === 'synthesizing' || phaseRef.current === 'speaking') setPhase('idle');
      setNotice('Speech stopped.');
      finish('cancelled');
    }
  }, [finish, releasePlayback]);
  useEffect(() => {
    stopSpeakingRef.current = stopSpeaking;
  }, [stopSpeaking]);

  const speak = useCallback(
    (text: string, kind: 'reply' | 'status') => {
      const bridge = window.aegis;
      if (!bridge || !prefsRef.current.speakReplies || !text.trim()) return;
      if (phaseRef.current === 'listening' || phaseRef.current === 'requesting') return; // never talk over capture
      releasePlayback();
      const requestId = crypto.randomUUID();
      speechId.current = requestId;
      setPhase('synthesizing');
      const requestedAt = performance.now();
      void (async () => {
        const result = await bridge.speak({
          requestId,
          text: text.slice(0, MAX_SPEAK_TEXT_CHARS),
          voice: prefsRef.current.voice,
        });
        if (speechId.current !== requestId) return; // stopped meanwhile
        if (!result.ok) {
          speechId.current = null;
          if (result.error.code === 'cancelled') return;
          fail(result.error.code, `Speech output failed: ${result.error.detail}`);
          return;
        }
        let context: AudioContext | null = null;
        try {
          context = new AudioContext();
          const buffer = await context.decodeAudioData(result.value.audio.slice().buffer);
          if (speechId.current !== requestId) {
            void context.close();
            return;
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          analyser.connect(context.destination);
          const playback: Playback = { context, source, analyser, data: new Uint8Array(analyser.fftSize) };
          source.onended = () => {
            if (playbackRef.current !== playback) return;
            releasePlayback();
            speechId.current = null;
            setPhase('idle');
            finish('succeeded');
          };
          playbackRef.current = playback;
          await context.resume();
          source.start();
          if (context.state !== 'running') throw new Error('audio output did not start');
          const startedMs = Math.round(performance.now() - requestedAt);
          setMetrics((m) => ({
            ...m,
            synthesisMs: result.value.synthesisMs,
            speechStartMs: startedMs,
            speechAudioMs: result.value.audioMs,
            spokenChars: result.value.spokenChars,
            truncated: result.value.truncated,
          }));
          setNotice(
            kind === 'status'
              ? 'AEGIS spoke a status message (local Windows voice).'
              : `Reading the reply aloud (${result.value.voice}, local).` +
                  (result.value.truncated ? ' Only the first part is read; the rest is on screen.' : ''),
          );
          console.info(
            `[aegis-voice] speech synthesis_ms=${result.value.synthesisMs} start_ms=${startedMs} ` +
              `audio_ms=${result.value.audioMs} chars=${result.value.spokenChars} voice=${result.value.voice}`,
          );
          setPhase('speaking');
        } catch {
          releasePlayback();
          if (context && context.state !== 'closed') void context.close().catch(() => undefined);
          speechId.current = null;
          fail('playback_failed', 'The speech audio could not be played on this device.');
        }
      })();
    },
    [fail, finish, releasePlayback],
  );

  // ------------------------------------------------------------ review actions

  const send = useCallback(
    (text: string) => {
      const current = review;
      if (!current || !text.trim()) return;
      void (async () => {
        const bridge = window.aegis;
        if (!bridge) return;
        // Edited text is classified again: an edit can turn a question into a memory change, which needs its own card.
        const edited = text.trim() !== (current.interpretation?.text ?? '').trim();
        if (edited) {
          setPhase('interpreting');
          const result = await bridge.interpretVoice({ text, conversationId: current.conversationId, lowConfidence: false });
          if (!result.ok) {
            setError(result.error);
            setPhase('review');
            return;
          }
          if (result.value.kind === 'correct') {
            setReview({ ...current, interpretation: result.value });
            setPhase('review');
            return;
          }
        }
        setPhase('idle');
        setReview(null);
        setError(null);
        setNotice(null);
        const accepted = await submitRef.current(text);
        if (!accepted) {
          setReview(current);
          setPhase('review');
          setError({ code: 'not_sent', detail: 'The message could not be sent right now; it is kept here.' });
        }
      })();
    },
    [review],
  );

  const discard = useCallback(() => {
    setReview(null);
    setError(null);
    setNotice('Discarded. Nothing was sent or stored.');
    setPhase('idle');
    finish('cancelled');
  }, [finish]);

  const applyCorrection = useCallback(
    (target: MemoryRecord, content: string, category: CorrectionCategory) => {
      const current = review;
      const bridge = window.aegis;
      if (!current || !bridge) return;
      setPhase('applying');
      setError(null);
      void (async () => {
        const result = await bridge.applyVoiceCorrection({
          requestId: current.correctionRequestId,
          targetId: target.id,
          content,
          category,
          conversationId: current.conversationId,
        });
        if (!result.ok) {
          setError(result.error);
          setPhase('review');
          finish('failed');
          return;
        }
        setReview(null);
        setNotice(
          `Memory updated to version ${result.value.version}. Version ${result.value.version - 1} is kept in its history ` +
            'as superseded.',
        );
        setPhase('idle');
        finish('succeeded');
        memoryChangedRef.current();
        speak(`Memory updated to version ${result.value.version}.`, 'status');
      })();
    },
    [finish, review, speak],
  );

  // ------------------------------------------------------------ cancel and teardown

  const cancel = useCallback(() => {
    switch (phaseRef.current) {
      case 'requesting':
        abortRequest.current = true;
        break;
      case 'listening':
        releaseCapture();
        setNotice('Recording discarded. Nothing was transcribed.');
        setPhase('idle');
        finish('cancelled');
        break;
      case 'transcribing': {
        const pending = transcriptionId.current;
        transcriptionId.current = null;
        if (pending) void window.aegis?.cancelVoiceJob(pending);
        setNotice('Transcription stopped. Nothing was sent.');
        setPhase('idle');
        finish('cancelled');
        break;
      }
      case 'synthesizing':
      case 'speaking':
        stopSpeaking();
        break;
      case 'review':
        discard();
        break;
      default:
        break;
    }
  }, [discard, finish, releaseCapture, stopSpeaking]);

  useEffect(() => {
    // The page is going away (reload, close, quit): the microphone and audio must not outlive it.
    const teardown = () => {
      releaseCapture();
      releasePlayback();
      if (transcriptionId.current) void window.aegis?.cancelVoiceJob(transcriptionId.current);
      if (speechId.current) void window.aegis?.cancelVoiceJob(speechId.current);
    };
    window.addEventListener('pagehide', teardown);
    return () => {
      window.removeEventListener('pagehide', teardown);
      teardown();
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    };
  }, [releaseCapture, releasePlayback]);

  useEffect(() => {
    // Losing the core mid-step: stop listening (nothing could be transcribed) and drop pending work.
    if (coreOnline) return;
    const timer = window.setTimeout(() => {
      if (phaseRef.current === 'listening' || phaseRef.current === 'requesting') {
        releaseCapture();
        fail('core_unavailable', 'The local core went offline; the recording was discarded.');
      } else if (phaseRef.current === 'transcribing' || phaseRef.current === 'synthesizing') {
        transcriptionId.current = null;
        speechId.current = null;
        fail('core_unavailable', 'The local core went offline before the voice step finished.');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [coreOnline, fail, releaseCapture]);

  const setPreferences = useCallback((next: VoicePreferences) => {
    setPreferencesState(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* preferences are a convenience; the defaults apply */
    }
  }, []);

  const level = useCallback(() => {
    const playback = playbackRef.current;
    if (playback) {
      playback.analyser.getByteTimeDomainData(playback.data);
      return levelFromRms(rmsFromBytes(playback.data));
    }
    return micLevel.current;
  }, []);

  let activity: VoiceActivity;
  if (phase === 'listening') activity = 'listening';
  else if (phase === 'transcribing' || phase === 'interpreting') activity = 'transcribing';
  else if (phase === 'applying') activity = 'applying';
  else if (phase === 'speaking') activity = 'speaking';
  else activity = outcome;

  const sttReady = status?.stt.available === true;
  return {
    status,
    statusError,
    phase,
    activity,
    error,
    notice,
    devices,
    deviceId,
    elapsedMs,
    review,
    metrics,
    preferences,
    levelSource: phase === 'listening' || phase === 'speaking' ? level : null,
    level,
    canStart:
      coreOnline &&
      sttReady &&
      blockedReason === null &&
      (phase === 'idle' || phase === 'speaking' || phase === 'synthesizing'),
    start,
    stop,
    cancel,
    send,
    discard,
    applyCorrection,
    speak,
    stopSpeaking,
    setDeviceId,
    setPreferences,
    dismissError: () => setError(null),
  };
}
