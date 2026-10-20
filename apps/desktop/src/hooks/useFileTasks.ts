import { useCallback, useEffect, useRef, useState } from 'react';

import type { TaskActivity } from '../orb/orbModel';
import {
  isFileTaskProgressEvent,
  TERMINAL_FILE_TASK_STATUSES,
  type ChatError,
  type ChatResult,
  type FileTaskDetail,
  type FileTaskRecord,
  type FileTaskStatus,
} from '../shared/contracts';

/** While executing, the journal is re-read at this interval; every number shown comes from it. */
const POLL_MS = 400;
/** How long a finished task's state stays on the orb before it settles (the panel keeps the result). */
const SETTLE_MS = 4_000;

type Pending = 'interpreting' | 'choosing' | 'planning' | 'deciding';

export type StartOutcome = 'task' | 'not_a_task' | 'error';

export interface FileTasksState {
  detail: FileTaskDetail | null;
  pending: Pending | null;
  error: ChatError | null;
  notice: string | null;
  history: FileTaskRecord[];
  activity: TaskActivity;
  /** True while a task occupies the stage and the composer should not start another one. */
  busy: boolean;
  start: (text: string, model: string | null) => Promise<StartOutcome>;
  chooseFolder: () => void;
  approve: () => void;
  reject: () => void;
  cancel: () => void;
  replan: () => void;
  open: (taskId: string) => void;
  dismiss: () => void;
}

export function isTerminal(status: FileTaskStatus): boolean {
  return (TERMINAL_FILE_TASK_STATUSES as readonly string[]).includes(status);
}

function activityFor(detail: FileTaskDetail | null, pending: Pending | null, settled: boolean): TaskActivity {
  if (pending === 'interpreting') return 'interpreting';
  if (pending === 'choosing') return 'waiting_folder';
  if (pending === 'planning') return 'planning';
  if (!detail) return 'none';
  switch (detail.task.status) {
    case 'awaiting_folder':
      return 'waiting_folder';
    case 'planning':
      return 'planning';
    case 'awaiting_approval':
      return 'waiting_approval';
    case 'executing':
      return 'executing';
    case 'completed':
      return settled ? 'none' : 'succeeded';
    case 'partial':
    case 'failed':
    case 'unknown':
      return settled ? 'none' : 'failed';
    case 'cancelled':
    case 'rejected':
      return settled ? 'none' : 'cancelled';
  }
}

/** File-organization task state, driven only by responses from Electron main and the core's journal. */
export function useFileTasks(coreOnline: boolean): FileTasksState {
  const [detail, setDetail] = useState<FileTaskDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<FileTaskRecord[]>([]);
  const [settled, setSettled] = useState(false);
  const detailRef = useRef<FileTaskDetail | null>(null);

  const show = useCallback((next: FileTaskDetail | null) => {
    detailRef.current = next;
    setDetail(next);
    setSettled(false);
  }, []);

  const refreshHistory = useCallback(async () => {
    const result = await window.aegis?.listFileTasks();
    if (result?.ok) setHistory(result.value);
  }, []);

  useEffect(() => {
    if (!coreOnline) return;
    const timer = window.setTimeout(() => void refreshHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [coreOnline, refreshHistory]);

  useEffect(() => {
    const bridge = window.aegis;
    if (!bridge) return;
    return bridge.onFileTaskEvent((value: unknown) => {
      if (isFileTaskProgressEvent(value) && value.taskId === detailRef.current?.task.id) setPending('planning');
    });
  }, []);

  const status = detail?.task.status ?? null;
  const taskId = detail?.task.id ?? null;

  // Follow an executing task through the journal until it reaches a terminal state.
  useEffect(() => {
    if (status !== 'executing' || !taskId) return;
    const timer = window.setInterval(() => {
      void window.aegis?.getFileTask(taskId).then((result) => {
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
    if (!status || !isTerminal(status)) return;
    const refresh = window.setTimeout(() => void refreshHistory(), 0);
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => {
      window.clearTimeout(refresh);
      window.clearTimeout(timer);
    };
  }, [status, refreshHistory]);

  /** Run one bridge call for the current task, showing its result or its error. */
  const run = useCallback(
    async (kind: Pending, call: (id: string) => Promise<ChatResult<FileTaskDetail | null>> | undefined) => {
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
        // Re-read: the journal is the truth about what state the task is in now.
        const fresh = await window.aegis?.getFileTask(current.task.id);
        if (fresh?.ok) show(fresh.value);
        return;
      }
      if (result.value === null) {
        setNotice('No folder was chosen. Nothing was read or changed.');
        return;
      }
      show(result.value);
    },
    [show],
  );

  const start = useCallback(
    async (text: string, model: string | null): Promise<StartOutcome> => {
      const bridge = window.aegis;
      if (!bridge) return 'error';
      setError(null);
      setNotice(null);
      setPending('interpreting');
      const result = await bridge.interpretFileRequest({ text, model });
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return 'error';
      }
      if (!result.value.task) return 'not_a_task';
      show(result.value.task);
      void refreshHistory();
      return 'task';
    },
    [show, refreshHistory],
  );

  const chooseFolder = useCallback(() => {
    void run('choosing', (id) => window.aegis?.chooseFolderForTask(id));
  }, [run]);

  const approve = useCallback(() => {
    const planId = detailRef.current?.plan?.id;
    if (!planId) return;
    void run('deciding', (taskId) => window.aegis?.approveFilePlan({ taskId, planId }));
  }, [run]);

  const reject = useCallback(() => {
    const planId = detailRef.current?.plan?.id;
    if (!planId) return;
    void run('deciding', (taskId) => window.aegis?.rejectFilePlan({ taskId, planId }));
  }, [run]);

  const cancel = useCallback(() => {
    void run('deciding', (id) => window.aegis?.cancelFileTask(id));
  }, [run]);

  const replan = useCallback(() => {
    void run('planning', (id) => window.aegis?.replanFileTask(id));
  }, [run]);

  const open = useCallback(
    (id: string) => {
      void window.aegis?.getFileTask(id).then((result) => {
        if (result.ok) show(result.value);
        else setError(result.error);
      });
    },
    [show],
  );

  const dismiss = useCallback(() => {
    if (detailRef.current && !isTerminal(detailRef.current.task.status)) return;
    show(null);
    setError(null);
    setNotice(null);
  }, [show]);

  const busy = pending !== null || (detail !== null && !isTerminal(detail.task.status));

  return {
    detail,
    pending,
    error,
    notice,
    history,
    activity: activityFor(detail, pending, settled),
    busy,
    start,
    chooseFolder,
    approve,
    reject,
    cancel,
    replan,
    open,
    dismiss,
  };
}
