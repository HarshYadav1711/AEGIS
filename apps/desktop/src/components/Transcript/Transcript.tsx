import { useEffect, useLayoutEffect, useRef } from 'react';

import type { ChatMessageRecord } from '../../shared/contracts';

interface TranscriptProps {
  messages: ChatMessageRecord[];
  loading: boolean;
  busy: boolean;
}

function assistantMeta(m: ChatMessageRecord): string {
  const source = [m.provider, m.model].filter(Boolean).join(' · ') || 'unknown model';
  switch (m.status) {
    case 'pending':
      return `${source} · waiting for the model…`;
    case 'streaming':
      return `${source} · generating…`;
    case 'complete': {
      const parts = [source];
      if (m.durationMs !== null) parts.push(`${(m.durationMs / 1000).toFixed(1)} s`);
      if (m.completionTokens !== null) parts.push(`${m.completionTokens} tokens`);
      if (m.finishReason === 'length') parts.push('stopped at the length limit');
      return parts.join(' · ');
    }
    case 'cancelled':
      return `${source} · stopped by you — partial reply`;
    case 'failed':
      return `${source} · failed`;
  }
}

/**
 * Conversation history. Model output is untrusted, so it is rendered strictly
 * as text (React escapes it; no Markdown/HTML interpretation, no links).
 */
export function Transcript({ messages, loading, busy }: TranscriptProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at the bottom; updated on scroll so streaming text only
  // pulls the view down while the reader has not scrolled up to read history.
  const stickToBottom = useRef(true);
  const last = messages[messages.length - 1];

  const scrollToEnd = () => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // A new turn or a freshly opened conversation always shows its newest message.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    scrollToEnd();
  }, [messages.length]);

  useEffect(() => {
    if (stickToBottom.current) scrollToEnd();
  }, [last?.content, last?.status]);

  if (loading) {
    return (
      <div className="transcript transcript--empty" aria-busy="true">
        Loading conversation…
      </div>
    );
  }
  if (messages.length === 0) {
    return <div className="transcript transcript--empty">No messages yet. Your conversation is saved on this computer.</div>;
  }

  return (
    <div
      ref={scrollerRef}
      className="transcript"
      aria-busy={busy}
      onScroll={(event) => {
        const el = event.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <ol className="transcript__list" aria-label="Conversation messages">
        {messages.map((m) => (
          <li key={m.id} className="message" data-role={m.role} data-status={m.status}>
            <span className="message__who">
              {m.role === 'user' ? (m.inputMode === 'voice' ? 'You (spoken, transcribed locally)' : 'You') : 'AEGIS'}
            </span>
            {m.content ? (
              <p className="message__text">{m.content}</p>
            ) : (
              m.role === 'assistant' &&
              (m.status === 'pending' || m.status === 'streaming') && (
                <p className="message__text message__text--placeholder">Waiting for the first words…</p>
              )
            )}
            {m.role === 'assistant' && <span className="message__meta">{assistantMeta(m)}</span>}
            {m.status === 'failed' && (
              <p className="message__error" role="note">
                {m.errorDetail ?? 'The reply failed.'} {m.errorCode && <code>({m.errorCode})</code>}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
