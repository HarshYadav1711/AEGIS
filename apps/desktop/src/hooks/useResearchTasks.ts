import { useCallback, useEffect, useRef, useState } from 'react';

import type { TaskActivity } from '../orb/orbModel';
import {
  TERMINAL_RESEARCH_STATUSES,
  type ChatError,
  type ChatResult,
  type RefusedSource,
  type ResearchTaskDetail,
  type ResearchTaskStatus,
  type ResearchTaskSummary,
} from '../shared/contracts';

/** While reading or generating, the journal is re-read at this interval; every status shown comes from it. */
const POLL_MS = 500;
const SETTLE_MS = 4_000;

type Pending = 'planning' | 'deciding' | 'saving' | 'opening';

/** 'handled': a research request that produced no task (e.g. every URL refused); nothing goes to chat. */
export type ResearchStartOutcome = 'task' | 'handled' | 'not_a_task' | 'error';

export interface ResearchTasksState {
  detail: ResearchTaskDetail | null;
  /** Shown when a research request produced no task (all sources refused). */
  refusal: { detail: string; refused: RefusedSource[] } | null;
  pending: Pending | null;
  error: ChatError | null;
  notice: string | null;
  history: ResearchTaskSummary[];
  activity: TaskActivity;
  busy: boolean;
  start: (text: string, model: string) => Promise<ResearchStartOutcome>;
  approve: () => void;
  reject: () => void;
  cancel: () => void;
  save: () => void;
  openReport: () => void;
  open: (taskId: string) => void;
  dismiss: () => void;
}

export function isResearchTerminal(status: ResearchTaskStatus): boolean {
  return (TERMINAL_RESEARCH_STATUSES as readonly string[]).includes(status);
}

function activityFor(detail: ResearchTaskDetail | null, pending: Pending | null, settled: boolean): TaskActivity {
  if (pending === 'planning') return 'planning';
  if (!detail) return 'none';
  switch (detail.task.status) {
    case 'awaiting_approval':
    case 'awaiting_save':
      return settled && detail.task.status === 'awaiting_save' ? 'none' : 'waiting_approval';
    case 'researching':
      return 'executing';
    case 'generating':
      return 'generating';
    case 'completed':
      return settled ? 'none' : 'succeeded';
    case 'failed':
      return settled ? 'none' : 'failed';
    case 'cancelled':
    case 'rejected':
      return settled ? 'none' : 'cancelled';
  }
}

/** Research task state, driven only by responses from Electron main and the core's journal. */
export function useResearchTasks(coreOnline: boolean): ResearchTasksState {
  const [detail, setDetail] = useState<ResearchTaskDetail | null>(null);
  const [refusal, setRefusal] = useState<ResearchTasksState['refusal']>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<ResearchTaskSummary[]>([]);
  const [settled, setSettled] = useState(false);
  const detailRef = useRef<ResearchTaskDetail | null>(null);

  const show = useCallback((next: ResearchTaskDetail | null) => {
    detailRef.current = next;
    setDetail(next);
    setSettled(false);
  }, []);

  const refreshHistory = useCallback(async () => {
    const result = await window.aegis?.listResearchTasks();
    if (result?.ok) setHistory(result.value);
  }, []);

  useEffect(() => {
    if (!coreOnline) return;
    const timer = window.setTimeout(() => void refreshHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [coreOnline, refreshHistory]);

  const status = detail?.task.status ?? null;
  const taskId = detail?.task.id ?? null;

  useEffect(() => {
    if ((status !== 'researching' && status !== 'generating') || !taskId) return;
    const timer = window.setInterval(() => {
      void window.aegis?.getResearchTask(taskId).then((result) => {
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (detailRef.current?.task.id !== taskId) return;
        detailRef.current = result.value;
        setDetail(result.value);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, taskId]);

  useEffect(() => {
    if (!status || (!isResearchTerminal(status) && status !== 'awaiting_save')) return;
    const refresh = window.setTimeout(() => void refreshHistory(), 0);
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => {
      window.clearTimeout(refresh);
      window.clearTimeout(timer);
    };
  }, [status, refreshHistory]);

  const run = useCallback(
    async (kind: Pending, call: (id: string) => Promise<ChatResult<ResearchTaskDetail | null>> | undefined) => {
      const current = detailRef.current;
      if (!current) return;
      setPending(kind);
      setError(null);
      setNotice(null);
      const result = await call(current.task.id);
      setPending(null);
      if (!result) return;
      if (!result.ok) {
        setError(result.error);
        const fresh = await window.aegis?.getResearchTask(current.task.id);
        if (fresh?.ok) show(fresh.value);
        return;
      }
      if (result.value === null) {
        setNotice('No folder was chosen. Nothing was written.');
        return;
      }
      show(result.value);
    },
    [show],
  );

  const start = useCallback(
    async (text: string, model: string): Promise<ResearchStartOutcome> => {
      const bridge = window.aegis;
      if (!bridge) return 'error';
      setError(null);
      setNotice(null);
      setRefusal(null);
      setPending('planning');
      const result = await bridge.interpretResearchRequest({ text, model });
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return 'error';
      }
      if (result.value.intent === 'none') return 'not_a_task';
      if (!result.value.task) {
        show(null);
        setRefusal({ detail: result.value.detail, refused: result.value.refused });
        return 'handled';
      }
      show(result.value.task);
      void refreshHistory();
      return 'task';
    },
    [show, refreshHistory],
  );

  const approve = useCallback(() => void run('deciding', (id) => window.aegis?.approveResearchPlan(id)), [run]);
  const reject = useCallback(() => void run('deciding', (id) => window.aegis?.rejectResearchPlan(id)), [run]);
  const cancel = useCallback(() => void run('deciding', (id) => window.aegis?.cancelResearchTask(id)), [run]);
  const save = useCallback(() => void run('saving', (id) => window.aegis?.saveResearchReport(id)), [run]);

  const openReport = useCallback(() => {
    const current = detailRef.current;
    if (!current) return;
    setPending('opening');
    setError(null);
    void window.aegis?.openResearchReport(current.task.id).then((result) => {
      setPending(null);
      if (!result.ok) setError(result.error);
    });
  }, []);

  const open = useCallback(
    (id: string) => {
      setRefusal(null);
      void window.aegis?.getResearchTask(id).then((result) => {
        if (result.ok) show(result.value);
        else setError(result.error);
      });
    },
    [show],
  );

  const dismiss = useCallback(() => {
    const current = detailRef.current;
    if (current && !isResearchTerminal(current.task.status) && current.task.status !== 'awaiting_save') return;
    show(null);
    setRefusal(null);
    setError(null);
    setNotice(null);
  }, [show]);

  const inProgress = detail !== null && !isResearchTerminal(detail.task.status) && detail.task.status !== 'awaiting_save';
  return {
    detail,
    refusal,
    pending,
    error,
    notice,
    history,
    activity: activityFor(detail, pending, settled),
    busy: (pending !== null && pending !== 'opening') || inProgress,
    start,
    approve,
    reject,
    cancel,
    save,
    openReport,
    open,
    dismiss,
  };
}
