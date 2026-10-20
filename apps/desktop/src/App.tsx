import { useEffect, useRef, useState } from 'react';

import { Composer } from './components/Composer/Composer';
import { ConversationList } from './components/ConversationList/ConversationList';
import { Diagnostics } from './components/Diagnostics/Diagnostics';
import { Orb } from './components/Orb/Orb';
import { StatePreview } from './components/StatePreview/StatePreview';
import { Transcript } from './components/Transcript/Transcript';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useChat } from './hooks/useChat';
import { useModelSelection } from './hooks/useModelSelection';
import { useMotionPreference, type MotionPreference } from './hooks/useMotionPreference';
import { ORB_LABELS, orbStateFor, type OrbState } from './orb/orbModel';
import type { AppInfo, BackendStatus } from './shared/contracts';

/** Why a prompt cannot be sent right now, in the user's terms; null when a model is ready. */
function chatUnavailableReason(status: BackendStatus | null): string | null {
  if (!status || status.state === 'starting') return 'Waiting for the local core to start…';
  if (status.state !== 'online') return `The local core is unavailable: ${status.detail}`;
  const provider = status.health?.provider;
  if (!provider) return 'The core has not reported a model provider yet.';
  if (!provider.reachable) return `No model available — ${provider.detail}`;
  if (provider.models.length === 0) return `No model available — ${provider.detail} Install one with "ollama pull <model>".`;
  return null;
}

export function App() {
  const { status, restarting, restart } = useBackendStatus();
  const motion = useMotionPreference();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [preview, setPreview] = useState<OrbState | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const coreOnline = status?.state === 'online';
  const chat = useChat(coreOnline);
  const availableModels = status?.health?.provider?.models ?? [];
  const [model, setModel] = useModelSelection(availableModels);
  const unavailableReason = chatUnavailableReason(status);
  const chatReady = unavailableReason === null;

  useEffect(() => {
    window.aegis?.getAppInfo().then(setAppInfo, () => setAppInfo(null));
  }, []);

  const liveState = orbStateFor(status, chat.activity, chatReady);
  const orbState = preview ?? liveState;
  const canReconnect = status !== null && (status.state === 'offline' || status.state === 'error') && !!window.aegis;

  let liveDetail: string;
  if (status?.state !== 'online') liveDetail = status?.detail ?? 'Waiting for the desktop app to report backend status…';
  else if (chat.activity === 'thinking') liveDetail = `Waiting for ${model ?? 'the model'} to respond.`;
  else if (chat.activity === 'responding') liveDetail = `${model ?? 'The model'} is writing a reply.`;
  else if (chat.activity === 'succeeded') liveDetail = 'Reply complete and saved.';
  else if (chat.activity === 'cancelled') liveDetail = 'Stopped. The partial reply is saved and marked as stopped.';
  else if (chat.activity === 'failed') liveDetail = chat.error?.detail ?? 'The last request failed. See the message for details.';
  else liveDetail = unavailableReason ?? `Model ready: ${model ?? ''} via ${status.health?.provider?.id ?? 'local provider'}.`;

  const statusText = preview
    ? `Preview: ${ORB_LABELS[preview]} (simulated). Live state is ${ORB_LABELS[liveState]}.`
    : `${ORB_LABELS[liveState]} — ${liveDetail}`;

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="topbar__title">AEGIS</h1>
        <span className="status-pill" data-state={status?.state ?? 'starting'}>
          <span className="status-pill__dot" aria-hidden="true" />
          Core: {status?.state ?? 'starting'}
        </span>
      </header>

      <div className="workspace">
        <ConversationList
          conversations={chat.conversations}
          activeId={chat.activeId}
          disabled={chat.busy}
          onOpen={chat.openConversation}
          onNew={() => {
            chat.newConversation();
            composerRef.current?.focus();
          }}
        />

        <main className="stage" data-has-messages={chat.messages.length > 0 || undefined}>
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
          <Transcript messages={chat.messages} loading={chat.loadingConversation} busy={chat.busy} />
          <Composer
            ref={composerRef}
            unavailableReason={unavailableReason}
            models={availableModels}
            model={model}
            onModelChange={setModel}
            busy={chat.busy}
            canCancel={chat.canCancel}
            error={chat.error}
            onSend={chat.send}
            onCancel={chat.cancel}
          />
        </main>
      </div>

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
