import { useCallback, useEffect, useRef, useState } from 'react';

import type { AddVaultNoteArgs, ChatError, ChatResult, VaultNote, VaultRecord } from '../shared/contracts';

export interface VaultState {
  vaults: VaultRecord[];
  results: VaultNote[];
  query: string;
  error: ChatError | null;
  notice: string | null;
  working: boolean;
  setQuery: (query: string) => void;
  setOpen: (open: boolean) => void;
  choose: () => void;
  reindex: (vaultId: string) => void;
  setWriteArea: (vaultId: string, enabled: boolean) => void;
  remove: (vaultId: string) => void;
  addNote: (args: AddVaultNoteArgs) => Promise<boolean>;
  openNote: (noteId: string) => void;
}

/** Vault panel state. Lists and results are always re-read from the core's index after an action. */
export function useVault(coreOnline: boolean): VaultState {
  const [vaults, setVaults] = useState<VaultRecord[]>([]);
  const [results, setResults] = useState<VaultNote[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const bridge = window.aegis;
    if (!bridge || !coreOnline) return;
    const request = ++latest.current;
    // Searching also re-scans vaults whose index is older than a few seconds (picks up external edits).
    const result = query.trim()
      ? await bridge.searchVaults(query.slice(0, 200))
      : await bridge.listVaults().then((r): ChatResult<{ notes: VaultNote[]; vaults: VaultRecord[] }> =>
          r.ok ? { ok: true, value: { notes: [], vaults: r.value } } : r);
    if (request !== latest.current) return;
    if (result.ok) {
      setVaults(result.value.vaults);
      setResults(result.value.notes);
    } else {
      setError(result.error);
    }
  }, [coreOnline, query]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void refresh(), 200);
    return () => window.clearTimeout(timer);
  }, [open, refresh]);

  const run = useCallback(
    async <T,>(call: () => Promise<ChatResult<T>>, done: (value: T) => string | null): Promise<boolean> => {
      setError(null);
      setNotice(null);
      setWorking(true);
      try {
        const result = await call();
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        setNotice(done(result.value));
        await refresh();
        return true;
      } finally {
        setWorking(false);
      }
    },
    [refresh],
  );

  const bridge = () => {
    if (!window.aegis) throw new Error('The desktop bridge is unavailable.');
    return window.aegis;
  };

  return {
    vaults,
    results,
    query,
    error,
    notice,
    working,
    setQuery,
    setOpen,
    choose: () =>
      void run(() => bridge().chooseVault(), (v) => (v ? `Vault added and indexed: ${v.indexDetail}` : null)),
    reindex: (id) => void run(() => bridge().reindexVault(id), (v) => `Re-indexed: ${v.indexDetail}`),
    setWriteArea: (vaultId, enabled) =>
      void run(() => bridge().setVaultWriteArea({ vaultId, enabled }), (v) =>
        v.writeArea ? `AEGIS may now create new notes in ${v.writeArea}/ only.` : 'The vault is read-only for AEGIS again.',
      ),
    remove: (id) => void run(() => bridge().removeVault(id), () => 'Removed from AEGIS. No file was changed.'),
    addNote: (args) => run(() => bridge().addVaultNote(args), (n) => `Created ${n.relPath} and indexed it.`),
    openNote: (id) => void run(() => bridge().openVaultNote(id), () => null),
  };
}
