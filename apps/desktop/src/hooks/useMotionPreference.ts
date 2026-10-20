import { useEffect, useState } from 'react';

export type MotionPreference = 'system' | 'reduced' | 'full';

const STORAGE_KEY = 'aegis.motion';
const QUERY = '(prefers-reduced-motion: reduce)';

function readStored(): MotionPreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'reduced' || value === 'full' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** User motion preference (UI-only, non-sensitive, kept in localStorage) combined with the OS setting. */
export function useMotionPreference(): {
  preference: MotionPreference;
  setPreference: (value: MotionPreference) => void;
  reduced: boolean;
} {
  const [preference, setPreferenceState] = useState<MotionPreference>(readStored);
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = () => setSystemReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setPreference = (value: MotionPreference) => {
    setPreferenceState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable: preference lasts for this session only */
    }
  };

  const reduced = preference === 'reduced' || (preference === 'system' && systemReduced);
  return { preference, setPreference, reduced };
}
