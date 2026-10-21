import { useCallback, useEffect, useRef, useState } from 'react';

import type { TaskActivity } from '../orb/orbModel';
import {
  TERMINAL_REPO_STATUSES,
  type ChatError,
  type ChatResult,
  type RepoTaskDetail,
  type RepoTaskStatus,
  type RepoTaskSummary,
} from '../shared/contracts';

/** While inspecting or generating, the journal is re-read at this interval; every status shown comes from it. */
const POLL_MS = 500;
const SETTLE_MS = 4_000;

type Pending = 'routing' | 'picking' | 'deciding' | 'saving' | 'opening' | 'proposing';

export type RepoStartOutcome = 'task' | 'not_a_task' | 'error';

export interface RepoTasksState {
  detail: RepoTaskDetail | null;
  pending: Pending | null;
  error: ChatError | null;
  notice: string | null;
  history: RepoTaskSummary[];
  activity: TaskActivity;
  busy: boolean;
  start: (text: string, model: string) => Promise<RepoStartOutcome>;
  chooseRepo: () => void;
  approve: (useVaultNotes: boolean) => void;
  reject: () => void;
  cancel: () => void;
  save: () => void;
  openReport: () => void;
  acceptProposal: (index: number) => void;
  open: (taskId: string) => void;
  dismiss: () => void;
}

export function isRepoTerminal(status: RepoTaskStatus): boolean {
  return (TERMINAL_REPO_STATUSES as readonly string[]).includes(status);
}

function activityFor(detail: RepoTaskDetail | null, pending: Pending | null, settled: boolean): TaskActivity {
  if (pending === 'routing') return 'interpreting';
  if (pending === 'picking' && detail?.task.status === 'awaiting_repo') return 'waiting_folder';
  if (!detail) return 'none';
  switch (detail.task.status) {
    case 'awaiting_repo':
      return 'waiting_folder';
    case 'awaiting_approval':
      return pending === 'picking' ? 'planning' : 'waiting_approval';
    case 'awaiting_save':
      return settled ? 'none' : 'waiting_approval';
    case 'inspecting':
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

/** Repository task state, driven only by responses from Electron main and the core's journal. */
export function useRepoTasks(coreOnline: boolean): RepoTasksState {
  const [detail, setDetail] = useState<RepoTaskDetail | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<RepoTaskSummary[]>([]);
  const [settled, setSettled] = useState(false);
  const detailRef = useRef<RepoTaskDetail | null>(null);

  const show = useCallback((next: RepoTaskDetail | null) => {
    detailRef.current = next;
    setDetail(next);
    setSettled(false);
  }, []);

  const refreshHistory = useCallback(async () => {
    const result = await window.aegis?.listRepoTasks();
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
    if ((status !== 'inspecting' && status !== 'generating') || !taskId) return;
    const timer = window.setInterval(() => {
      void window.aegis?.getRepoTask(taskId).then((result) => {
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
    if (!status || (!isRepoTerminal(status) && status !== 'awaiting_save')) return;
    const refresh = window.setTimeout(() => void refreshHistory(), 0);
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => {
      window.clearTimeout(refresh);
      window.clearTimeout(timer);
    };
  }, [status, refreshHistory]);

  const run = useCallback(
    async (kind: Pending, call: (id: string) => Promise<ChatResult<RepoTaskDetail | null>> | undefined) => {
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
        const fresh = await window.aegis?.getRepoTask(current.task.id);
        if (fresh?.ok) show(fresh.value);
        return;
      }
      if (result.value === null) {
        setNotice('No folder was chosen. Nothing was read or written.');
        return;
      }
      show(result.value);
    },
    [show],
  );

  const start = useCallback(
    async (text: string, model: string): Promise<RepoStartOutcome> => {
      const bridge = window.aegis;
      if (!bridge) return 'error';
      setError(null);
      setNotice(null);
      setPending('routing');
      const result = await bridge.interpretRepoRequest({ text, model });
      setPending(null);
      if (!result.ok) {
        setError(result.error);
        return 'error';
      }
      if (result.value.intent === 'none' || !result.value.task) return 'not_a_task';
      show(result.value.task);
      void refreshHistory();
      return 'task';
    },
    [show, refreshHistory],
  );

  const chooseRepo = useCallback(() => void run('picking', (id) => window.aegis?.chooseRepoForTask(id)), [run]);
  const approve = useCallback(
    (useVaultNotes: boolean) => void run('deciding', (id) => window.aegis?.approveRepoPlan({ taskId: id, useVaultNotes })),
    [run],
  );
  const reject = useCallback(() => void run('deciding', (id) => window.aegis?.rejectRepoPlan(id)), [run]);
  const cancel = useCallback(() => void run('deciding', (id) => window.aegis?.cancelRepoTask(id)), [run]);
  const save = useCallback(() => void run('saving', (id) => window.aegis?.saveRepoReport(id)), [run]);

  const openReport = useCallback(() => {
    const current = detailRef.current;
    if (!current) return;
    setPending('opening');
    setError(null);
    void window.aegis?.openRepoReport(current.task.id).then((result) => {
      setPending(null);
      if (!result.ok) setError(result.error);
    });
  }, []);

  const acceptProposal = useCallback(
    (index: number) => {
      const current = detailRef.current;
      if (!current) return;
      setPending('proposing');
      setError(null);
      void window.aegis?.acceptRepoProposal({ taskId: current.task.id, index }).then((result) => {
        setPending(null);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        show(result.value.detail);
        setNotice(
          result.value.outcome === 'saved'
            ? 'Saved to memory as your own statement (scoped to this repository).'
            : result.value.outcome === 'duplicate'
              ? 'Memory already had this; nothing new was stored.'
              : 'Saved, but it conflicts with an earlier memory on the same subject. Both are marked disputed; resolve it in the Memory panel.',
        );
      });
    },
    [show],
  );

  const open = useCallback(
    (id: string) => {
      void window.aegis?.getRepoTask(id).then((result) => {
        if (result.ok) show(result.value);
        else setError(result.error);
      });
    },
    [show],
  );

  const dismiss = useCallback(() => {
    const current = detailRef.current;
    if (current && !isRepoTerminal(current.task.status) && current.task.status !== 'awaiting_save') return;
    show(null);
    setError(null);
    setNotice(null);
  }, [show]);

  const inProgress = detail !== null && !isRepoTerminal(detail.task.status) && detail.task.status !== 'awaiting_save';
  return {
    detail,
    pending,
    error,
    notice,
    history,
    activity: activityFor(detail, pending, settled),
    busy: (pending !== null && pending !== 'opening') || inProgress,
    start,
    chooseRepo,
    approve,
    reject,
    cancel,
    save,
    openReport,
    acceptProposal,
    open,
    dismiss,
  };
}
