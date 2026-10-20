import { useState, type Ref } from 'react';

interface ComposerProps {
  chatAvailable: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Message box. Drafting works; sending is disabled because no model adapter
 * exists in Phase 0 (the core's /health reports capabilities.chat = false).
 */
export function Composer({ chatAvailable, ref }: ComposerProps) {
  const [draft, setDraft] = useState('');
  return (
    <form className="composer" onSubmit={(event) => event.preventDefault()} aria-describedby="composer-note">
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
        placeholder="Ask AEGIS…"
        spellCheck={false}
      />
      <button type="submit" className="button button--primary" disabled={!chatAvailable}>
        Send
      </button>
      <p id="composer-note" className="composer__note">
        {chatAvailable
          ? 'Chat is available.'
          : 'Conversation arrives in Phase 1. No language model is connected, so messages cannot be sent yet.'}
      </p>
    </form>
  );
}
