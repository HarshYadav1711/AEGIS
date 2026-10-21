import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AddMemoryArgs,
  ChatError,
  ChatResult,
  MemoryDecisionArgs,
  MemoryRecord,
  MemorySettings,
} from '../shared/contracts';

export interface MemoryState {
  memories: MemoryRecord[];
  settings: MemorySettings | null;
  query: string;
  includeHistory: boolean;
  error: ChatError | null;
  notice: string | null;
  setQuery: (query: string) => void;
  setIncludeHistory: (value: boolean) => void;
  setOpen: (open: boolean) => void;
  add: (args: AddMemoryArgs) => Promise<boolean>;
  correct: (id: string, content: string) => Promise<boolean>;
  decide: (args: MemoryDecisionArgs) => Promise<boolean>;
  saveSettings: (settings: MemorySettings) => Promise<boolean>;
}

const OUTCOME_NOTICE = {
  saved: 'Saved as your own statement.',
  duplicate: 'Already in memory; nothing new was stored.',
  disputed: 'Saved, but it conflicts with a memory on the same subject. Both are disputed until you confirm one.',
} as const;

/**
 * Memory panel state. Everything shown is re-read from the core after each
 * action, so the list always reflects what is stored, not what was intended.
 * `changeKey` lets the app refresh the open panel after chats or tasks finish.
 */
export function useMemory(coreOnline: boolean, changeKey: number): MemoryState {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [query, setQuery] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const bridge = window.aegis;
    if (!bridge || !coreOnline) return;
    const request = ++latest.current;
    const result = await bridge.listMemories({ query: query.slice(0, 200), includeHistory });
    if (request !== latest.current) return; // a newer search superseded this one
    if (result.ok) {
      setMemories(result.value.memories);
      setSettings(result.value.settings);
    } else {
      setError(result.error);
    }
  }, [coreOnline, query, includeHistory]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void refresh(), 150); // also debounces typing in the search box
    return () => window.clearTimeout(timer);
  }, [open, refresh, changeKey]);

  const run = useCallback(
    async <T,>(call: () => Promise<ChatResult<T>>, done: (value: T) => string): Promise<boolean> => {
      setError(null);
      setNotice(null);
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setNotice(done(result.value));
      await refresh();
      return true;
    },
    [refresh],
  );

  const bridge = () => {
    if (!window.aegis) throw new Error('The desktop bridge is unavailable.');
    return window.aegis;
  };

  return {
    memories,
    settings,
    query,
    includeHistory,
    error,
    notice,
    setQuery,
    setIncludeHistory,
    setOpen,
    add: (args) => run(() => bridge().addMemory(args), (v) => OUTCOME_NOTICE[v.outcome]),
    correct: (id, content) =>
      run(() => bridge().correctMemory({ id, content }), () => 'Corrected. The previous version is kept as history.'),
    decide: (args) =>
      run(() => bridge().decideMemory(args), () =>
        args.action === 'delete'
          ? 'Deleted permanently, including earlier versions.'
          : args.action === 'confirm'
            ? 'Confirmed. It is now a current memory.'
            : 'Rejected. It will not be used in replies.',
      ),
    saveSettings: (next) => run(() => bridge().setMemorySettings(next), () => 'Memory settings saved.'),
  };
}
