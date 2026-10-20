import { useState } from 'react';

const STORAGE_KEY = 'aegis.model';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The model the user picked (a non-sensitive UI preference kept in localStorage).
 * Only names the core currently reports as installed are ever returned, so the
 * app never sends a request for a model it believes is absent.
 */
export function useModelSelection(available: string[]): [string | null, (model: string) => void] {
  const [chosen, setChosen] = useState<string | null>(readStored);
  const effective = chosen !== null && available.includes(chosen) ? chosen : (available[0] ?? null);

  const choose = (model: string) => {
    setChosen(model);
    try {
      localStorage.setItem(STORAGE_KEY, model);
    } catch {
      /* storage unavailable: choice lasts for this session only */
    }
  };
  return [effective, choose];
}
