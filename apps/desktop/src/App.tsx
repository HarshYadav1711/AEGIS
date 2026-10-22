import { useCallback, useEffect, useRef, useState } from 'react';

import { Composer } from './components/Composer/Composer';
import { ConversationList } from './components/ConversationList/ConversationList';
import { Diagnostics } from './components/Diagnostics/Diagnostics';
import { FileTaskHistory } from './components/FileTask/FileTaskHistory';
import { FileTaskPanel } from './components/FileTask/FileTaskPanel';
import { MemoryPanel } from './components/Memory/MemoryPanel';
import { VaultPanel } from './components/Vault/VaultPanel';
import { Orb } from './components/Orb/Orb';
import { RepoHistory, RepoPanel } from './components/Repo/RepoPanel';
import { ResearchHistory, ResearchPanel } from './components/Research/ResearchPanel';
import { StatePreview } from './components/StatePreview/StatePreview';
import { Transcript } from './components/Transcript/Transcript';
import { VoicePanel } from './components/Voice/VoicePanel';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useChat } from './hooks/useChat';
import { useFileTasks } from './hooks/useFileTasks';
import { useMemory } from './hooks/useMemory';
import { useVault } from './hooks/useVault';
import { useModelSelection } from './hooks/useModelSelection';
import { useRepoTasks } from './hooks/useRepoTasks';
import { useResearchTasks } from './hooks/useResearchTasks';
import { useMotionPreference, type MotionPreference } from './hooks/useMotionPreference';
import { useVoice } from './hooks/useVoice';
import { ORB_LABELS, orbStateFor, type OrbState } from './orb/orbModel';
import type { AppInfo, BackendStatus, ChatMessageRecord, InputMode } from './shared/contracts';

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
  const repo = useRepoTasks(coreOnline);
  // Re-read an open memory panel whenever a chat turn or task may have stored something.
  const vault = useVault(coreOnline);
  const [voiceMemoryChanges, setVoiceMemoryChanges] = useState(0);
  const memory = useMemory(coreOnline, chat.messages.length + tasks.history.length + research.history.length + repo.history.length + (repo.detail?.events.length ?? 0) + (chat.busy ? 0 : 1) + voiceMemoryChanges);
  const availableModels = status?.health?.provider?.models ?? [];
  const [model, setModel] = useModelSelection(availableModels);
  const unavailableReason = chatUnavailableReason(status);
  const chatReady = unavailableReason === null;

  useEffect(() => {
    window.aegis?.getAppInfo().then(setAppInfo, () => setAppInfo(null));
  }, []);

  const busy = chat.busy || tasks.busy || research.busy || repo.busy;
  const pausedReason =
    repo.pending === 'routing'
      ? 'Checking whether this is a repository investigation…'
      : repo.busy
        ? 'Finish, reject or cancel the repository investigation above to send another message.'
        : research.pending === 'planning'
          ? 'Checking the URLs and preparing a research plan…'
          : research.busy
            ? 'Finish, reject or stop the research task above to send another message.'
            : tasks.pending === 'interpreting'
              ? 'Checking whether this is a file task…'
              : tasks.busy
                ? 'Finish, reject or cancel the file task above to send another message.'
                : null;

  // Typed and spoken text take exactly the same route: a request to analyse a repository (no URLs) becomes a
  // read-only repository task; a message with URLs (or starting "research") becomes a research task; a
  // file-organization request becomes a file task; anything else is an ordinary chat turn. Every task still
  // waits for its own approval click; the input mode is provenance only.
  const route = async (
    content: string,
    selected: string,
    inputMode: InputMode,
    onReply?: (reply: ChatMessageRecord) => void,
  ): Promise<boolean> => {
    const inspected = await repo.start(content, selected);
    if (inspected === 'task') {
      research.dismiss();
      tasks.dismiss();
      return true;
    }
    if (inspected === 'error') return false;
    const researched = await research.start(content, selected);
    if (researched === 'task' || researched === 'handled') {
      tasks.dismiss();
      repo.dismiss();
      return true;
    }
    if (researched === 'error') return false;
    const routed = await tasks.start(content, selected);
    if (routed === 'task') {
      research.dismiss();
      repo.dismiss();
      return true;
    }
    if (routed === 'error') return false;
    return chat.send(content, selected, inputMode, onReply);
  };
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  });

  const speakRef = useRef<(text: string) => void>(() => undefined);
  const voiceBlocked =
    unavailableReason ??
    (busy ? (pausedReason ?? 'Wait for the current reply to finish.') : model === null ? 'Choose a model first.' : null);
  const submitVoice = useCallback(
    async (text: string) =>
      model !== null && voiceBlocked === null
        ? routeRef.current(text, model, 'voice', (reply) => speakRef.current(reply.content))
        : false,
    [model, voiceBlocked],
  );
  const voiceMemoryChanged = useCallback(() => setVoiceMemoryChanges((n) => n + 1), []);
  const voice = useVoice({
    coreOnline,
    blockedReason: voiceBlocked,
    conversationId: chat.activeId,
    submit: submitVoice,
    onMemoryChanged: voiceMemoryChanged,
  });
  useEffect(() => {
    speakRef.current = (text) => voice.speak(text, 'reply');
  });

  const taskActivity =
    repo.activity !== 'none' ? repo.activity : research.activity !== 'none' ? research.activity : tasks.activity;
  const repoStatus = repo.detail?.task.status;
  const liveState = orbStateFor(status, chat.activity, chatReady, taskActivity, voice.activity);
  const researchStatus = research.detail?.task.status;
  const orbState = preview ?? liveState;
  const canReconnect = status !== null && (status.state === 'offline' || status.state === 'error') && !!window.aegis;

  let liveDetail: string;
  if (status?.state !== 'online') liveDetail = status?.detail ?? 'Waiting for the desktop app to report backend status…';
  else if (voice.phase === 'listening') liveDetail = 'Microphone on: capturing your voice until you press Stop.';
  else if (voice.phase === 'transcribing')
    liveDetail = `Transcribing the recording on this computer (${voice.status?.stt.engine ?? 'local engine'} ${voice.status?.stt.model ?? ''}).`;
  else if (voice.phase === 'interpreting') liveDetail = 'Checking what the transcript asks for (no model call).';
  else if (voice.phase === 'applying') liveDetail = 'Saving the reviewed memory correction as a new version.';
  else if (voice.phase === 'speaking') liveDetail = 'Speaking with the local Windows voice. Press Stop speaking to interrupt.';
  else if (repo.activity === 'interpreting') liveDetail = 'Checking whether this is a repository investigation.';
  else if (repo.activity === 'waiting_folder') liveDetail = 'Waiting for you to choose the repository (read-only).';
  else if (repo.activity === 'planning') liveDetail = 'Scanning the chosen repository read-only and preparing a plan.';
  else if (repo.activity === 'waiting_approval' && repoStatus === 'awaiting_approval')
    liveDetail = 'Investigation plan ready. Nothing goes to the model until you approve it.';
  else if (repo.activity === 'waiting_approval') liveDetail = 'Repository report ready. Choose a folder to save it.';
  else if (repo.activity === 'executing') liveDetail = 'Re-checking the planned excerpts, memories and notes.';
  else if (repo.activity === 'generating') liveDetail = `${repo.detail?.task.model ?? 'The model'} is analysing the repository excerpts.`;
  else if (repo.activity === 'succeeded') liveDetail = 'Repository report saved and verified; the repository was not modified.';
  else if (repo.activity === 'failed') liveDetail = repo.detail?.task.errorDetail ?? 'The repository investigation failed.';
  else if (repo.activity === 'cancelled') liveDetail = 'The repository investigation was stopped or rejected.';
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

        <main className="stage" data-has-messages={chat.messages.length > 0 || tasks.detail !== null || research.detail !== null || research.refusal !== null || repo.detail !== null || undefined}>
          <Orb
            state={orbState}
            reducedMotion={motion.reduced}
            isPreview={preview !== null}
            onActivate={() => composerRef.current?.focus()}
            describedBy="orb-status"
            level={voice.levelSource}
          />
          <p id="orb-status" className="stage__status" role="status" aria-live="polite">
            {statusText}
          </p>
          {canReconnect && (
            <button type="button" className="button" onClick={restart} disabled={restarting}>
              {restarting ? 'Reconnecting…' : 'Restart core'}
            </button>
          )}
          {(chat.messages.length > 0 || chat.loadingConversation || (!tasks.detail && !research.detail && !research.refusal && !repo.detail)) && (
            <Transcript messages={chat.messages} loading={chat.loadingConversation} busy={chat.busy} />
          )}
          <FileTaskPanel tasks={tasks} />
          <ResearchPanel research={research} />
          <RepoPanel key={repo.detail?.task.id ?? 'none'} repo={repo} />
          <VoicePanel voice={voice} blockedReason={voiceBlocked} reducedMotion={motion.reduced} />
          <Composer
            ref={composerRef}
            unavailableReason={unavailableReason}
            models={availableModels}
            model={model}
            onModelChange={setModel}
            busy={busy}
            canCancel={chat.canCancel}
            pausedReason={pausedReason}
            error={chat.error}
            onSend={(content, selected) => route(content, selected, 'text')}
            onCancel={() => {
              chat.cancel();
              voice.stopSpeaking();
            }}
          />
        </main>
      </div>

      <footer className="drawer">
        <Diagnostics status={status} appInfo={appInfo} />
        <FileTaskHistory tasks={tasks.history} disabled={tasks.busy || research.busy} onOpen={tasks.open} />
        <ResearchHistory tasks={research.history} disabled={tasks.busy || research.busy} onOpen={research.open} />
        <RepoHistory tasks={repo.history} disabled={tasks.busy || research.busy || repo.busy} onOpen={repo.open} />
        <MemoryPanel state={memory} disabled={!coreOnline} />
        <VaultPanel state={vault} disabled={!coreOnline} />
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
