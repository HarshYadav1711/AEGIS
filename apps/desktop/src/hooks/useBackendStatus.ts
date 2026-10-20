import { useCallback, useEffect, useState } from 'react';

import { isBackendStatus, type BackendStatus } from '../shared/contracts';

const BRIDGE_MISSING: BackendStatus = {
  state: 'error',
  detail: 'Desktop bridge unavailable: this page must run inside the AEGIS app.',
  checkedAt: null,
  health: null,
};

/** Live backend status pushed from Electron main. Returns null until the first report. */
export function useBackendStatus(): {
  status: BackendStatus | null;
  restarting: boolean;
  restart: () => void;
} {
  const [status, setStatus] = useState<BackendStatus | null>(window.aegis ? null : BRIDGE_MISSING);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const bridge = window.aegis;
    if (!bridge) return;
    let active = true;
    const accept = (value: unknown) => {
      if (active && isBackendStatus(value)) setStatus(value);
    };
    const unsubscribe = bridge.onBackendStatus(accept);
    bridge.getBackendStatus().then(accept, () => {
      if (active) setStatus({ ...BRIDGE_MISSING, detail: 'Could not read backend status from the app.' });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const restart = useCallback(() => {
    const bridge = window.aegis;
    if (!bridge) return;
    setRestarting(true);
    bridge
      .restartBackend()
      .then((value) => isBackendStatus(value) && setStatus(value))
      .catch(() => undefined)
      .finally(() => setRestarting(false));
  }, []);

  return { status, restarting, restart };
}
