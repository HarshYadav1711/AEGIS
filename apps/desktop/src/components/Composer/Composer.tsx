import { useState, type KeyboardEvent, type Ref } from 'react';

import { MAX_PROMPT_CHARS, type ChatError } from '../../shared/contracts';

interface ComposerProps {
  /** Why sending is impossible right now, or null when a model is ready. */
  unavailableReason: string | null;
  models: string[];
  model: string | null;
  onModelChange: (model: string) => void;
  busy: boolean;
  canCancel: boolean;
  error: ChatError | null;
  onSend: (content: string, model: string) => Promise<boolean>;
  onCancel: () => void;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Message box. Enter sends, Shift+Enter inserts a newline. */
export function Composer({
  unavailableReason,
  models,
  model,
  onModelChange,
  busy,
  canCancel,
  error,
  onSend,
  onCancel,
  ref,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const tooLong = draft.length > MAX_PROMPT_CHARS;
  const canSend = !unavailableReason && !busy && model !== null && draft.trim().length > 0 && !tooLong;

  const submit = async () => {
    if (!canSend || model === null) return;
    const content = draft;
    setDraft('');
    const accepted = await onSend(content, model);
    // The core refused it before storing anything: give the text back.
    if (!accepted) setDraft((current) => (current ? current : content));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  let note: string;
  if (error) note = `${error.detail} (${error.code})`;
  else if (unavailableReason) note = unavailableReason;
  else if (busy) note = canCancel ? 'Generating a reply… you can stop it.' : 'Sending…';
  else note = 'Enter to send, Shift+Enter for a new line. Replies come from the selected local model.';

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-describedby="composer-note"
    >
      <label htmlFor="composer-input" className="visually-hidden">
        Message to AEGIS
      </label>
      <textarea
        id="composer-input"
        ref={ref}
        className="composer__input"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask AEGIS…"
        spellCheck={false}
        aria-invalid={tooLong || undefined}
      />
      <div className="composer__actions">
        {busy ? (
          <button type="button" className="button" onClick={onCancel} disabled={!canCancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button button--primary" disabled={!canSend}>
            Send
          </button>
        )}
      </div>
      <div className="composer__footer">
        <label htmlFor="model-select">Model</label>
        <select
          id="model-select"
          value={model ?? ''}
          disabled={busy || models.length === 0}
          onChange={(event) => onModelChange(event.target.value)}
        >
          {models.length === 0 && <option value="">No local model available</option>}
          {models.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {draft.length > MAX_PROMPT_CHARS * 0.9 && (
          <span className={tooLong ? 'composer__count composer__count--over' : 'composer__count'}>
            {draft.length} / {MAX_PROMPT_CHARS}
          </span>
        )}
      </div>
      <p id="composer-note" className="composer__note" data-error={error ? 'true' : undefined}>
        {note}
      </p>
    </form>
  );
}
