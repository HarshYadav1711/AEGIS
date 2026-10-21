import { useState } from 'react';

import { MAX_VAULT_NOTE_CHARS, type VaultRecord } from '../../shared/contracts';
import type { VaultState } from '../../hooks/useVault';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function VaultRow({ vault: v, state, disabled }: { vault: VaultRecord; state: VaultState; disabled: boolean }) {
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const indexed = v.counts.indexed ?? 0;
  const skipped = Object.entries(v.counts).filter(([k]) => k !== 'indexed' && k !== 'deleted');
  return (
    <li className="memory__item" data-vault-id={v.id}>
      <p className="memory__content">{v.rootPath}</p>
      <p className="memory__meta">
        <span className="memory__status">{v.writeArea ? `AEGIS may add notes in ${v.writeArea}/` : 'read-only'}</span>
        {' · '}{v.kind === 'existing' ? 'existing Obsidian vault' : 'new AEGIS vault'}
        {' · '}{indexed} note{indexed === 1 ? '' : 's'} indexed
        {skipped.map(([k, n]) => ` · ${n} ${k.replace('_', ' ')}`)}
        {' · '}index {v.indexStatus}, {when(v.indexedAt)}
      </p>
      <p className="memory__meta">{v.indexDetail}</p>
      <div className="memory__actions">
        <button type="button" className="button" disabled={disabled} onClick={() => state.reindex(v.id)}>Re-index now</button>
        {v.writeArea ? (
          <button type="button" className="button" disabled={disabled} onClick={() => state.setWriteArea(v.id, false)}>
            Make read-only
          </button>
        ) : confirmWrite ? (
          <>
            <button type="button" className="button button--primary" disabled={disabled}
              onClick={() => { state.setWriteArea(v.id, true); setConfirmWrite(false); }}>
              Allow new notes in AEGIS/ only
            </button>
            <button type="button" className="button" onClick={() => setConfirmWrite(false)}>Keep read-only</button>
          </>
        ) : (
          <button type="button" className="button" disabled={disabled} onClick={() => setConfirmWrite(true)}>
            Allow AEGIS folder…
          </button>
        )}
        {confirmRemove ? (
          <>
            <button type="button" className="button button--danger" disabled={disabled} onClick={() => state.remove(v.id)}>
              Forget this vault (files stay)
            </button>
            <button type="button" className="button" onClick={() => setConfirmRemove(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="button" disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove…</button>
        )}
      </div>
    </li>
  );
}

/** Authorized local Markdown vaults: register, search, open, add a note to the AEGIS area. */
export function VaultPanel({ state, disabled }: { state: VaultState; disabled: boolean }) {
  const writable = state.vaults.filter((v) => v.writeArea);
  const [vaultId, setVaultId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const busy = disabled || state.working;
  const target = writable.find((v) => v.id === vaultId)?.id ?? writable[0]?.id ?? '';

  return (
    <details className="panel memory vault" onToggle={(event) => state.setOpen(event.currentTarget.open)}>
      <summary>Vaults ({state.vaults.length})</summary>
      <p className="panel__note">
        Markdown notes in folders you choose. Existing Obsidian vaults stay read-only unless you allow an AEGIS/
        folder. Note text is only searched here; it is not sent to the model.
      </p>
      <button type="button" className="button" disabled={busy} onClick={state.choose}>Add vault…</button>
      <div role="status" aria-live="polite">
        {state.error && <p className="memory__error">{state.error.detail}</p>}
        {state.notice && <p className="panel__note">{state.notice}</p>}
      </div>
      {state.vaults.length > 0 && (
        <ul className="memory__list">
          {state.vaults.map((v) => <VaultRow key={v.id} vault={v} state={state} disabled={busy} />)}
        </ul>
      )}

      <div className="memory__row" role="search">
        <label htmlFor="vault-search">Search notes</label>
        <input id="vault-search" type="search" value={state.query} maxLength={200}
          onChange={(event) => state.setQuery(event.target.value)} />
      </div>
      {state.query.trim() && (
        state.results.length === 0 ? (
          <p className="panel__note">No indexed note matches.</p>
        ) : (
          <ul className="memory__list">
            {state.results.map((n) => (
              <li key={n.id} className="memory__item" data-note-id={n.id}>
                <p className="memory__content">{n.title}</p>
                {n.snippet && <p className="memory__meta">{n.snippet}</p>}
                <p className="memory__meta">
                  {n.relPath}
                  {' · '}{n.author === 'aegis_user' ? 'added via AEGIS (unchanged since)' : 'your note'}
                  {' · '}modified {when(n.modifiedAt)}{' · '}indexed {when(n.indexedAt)}{' · '}v{n.version}
                  {n.tags.length > 0 && ` · #${n.tags.join(' #')}`}
                </p>
                <div className="memory__actions">
                  <button type="button" className="button" disabled={busy} onClick={() => state.openNote(n.id)}>Open</button>
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      <form
        className="memory__add"
        onSubmit={(event) => {
          event.preventDefault();
          void state.addNote({ vaultId: target, title, body }).then((ok) => {
            if (ok) {
              setTitle('');
              setBody('');
            }
          });
        }}
      >
        <label htmlFor="vault-note-title">Add a note to an AEGIS folder</label>
        {writable.length === 0 ? (
          <p className="panel__note">No vault allows AEGIS to write yet. Add an empty folder as a new vault, or allow the AEGIS folder.</p>
        ) : (
          <>
            <div className="memory__row">
              <label htmlFor="vault-target">Vault</label>
              <select id="vault-target" value={target} onChange={(event) => setVaultId(event.target.value)}>
                {writable.map((v) => <option key={v.id} value={v.id}>{v.rootPath}</option>)}
              </select>
              <input id="vault-note-title" value={title} maxLength={120} placeholder="Title"
                onChange={(event) => setTitle(event.target.value)} />
            </div>
            <label className="visually-hidden" htmlFor="vault-note-body">Note text</label>
            <textarea id="vault-note-body" value={body} rows={3} maxLength={MAX_VAULT_NOTE_CHARS}
              onChange={(event) => setBody(event.target.value)} />
            <button type="submit" className="button button--primary" disabled={busy || !title.trim() || !body.trim()}>
              Create note (never overwrites)
            </button>
          </>
        )}
      </form>
    </details>
  );
}
