import type { ConversationSummary } from '../../shared/contracts';

interface ConversationListProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  disabled: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString();
}

/** Saved conversations (stored in the local SQLite database). */
export function ConversationList({ conversations, activeId, disabled, onOpen, onNew }: ConversationListProps) {
  return (
    <nav className="conversations" aria-label="Saved conversations">
      <button type="button" className="button conversations__new" onClick={onNew} disabled={disabled}>
        New conversation
      </button>
      {conversations.length === 0 ? (
        <p className="conversations__empty">No saved conversations yet.</p>
      ) : (
        <ul className="conversations__list">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="conversations__item"
                aria-current={c.id === activeId ? 'true' : undefined}
                disabled={disabled && c.id !== activeId}
                onClick={() => onOpen(c.id)}
              >
                <span className="conversations__title">{c.title}</span>
                <span className="conversations__when">{formatWhen(c.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
