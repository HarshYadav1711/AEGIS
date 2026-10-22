import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatActivity } from '../orb/orbModel';
import {
  isChatProgressEvent,
  type ChatError,
  type ChatMessageRecord,
  type ChatProgressEvent,
  type ConversationSummary,
  type InputMode,
} from '../shared/contracts';

/** How long a finished state (Done / Cancelled) stays on the orb before it settles to Ready. */
const SETTLE_MS = 2_500;

interface InFlight {
  requestId: string;
  conversationId: string;
  assistantId: string | null;
}

export interface ChatState {
  conversations: ConversationSummary[];
  activeId: string | null;
  messages: ChatMessageRecord[];
  activity: ChatActivity;
  /** Latest request-level problem (not tied to a stored message), shown near the composer. */
  error: ChatError | null;
  busy: boolean;
  canCancel: boolean;
  loadingConversation: boolean;
  newConversation: () => void;
  openConversation: (id: string) => void;
  /** `onReply` receives the completed reply (used to read a spoken request's answer aloud). */
  send: (
    content: string,
    model: string,
    inputMode?: InputMode,
    onReply?: (reply: ChatMessageRecord) => void,
  ) => Promise<boolean>;
  cancel: () => void;
}

/** Conversation state driven only by real responses from Electron main (and through it, the core). */
export function useChat(coreOnline: boolean): ChatState {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [activity, setActivity] = useState<ChatActivity>('none');
  const [error, setError] = useState<ChatError | null>(null);
  const [inFlight, setInFlight] = useState<InFlight | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const inFlightRef = useRef<InFlight | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const settleTimer = useRef<number | null>(null);

  const setFlight = (value: InFlight | null) => {
    inFlightRef.current = value;
    setInFlight(value);
  };

  const settleLater = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setActivity('none'), SETTLE_MS);
  }, []);

  const startActivity = (next: ChatActivity) => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    setActivity(next);
  };

  const refreshList = useCallback(async () => {
    const result = await window.aegis?.listConversations();
    // A failed refresh keeps the last known list; it must not mask a more specific request error.
    if (result?.ok) setConversations(result.value);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const bridge = window.aegis;
    if (!bridge) return;
    setLoadingConversation(true);
    const result = await bridge.getConversation(id);
    setLoadingConversation(false);
    if (activeIdRef.current !== id) return;
    if (result.ok) setMessages(result.value.messages);
    else setError(result.error);
  }, []);

  // (Re)load whenever the core comes online, e.g. after a restart: stored state may have changed
  // (the core marks replies interrupted by a crash as failed).
  useEffect(() => {
    if (!coreOnline) return;
    // Deferred out of the effect body; also coalesces quick status flaps.
    const timer = window.setTimeout(() => {
      void refreshList();
      if (activeIdRef.current && !inFlightRef.current) void loadConversation(activeIdRef.current);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [coreOnline, refreshList, loadConversation]);

  useEffect(() => {
    const bridge = window.aegis;
    if (!bridge) return;
    return bridge.onChatEvent((value: unknown) => {
      if (!isChatProgressEvent(value)) return;
      const event: ChatProgressEvent = value;
      const flight = inFlightRef.current;
      if (!flight || flight.requestId !== event.requestId) return;
      if (event.type === 'accepted') {
        setFlight({ ...flight, assistantId: event.assistantMessage.id });
        if (activeIdRef.current === flight.conversationId) {
          setMessages((list) => [...list, event.userMessage, event.assistantMessage]);
        }
      } else if (event.type === 'streaming') {
        setActivity('responding');
      } else {
        setMessages((list) =>
          list.map((m) =>
            m.id === event.messageId ? { ...m, status: 'streaming', content: m.content + event.text } : m,
          ),
        );
      }
    });
  }, []);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const replaceMessage = (record: ChatMessageRecord) =>
    setMessages((list) => list.map((m) => (m.id === record.id ? record : m)));

  const send = useCallback(
    async (
      content: string,
      model: string,
      inputMode: InputMode = 'text',
      onReply?: (reply: ChatMessageRecord) => void,
    ): Promise<boolean> => {
      const bridge = window.aegis;
      if (!bridge || inFlightRef.current) return false;
      setError(null);
      let conversationId = activeIdRef.current;
      if (!conversationId) {
        const created = await bridge.createConversation();
        if (!created.ok) {
          setError(created.error);
          return false;
        }
        conversationId = created.value.id;
        activeIdRef.current = conversationId;
        setActiveId(conversationId);
        setMessages([]);
      }

      const requestId = crypto.randomUUID();
      setFlight({ requestId, conversationId, assistantId: null });
      startActivity('thinking');
      const outcome = await bridge.sendMessage({ conversationId, requestId, content, model, inputMode });
      // Updated by the 'accepted' event handler while the send was awaited.
      const assistantId = (inFlightRef.current as InFlight | null)?.assistantId ?? null;
      setFlight(null);

      switch (outcome.type) {
        case 'complete':
          replaceMessage(outcome.message);
          setActivity('succeeded');
          settleLater();
          onReply?.(outcome.message);
          break;
        case 'cancelled':
          replaceMessage(outcome.message);
          setActivity('cancelled');
          settleLater();
          break;
        case 'failed':
          replaceMessage(outcome.message);
          setActivity('failed');
          break;
        case 'rejected':
          setError(outcome.error);
          setActivity('failed');
          break;
        case 'disconnected': {
          // Never show a partial stream as finished: mark it failed locally until the core reports
          // what it stored (it records such replies as failed/interrupted).
          const id = outcome.messageId ?? assistantId;
          setMessages((list) =>
            list.map((m) =>
              m.id === id
                ? { ...m, status: 'failed', errorCode: outcome.error.code, errorDetail: outcome.error.detail }
                : m,
            ),
          );
          setError(outcome.error);
          setActivity('failed');
          break;
        }
      }
      void refreshList();
      return outcome.type !== 'rejected';
    },
    [refreshList, settleLater],
  );

  const cancel = useCallback(() => {
    const id = inFlightRef.current?.assistantId;
    if (!id) return;
    void window.aegis?.cancelGeneration(id).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      if (inFlightRef.current) return;
      activeIdRef.current = id;
      setActiveId(id);
      setMessages([]);
      setError(null);
      startActivity('none');
      void loadConversation(id);
    },
    [loadConversation],
  );

  const newConversation = useCallback(() => {
    if (inFlightRef.current) return;
    // Created lazily on first send so empty conversations do not pile up.
    activeIdRef.current = null;
    setActiveId(null);
    setMessages([]);
    setError(null);
    startActivity('none');
  }, []);

  return {
    conversations,
    activeId,
    messages,
    activity,
    error,
    busy: inFlight !== null,
    canCancel: inFlight?.assistantId != null,
    loadingConversation,
    newConversation,
    openConversation,
    send,
    cancel,
  };
}
