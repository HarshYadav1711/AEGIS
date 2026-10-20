import { useEffect, useRef, useState } from 'react';

import { Composer } from './components/Composer/Composer';
import { ConversationList } from './components/ConversationList/ConversationList';
import { Diagnostics } from './components/Diagnostics/Diagnostics';
import { FileTaskHistory } from './components/FileTask/FileTaskHistory';
import { FileTaskPanel } from './components/FileTask/FileTaskPanel';
import { Orb } from './components/Orb/Orb';
import { StatePreview } from './components/StatePreview/StatePreview';
import { Transcript } from './components/Transcript/Transcript';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useChat } from './hooks/useChat';
import { useFileTasks } from './hooks/useFileTasks';
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
  const tasks = useFileTasks(coreOnline);
  const availableModels = status?.health?.provider?.models ?? [];
  const [model, setModel] = useModelSelection(availableModels);
  const unavailableReason = chatUnavailableReason(status);
  const chatReady = unavailableReason === null;

  useEffect(() => {
    window.aegis?.getAppInfo().then(setAppInfo, () => setAppInfo(null));
  }, []);

  const liveState = orbStateFor(status, chat.activity, chatReady, tasks.activity);
  const orbState = preview ?? liveState;
  const canReconnect = status !== null && (status.state === 'offline' || status.state === 'error') && !!window.aegis;

  let liveDetail: string;
  if (status?.state !== 'online') liveDetail = status?.detail ?? 'Waiting for the desktop app to report backend status…';
  else if (tasks.activity === 'interpreting') liveDetail = `Checking whether this is a file task (${model ?? 'keyword rules'}).`;
  else if (tasks.activity === 'waiting_folder') liveDetail = 'Waiting for you to choose a folder.';
  else if (tasks.activity === 'planning') liveDetail = 'Listing the chosen folder and preparing a plan.';
  else if (tasks.activity === 'waiting_approval') liveDetail = 'Plan ready. Nothing moves until you approve it.';
  else if (tasks.activity === 'executing') liveDetail = 'Moving approved files and verifying each one.';
  else if (tasks.activity === 'succeeded') liveDetail = 'File task complete; every move was verified on disk.';
  else if (tasks.activity === 'failed') liveDetail = 'The file task did not fully succeed. See the task for details.';
  else if (tasks.activity === 'cancelled') liveDetail = 'The file task was cancelled or rejected.';
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

        <main className="stage" data-has-messages={chat.messages.length > 0 || tasks.detail !== null || undefined}>
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
          {(chat.messages.length > 0 || chat.loadingConversation || !tasks.detail) && (
            <Transcript messages={chat.messages} loading={chat.loadingConversation} busy={chat.busy} />
          )}
          <FileTaskPanel tasks={tasks} />
          <Composer
            ref={composerRef}
            unavailableReason={unavailableReason}
            models={availableModels}
            model={model}
            onModelChange={setModel}
            busy={chat.busy || tasks.busy}
            canCancel={chat.canCancel}
            pausedReason={
              tasks.pending === 'interpreting'
                ? 'Checking whether this is a file task…'
                : tasks.busy
                  ? 'Finish, reject or cancel the file task above to send another message.'
                  : null
            }
            error={chat.error}
            onSend={async (content, selected) => {
              // A file-organization request becomes a task; anything else is an ordinary chat turn.
              const routed = await tasks.start(content, selected);
              if (routed === 'task') return true;
              if (routed === 'error') return false;
              return chat.send(content, selected);
            }}
            onCancel={chat.cancel}
          />
        </main>
      </div>

      <footer className="drawer">
        <Diagnostics status={status} appInfo={appInfo} />
        <FileTaskHistory tasks={tasks.history} disabled={tasks.busy} onOpen={tasks.open} />
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
