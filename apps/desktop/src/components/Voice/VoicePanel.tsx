import { useEffect, useRef, useState } from 'react';

import type { VoiceState } from '../../hooks/useVoice';
import type { MemoryRecord, VoiceInterpretation } from '../../shared/contracts';
import { CATEGORY_LABELS, correctionCategory, proposeRevision } from '../../voice/voiceModel';

interface VoicePanelProps {
  voice: VoiceState;
  /** Why recording cannot start right now (busy task, no model, core offline), or null. */
  blockedReason: string | null;
  reducedMotion: boolean;
}

const PHASE_TEXT: Record<VoiceState['phase'], string> = {
  idle: '',
  requesting: 'Opening the microphone…',
  listening: 'Microphone on — speak now, then press Stop.',
  transcribing: 'Transcribing locally…',
  interpreting: 'Checking what the transcript asks for…',
  review: 'Review the transcript before anything happens.',
  applying: 'Saving the corrected memory…',
  synthesizing: 'Preparing speech…',
  speaking: 'Speaking (local Windows voice).',
};

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Level meter driven by the live capture/playback level; repaints only while audio is live. */
function LevelMeter({ level, live, reducedMotion }: { level: () => number; live: boolean; reducedMotion: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) {
      if (bar.current) bar.current.style.transform = 'scaleX(0)';
      return;
    }
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (reducedMotion && now - last < 250) return; // coarse updates only, no smooth motion
      last = now;
      if (bar.current) bar.current.style.transform = `scaleX(${level().toFixed(3)})`;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level, live, reducedMotion]);
  return (
    <span className="voice__meter" aria-hidden="true">
      <span ref={bar} className="voice__meter-bar" />
    </span>
  );
}

function MemoryLine({ memory }: { memory: MemoryRecord }) {
  return (
    <span className="voice__memory">
      “{memory.content}” <span className="voice__meta">v{memory.version} · {memory.scope} · {memory.verification.replace('_', ' ')}</span>
    </span>
  );
}

function CorrectionCard({ voice, interpretation }: { voice: VoiceState; interpretation: VoiceInterpretation }) {
  const [targetId, setTargetId] = useState(interpretation.target?.id ?? '');
  const target = [interpretation.target, ...interpretation.candidates].find((c) => c?.id === targetId) ?? null;
  const category = correctionCategory(interpretation);
  const [text, setText] = useState(interpretation.proposedContent ?? '');
  const busy = voice.phase === 'applying';
  const pick = (candidate: MemoryRecord) => {
    setTargetId(candidate.id);
    setText(interpretation.body ? proposeRevision(candidate.content, interpretation.body, category) : '');
  };

  return (
    <div className="voice__card" role="group" aria-label="Spoken memory correction">
      <p className="voice__heard">
        Heard: <q>{interpretation.text}</q>
      </p>
      {interpretation.category && <p className="voice__category">{CATEGORY_LABELS[interpretation.category]}</p>}
      <p className="voice__reason">{interpretation.reason}</p>
      {interpretation.target && interpretation.candidates.length <= 1 ? (
        <p>
          Memory to correct: <MemoryLine memory={interpretation.target} />
        </p>
      ) : interpretation.candidates.length > 0 ? (
        <fieldset className="voice__candidates">
          <legend>Which memory should change?</legend>
          {interpretation.candidates.map((c) => (
            <label key={c.id}>
              <input
                type="radio"
                name="voice-target"
                value={c.id}
                checked={targetId === c.id}
                onChange={() => pick(c)}
              />{' '}
              <MemoryLine memory={c} />
            </label>
          ))}
        </fieldset>
      ) : null}
      {target && (
        <>
          <label htmlFor="voice-correction">New version (stored exactly as written)</label>
          <textarea
            id="voice-correction"
            className="voice__text"
            rows={3}
            value={text}
            maxLength={500}
            onChange={(event) => setText(event.target.value)}
          />
        </>
      )}
      <div className="voice__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!target || !text.trim() || busy}
          onClick={() => target && voice.applyCorrection(target, text.trim(), category)}
        >
          {busy ? 'Saving…' : category === 'temporary' ? 'Apply as permanent correction' : 'Apply correction'}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => voice.send(interpretation.text)}>
          Send as a message instead
        </button>
        <button type="button" className="button" disabled={busy} onClick={voice.discard}>
          Discard
        </button>
      </div>
    </div>
  );
}

function ReviewCard({ voice }: { voice: VoiceState }) {
  const review = voice.review!;
  const interpretation = review.interpretation;
  const [draft, setDraft] = useState(interpretation?.text ?? review.transcript?.text ?? '');
  if (interpretation?.kind === 'correct') return <CorrectionCard voice={voice} interpretation={interpretation} />;

  const refused = interpretation?.kind === 'forget' || interpretation?.kind === 'approval';
  const busy = voice.phase !== 'review';
  return (
    <div className="voice__card" role="group" aria-label="Transcript review">
      {review.transcript && (
        <p className="voice__meta">
          Transcribed locally by {review.transcript.engine} {review.transcript.model} from{' '}
          {seconds(review.transcript.audioMs)} of audio in {seconds(review.transcript.processingMs)}
          {review.transcript.lowConfidence ? ' · low confidence' : ''}
        </p>
      )}
      {interpretation?.category && <p className="voice__category">{CATEGORY_LABELS[interpretation.category]}</p>}
      {interpretation && <p className="voice__reason">{interpretation.reason}</p>}
      {interpretation?.conflict && (
        <p>
          Current memory: <MemoryLine memory={interpretation.conflict} />
        </p>
      )}
      <label htmlFor="voice-draft">{refused ? 'Transcript' : 'Transcript (edit before sending if needed)'}</label>
      <textarea
        id="voice-draft"
        className="voice__text"
        rows={2}
        value={draft}
        maxLength={2000}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="voice__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!draft.trim() || busy}
          onClick={() => voice.send(draft)}
        >
          {refused ? 'Send as an ordinary message' : interpretation?.kind === 'remember' ? 'Send and remember' : 'Send'}
        </button>
        <button type="button" className="button" disabled={busy} onClick={voice.discard}>
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * Push-to-talk. The microphone is on only between "Start speaking" and "Stop"
 * (or Cancel, the 60 s limit, a lost device, or leaving the page); the red
 * indicator and timer are shown for exactly that time.
 */
export function VoicePanel({ voice, blockedReason, reducedMotion }: VoicePanelProps) {
  const { phase, status } = voice;
  const listening = phase === 'listening';
  const speaking = phase === 'speaking' || phase === 'synthesizing';
  const sttMissing = status !== null && !status.stt.available;
  const m = voice.metrics;

  let hint: string;
  if (voice.statusError) hint = `Voice is unavailable: ${voice.statusError}`;
  else if (status === null) hint = 'Checking the local speech engines…';
  else if (sttMissing) hint = `Speech recognition is unavailable: ${status.stt.detail}`;
  else if (PHASE_TEXT[phase]) hint = PHASE_TEXT[phase];
  else if (blockedReason) hint = blockedReason;
  else hint = `Push to talk. Speech is transcribed on this computer (${status.stt.engine} ${status.stt.model}); audio is never saved.`;

  return (
    <section className="voice" aria-label="Voice" data-phase={phase}>
      <div className="voice__bar">
        {listening ? (
          <button type="button" className="button button--record" onClick={voice.stop} aria-pressed="true">
            Stop and transcribe
          </button>
        ) : (
          <button
            type="button"
            className="button voice__mic"
            onClick={voice.start}
            disabled={!voice.canStart}
            aria-pressed="false"
          >
            Start speaking
          </button>
        )}
        {(listening || phase === 'requesting' || phase === 'transcribing') && (
          <button type="button" className="button" onClick={voice.cancel}>
            {phase === 'transcribing' ? 'Stop transcribing' : 'Cancel'}
          </button>
        )}
        {speaking && (
          <button type="button" className="button" onClick={voice.stopSpeaking}>
            Stop speaking
          </button>
        )}
        {listening && (
          <span className="voice__live" role="status">
            <span className="voice__dot" aria-hidden="true" /> Microphone on · {seconds(voice.elapsedMs)}
          </span>
        )}
        <LevelMeter level={voice.level} live={listening || phase === 'speaking'} reducedMotion={reducedMotion} />
      </div>
      {/* A busy task already explains itself in the composer note; repeating it would crowd the plan panel. */}
      {!(phase === 'idle' && blockedReason && !voice.statusError && !sttMissing) && (
        <p className="voice__hint" role="status" aria-live="polite">
          {hint}
        </p>
      )}
      {voice.notice && <p className="voice__notice">{voice.notice}</p>}
      {voice.error && (
        <p className="voice__error" role="alert">
          {voice.error.detail} <span className="voice__meta">({voice.error.code})</span>{' '}
          <button type="button" className="button button--small" onClick={voice.dismissError}>
            Dismiss
          </button>
        </p>
      )}
      {voice.review && (phase === 'review' || phase === 'interpreting' || phase === 'applying') && (
        <ReviewCard key={voice.review.correctionRequestId + (voice.review.interpretation?.kind ?? '')} voice={voice} />
      )}
      <details className="voice__settings">
        <summary>Voice settings and measurements</summary>
        {(m.recordedMs !== null || m.synthesisMs !== null) && (
          <p className="voice__meta voice__metrics">
            Last measured: recording {seconds(m.recordedMs)} · recognition {seconds(m.transcribeMs)} (core) · transcript
            shown after {seconds(m.transcriptRoundTripMs)} · speech synthesis {seconds(m.synthesisMs)} · audio started
            after {seconds(m.speechStartMs)}
          </p>
        )}
        <div className="voice__grid">
          <label htmlFor="voice-device">Microphone</label>
          <select
            id="voice-device"
            value={voice.deviceId}
            disabled={phase !== 'idle'}
            onChange={(event) => voice.setDeviceId(event.target.value)}
          >
            <option value="">System default</option>
            {voice.devices
              .filter((d) => d.id !== '')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
          </select>
          <label htmlFor="voice-voice">Speech voice</label>
          <select
            id="voice-voice"
            value={voice.preferences.voice ?? ''}
            disabled={!status?.tts.available}
            onChange={(event) => voice.setPreferences({ ...voice.preferences, voice: event.target.value || null })}
          >
            <option value="">{status?.tts.voices[0] ? `Default (${status.tts.voices[0]})` : 'Default'}</option>
            {status?.tts.voices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <label className="voice__check">
          <input
            type="checkbox"
            checked={voice.preferences.autoSend}
            onChange={(event) => voice.setPreferences({ ...voice.preferences, autoSend: event.target.checked })}
          />{' '}
          Send ordinary spoken questions without review (memory changes and low-confidence transcripts are always
          shown first)
        </label>
        <label className="voice__check">
          <input
            type="checkbox"
            checked={voice.preferences.speakReplies}
            onChange={(event) => voice.setPreferences({ ...voice.preferences, speakReplies: event.target.checked })}
          />{' '}
          Read replies to spoken requests aloud ({status?.tts.available ? status.tts.detail : 'unavailable'})
        </label>
        <p className="voice__meta">
          Voice can ask, remember and propose memory corrections. It cannot approve plans, run tools or delete
          memories: those always need a click.
        </p>
      </details>
    </section>
  );
}
