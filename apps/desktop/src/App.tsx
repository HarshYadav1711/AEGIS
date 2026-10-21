import { useEffect, useRef, useState } from 'react';

import { Composer } from './components/Composer/Composer';
import { ConversationList } from './components/ConversationList/ConversationList';
import { Diagnostics } from './components/Diagnostics/Diagnostics';
import { FileTaskHistory } from './components/FileTask/FileTaskHistory';
import { FileTaskPanel } from './components/FileTask/FileTaskPanel';
import { MemoryPanel } from './components/Memory/MemoryPanel';
import { Orb } from './components/Orb/Orb';
import { ResearchHistory, ResearchPanel } from './components/Research/ResearchPanel';
import { StatePreview } from './components/StatePreview/StatePreview';
import { Transcript } from './components/Transcript/Transcript';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useChat } from './hooks/useChat';
import { useFileTasks } from './hooks/useFileTasks';
import { useMemory } from './hooks/useMemory';
import { useModelSelection } from './hooks/useModelSelection';
import { useResearchTasks } from './hooks/useResearchTasks';
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
  const research = useResearchTasks(coreOnline);
  // Re-read an open memory panel whenever a chat turn or task may have stored something.
  const memory = useMemory(coreOnline, chat.messages.length + tasks.history.length + research.history.length + (chat.busy ? 0 : 1));
  const availableModels = status?.health?.provider?.models ?? [];
  const [model, setModel] = useModelSelection(availableModels);
  const unavailableReason = chatUnavailableReason(status);
  const chatReady = unavailableReason === null;

  useEffect(() => {
    window.aegis?.getAppInfo().then(setAppInfo, () => setAppInfo(null));
  }, []);

  const taskActivity = research.activity !== 'none' ? research.activity : tasks.activity;
  const liveState = orbStateFor(status, chat.activity, chatReady, taskActivity);
  const researchStatus = research.detail?.task.status;
  const orbState = preview ?? liveState;
  const canReconnect = status !== null && (status.state === 'offline' || status.state === 'error') && !!window.aegis;

  let liveDetail: string;
  if (status?.state !== 'online') liveDetail = status?.detail ?? 'Waiting for the desktop app to report backend status…';
  else if (research.pending === 'planning') liveDetail = 'Checking the URLs and preparing a research plan.';
  else if (research.activity === 'waiting_approval' && researchStatus === 'awaiting_approval')
    liveDetail = 'Research plan ready. No page is read until you approve it.';
  else if (research.activity === 'waiting_approval') liveDetail = 'Report ready. Choose a folder to save it.';
  else if (research.activity === 'executing') liveDetail = 'Reading approved public pages in an isolated browser.';
  else if (research.activity === 'generating') liveDetail = `${research.detail?.task.model ?? 'The model'} is writing findings from the retrieved text.`;
  else if (research.activity === 'succeeded') liveDetail = 'Research report saved and verified on disk.';
  else if (research.activity === 'failed') liveDetail = research.detail?.task.errorDetail ?? 'The research task failed.';
  else if (research.activity === 'cancelled') liveDetail = 'The research task was stopped or rejected.';
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

        <main className="stage" data-has-messages={chat.messages.length > 0 || tasks.detail !== null || research.detail !== null || research.refusal !== null || undefined}>
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
          {(chat.messages.length > 0 || chat.loadingConversation || (!tasks.detail && !research.detail && !research.refusal)) && (
            <Transcript messages={chat.messages} loading={chat.loadingConversation} busy={chat.busy} />
          )}
          <FileTaskPanel tasks={tasks} />
          <ResearchPanel research={research} />
          <Composer
            ref={composerRef}
            unavailableReason={unavailableReason}
            models={availableModels}
            model={model}
            onModelChange={setModel}
            busy={chat.busy || tasks.busy || research.busy}
            canCancel={chat.canCancel}
            pausedReason={
              research.pending === 'planning'
                ? 'Checking the URLs and preparing a research plan…'
                : research.busy
                  ? 'Finish, reject or stop the research task above to send another message.'
                  : tasks.pending === 'interpreting'
                ? 'Checking whether this is a file task…'
                : tasks.busy
                  ? 'Finish, reject or cancel the file task above to send another message.'
                  : null
            }
            error={chat.error}
            onSend={async (content, selected) => {
              // A message with URLs (or starting "research") becomes a research task; a file-organization
              // request becomes a file task; anything else is an ordinary chat turn.
              const researched = await research.start(content, selected);
              if (researched === 'task' || researched === 'handled') {
                tasks.dismiss();
                return true;
              }
              if (researched === 'error') return false;
              const routed = await tasks.start(content, selected);
              if (routed === 'task') {
                research.dismiss();
                return true;
              }
              if (routed === 'error') return false;
              return chat.send(content, selected);
            }}
            onCancel={chat.cancel}
          />
        </main>
      </div>

      <footer className="drawer">
        <Diagnostics status={status} appInfo={appInfo} />
        <FileTaskHistory tasks={tasks.history} disabled={tasks.busy || research.busy} onOpen={tasks.open} />
        <ResearchHistory tasks={research.history} disabled={tasks.busy || research.busy} onOpen={research.open} />
        <MemoryPanel state={memory} disabled={!coreOnline} />
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
