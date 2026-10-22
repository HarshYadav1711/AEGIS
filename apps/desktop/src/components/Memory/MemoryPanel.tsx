import { useState, type FormEvent } from 'react';

import { MAX_MEMORY_CHARS, type MemoryRecord } from '../../shared/contracts';
import type { MemoryState } from '../../hooks/useMemory';

const VERIFICATION_LABEL: Record<MemoryRecord['verification'], string> = {
  user_stated: 'stated by you',
  user_confirmed: 'confirmed by you',
  tool_verified: 'verified by an AEGIS tool',
  model_proposed: 'proposed by the model — not verified',
};

const SOURCE_LABEL: Record<string, string> = {
  user_message: 'chat message',
  memory_ui: 'memory panel',
  file_task: 'file task',
  research_task: 'research task',
  repo_task: 'repository task',
  voice_command: 'spoken correction (reviewed)',
};

function statusLabel(m: MemoryRecord): string {
  if (m.expired) return 'expired';
  if (m.status === 'superseded') return m.supersededBy ? 'superseded by a newer version' : 'superseded';
  return m.status;
}

function MemoryItem({ memory: m, state, busy }: { memory: MemoryRecord; state: MemoryState; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const live = m.status === 'active' || m.status === 'candidate' || m.status === 'disputed';
  const reviewable = (m.status === 'candidate' || m.status === 'disputed') && !m.expired;

  return (
    <li className="memory__item" data-status={m.expired ? 'expired' : m.status} data-memory-id={m.id}>
      {editing ? (
        <form
          className="memory__edit"
          onSubmit={(event) => {
            event.preventDefault();
            void state.correct(m.id, draft).then((ok) => ok && setEditing(false));
          }}
        >
          <label className="visually-hidden" htmlFor={`correct-${m.id}`}>Corrected text</label>
          <textarea
            id={`correct-${m.id}`}
            value={draft}
            maxLength={MAX_MEMORY_CHARS}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="button button--primary" disabled={busy || !draft.trim()}>Save correction</button>
          <button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <p className="memory__content">{m.content}</p>
      )}
      <p className="memory__meta">
        <span className="memory__status">{statusLabel(m)}</span>
        {' · '}{m.kind}{' · '}{VERIFICATION_LABEL[m.verification]}{' · '}{m.scope}
        {' · '}from {m.source ? (SOURCE_LABEL[m.source.sourceType] ?? m.source.sourceType) : 'unknown source'}
        {' · '}v{m.version}{' · '}
        <time dateTime={m.recordedAt}>{new Date(m.recordedAt).toLocaleString()}</time>
        {m.usedCount > 0 && ` · used in ${m.usedCount} repl${m.usedCount === 1 ? 'y' : 'ies'}`}
        {m.expiresAt && !m.expired && ` · expires ${new Date(m.expiresAt).toLocaleDateString()}`}
      </p>
      {m.status === 'disputed' && <p className="memory__warn">Conflicts with another memory on “{m.subject}”. Not used in replies until you confirm one.</p>}
      {m.status === 'candidate' && !m.expired && <p className="memory__warn">Suggestion only. Not used in replies unless you confirm it.</p>}
      {m.statusReason && !live && <p className="memory__meta">{m.statusReason}</p>}
      <div className="memory__actions">
        {reviewable && (
          <button type="button" className="button" disabled={busy} onClick={() => void state.decide({ id: m.id, action: 'confirm' })}>
            Confirm
          </button>
        )}
        {live && m.kind !== 'experience' && !editing && (
          <button type="button" className="button" disabled={busy} onClick={() => { setDraft(m.content); setEditing(true); }}>
            Correct
          </button>
        )}
        {live && (
          <button type="button" className="button" disabled={busy} onClick={() => void state.decide({ id: m.id, action: 'reject' })}>
            Reject
          </button>
        )}
        {confirmDelete ? (
          <>
            <button type="button" className="button button--danger" disabled={busy}
              onClick={() => void state.decide({ id: m.id, action: 'delete' })}>
              Delete all versions permanently
            </button>
            <button type="button" className="button" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete…</button>
        )}
      </div>
    </li>
  );
}

/** Inspect, search, add, correct, confirm, reject and delete local memories. Nothing here is decorative. */
export function MemoryPanel({ state, disabled }: { state: MemoryState; disabled: boolean }) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<'fact' | 'preference'>('fact');
  const [subject, setSubject] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [expiresOn, setExpiresOn] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const settings = state.settings;
  const projectDraft = project ?? settings?.project ?? '';
  const busy = disabled;
  const current = state.memories.filter((m) => m.current).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void state
      .add({ content, kind, subject: subject.trim() || null, scope, expiresOn: expiresOn || null })
      .then((ok) => {
        if (ok) {
          setContent('');
          setSubject('');
          setExpiresOn('');
        }
      });
  };

  return (
    <details className="panel memory" onToggle={(event) => state.setOpen(event.currentTarget.open)}>
      <summary>Memory{settings ? ` (${current} current${settings.captureEnabled ? '' : ', capture off'})` : ''}</summary>

      <div className="memory__settings">
        <label>
          <input
            type="checkbox"
            checked={settings?.captureEnabled ?? true}
            disabled={busy || !settings}
            onChange={(event) =>
              settings && void state.saveSettings({ captureEnabled: event.target.checked, project: settings.project })
            }
          />{' '}
          Save memories from chat (“Remember …”, suggested preferences) and completed tasks
        </label>
        <form
          className="memory__row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!settings) return;
            void state
              .saveSettings({ captureEnabled: settings.captureEnabled, project: projectDraft.trim() || null })
              .then((ok) => ok && setProject(null));
          }}
        >
          <label htmlFor="memory-project">Current project</label>
          <input id="memory-project" value={projectDraft} maxLength={40} placeholder="none (global only)"
            onChange={(event) => setProject(event.target.value)} />
          <button type="submit" className="button" disabled={busy || !settings}>Set</button>
        </form>
      </div>

      <div className="memory__row" role="search">
        <label htmlFor="memory-search">Search</label>
        <input id="memory-search" type="search" value={state.query} maxLength={200}
          onChange={(event) => state.setQuery(event.target.value)} />
        <label>
          <input type="checkbox" checked={state.includeHistory}
            onChange={(event) => state.setIncludeHistory(event.target.checked)} />{' '}
          Show history (superseded, rejected)
        </label>
      </div>

      <div role="status" aria-live="polite">
        {state.error && <p className="memory__error">{state.error.detail}</p>}
        {state.notice && <p className="panel__note">{state.notice}</p>}
      </div>

      {state.memories.length === 0 ? (
        <p className="panel__note">
          {state.query ? 'No memories match.' : 'No memories yet. Start a chat message with “Remember: …” or add one below.'}
        </p>
      ) : (
        <ul className="memory__list">
          {state.memories.map((m) => <MemoryItem key={m.id} memory={m} state={state} busy={busy} />)}
        </ul>
      )}

      <form className="memory__add" onSubmit={submit}>
        <label htmlFor="memory-new">Add a memory</label>
        <textarea id="memory-new" value={content} rows={2} maxLength={MAX_MEMORY_CHARS}
          onChange={(event) => setContent(event.target.value)} />
        <div className="memory__row">
          <label htmlFor="memory-kind">Type</label>
          <select id="memory-kind" value={kind} onChange={(event) => setKind(event.target.value as 'fact' | 'preference')}>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
          </select>
          <label htmlFor="memory-subject">Subject (optional)</label>
          <input id="memory-subject" value={subject} maxLength={60} placeholder="e.g. preferred editor"
            onChange={(event) => setSubject(event.target.value)} />
          <label htmlFor="memory-scope">Scope</label>
          <select id="memory-scope" value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'project')}>
            <option value="global">Global</option>
            <option value="project" disabled={!settings?.project}>
              {settings?.project ? `Project: ${settings.project}` : 'Project (set one first)'}
            </option>
          </select>
          <label htmlFor="memory-expires">Expires (optional)</label>
          <input id="memory-expires" type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
          <button type="submit" className="button button--primary" disabled={busy || !content.trim()}>Add</button>
        </div>
      </form>
    </details>
  );
}
