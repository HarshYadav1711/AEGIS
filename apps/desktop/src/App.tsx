import { useEffect, useRef, useState } from 'react';

import { Composer } from './components/Composer/Composer';
import { Diagnostics } from './components/Diagnostics/Diagnostics';
import { Orb } from './components/Orb/Orb';
import { StatePreview } from './components/StatePreview/StatePreview';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useMotionPreference, type MotionPreference } from './hooks/useMotionPreference';
import { ORB_LABELS, orbStateFromBackend, type OrbState } from './orb/orbModel';
import type { AppInfo } from './shared/contracts';

export function App() {
  const { status, restarting, restart } = useBackendStatus();
  const motion = useMotionPreference();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [preview, setPreview] = useState<OrbState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.aegis?.getAppInfo().then(setAppInfo, () => setAppInfo(null));
  }, []);

  const liveState = orbStateFromBackend(status);
  const orbState = preview ?? liveState;
  const canReconnect = status !== null && (status.state === 'offline' || status.state === 'error') && !!window.aegis;
  const statusText = preview
    ? `Preview: ${ORB_LABELS[preview]} (simulated). Live state is ${ORB_LABELS[liveState]}.`
    : `${ORB_LABELS[liveState]} — ${status?.detail ?? 'Waiting for the desktop app to report backend status…'}`;

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="topbar__title">AEGIS</h1>
        <span className="status-pill" data-state={status?.state ?? 'starting'}>
          <span className="status-pill__dot" aria-hidden="true" />
          Core: {status?.state ?? 'starting'}
        </span>
      </header>

      <main className="stage">
        <Orb
          state={orbState}
          reducedMotion={motion.reduced}
          isPreview={preview !== null}
          onActivate={() => composerRef.current?.focus()}
          describedBy="orb-status"
        />
        <p id="orb-status" className="stage__status" role="status" aria-live="polite">
          {statusText}
        </p>
        {canReconnect && (
          <button type="button" className="button" onClick={restart} disabled={restarting}>
            {restarting ? 'Reconnecting…' : 'Restart core'}
          </button>
        )}
        <Composer ref={composerRef} chatAvailable={status?.health?.capabilities.chat === true} />
      </main>

      <footer className="drawer">
        <Diagnostics status={status} appInfo={appInfo} />
        <details className="panel">
          <summary>Display</summary>
          <div className="preview-controls">
            <label htmlFor="motion-pref">Motion</label>
            <select
              id="motion-pref"
              value={motion.preference}
              onChange={(event) => motion.setPreference(event.target.value as MotionPreference)}
            >
              <option value="system">Follow system setting</option>
              <option value="reduced">Reduced (static orb)</option>
              <option value="full">Full animation</option>
            </select>
          </div>
        </details>
        {appInfo?.isDevelopment && <StatePreview value={preview} onChange={setPreview} />}
      </footer>
    </div>
  );
}
