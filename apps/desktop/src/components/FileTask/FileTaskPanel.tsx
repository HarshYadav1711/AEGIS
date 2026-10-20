import { useEffect, useRef, useState } from 'react';

import type { FileTasksState } from '../../hooks/useFileTasks';
import { isTerminal } from '../../hooks/useFileTasks';
import type { FileTaskDetail, FileTaskStatus } from '../../shared/contracts';
import { OperationTable } from './OperationTable';

const STATUS_LABELS: Record<FileTaskStatus, string> = {
  awaiting_folder: 'Waiting for you to choose a folder',
  planning: 'Scanning the folder…',
  awaiting_approval: 'Waiting for your approval',
  executing: 'Moving files…',
  completed: 'Completed — every move verified',
  partial: 'Partially completed',
  failed: 'Failed',
  unknown: 'Result unknown — check the folder before retrying',
  cancelled: 'Cancelled',
  rejected: 'Rejected — nothing was moved',
};

function counts(detail: FileTaskDetail) {
  const c = { moves: 0, skipped: 0, verified: 0, failed: 0, unknown: 0, notAttempted: 0 };
  for (const op of detail.operations) {
    if (op.action === 'skip') c.skipped++;
    else c.moves++;
    if (op.status === 'verified') c.verified++;
    else if (op.status === 'failed') c.failed++;
    else if (op.status === 'unknown' || op.status === 'started') c.unknown++;
    else if (op.status === 'not_attempted') c.notAttempted++;
  }
  return c;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString();

/** The file task on stage: folder choice, exact plan, approval, real progress and verified results. */
export function FileTaskPanel({ tasks }: { tasks: FileTasksState }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { detail, pending, error, notice } = tasks;
  const status = detail?.task.status;
  const expiresAt = detail?.plan && status === 'awaiting_approval' ? detail.plan.expiresAt : null;
  const [expiredAt, setExpiredAt] = useState<string | null>(null);

  // Disable approval once the plan's approval window closes (the core refuses it then anyway).
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, new Date(expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  // Move focus to the panel when its step changes, never onto a consequential button.
  useEffect(() => {
    if (status) headingRef.current?.focus();
  }, [status]);

  if (!detail) return null;
  const { task, plan } = detail;
  const c = counts(detail);
  const expired = expiresAt !== null && expiredAt === expiresAt;
  const working = pending !== null;
  const interpretedBy =
    task.intentSource === 'model'
      ? `Request understood by ${task.intentModel ?? 'the model'}.`
      : `Request matched by keyword fallback (not a model decision): ${task.intentDetail}`;

  return (
    <section className="task" aria-labelledby="task-title" data-status={status}>
      <header className="task__header">
        <h2 id="task-title" className="task__title" ref={headingRef} tabIndex={-1}>
          Organize files by type
        </h2>
        <span className="task__status" data-status={status}>
          {pending === 'planning' ? STATUS_LABELS.planning : STATUS_LABELS[task.status]}
        </span>
      </header>
      <p className="task__meta">
        “{task.requestText}” · {interpretedBy}
      </p>

      {task.status === 'awaiting_folder' && (
        <>
          <p className="task__text">
            AEGIS will look only at the files directly inside the folder you choose and propose moving them into
            subfolders such as Documents, Images and Code. Nothing moves until you approve the exact list. Files are
            never deleted, overwritten or opened for editing.
          </p>
          <div className="task__actions">
            <button type="button" className="button button--primary" onClick={tasks.chooseFolder} disabled={working}>
              {pending === 'choosing' ? 'Folder picker open…' : 'Choose folder…'}
            </button>
            <button type="button" className="button" onClick={tasks.cancel} disabled={working}>
              Cancel
            </button>
          </div>
        </>
      )}

      {plan && (
        <p className="task__text">
          Folder: <span className="task__path">{plan.rootPath}</span>
        </p>
      )}

      {task.status === 'awaiting_approval' && plan && (
        <>
          <p className="task__text">
            {c.moves} file{c.moves === 1 ? '' : 's'} will be moved into type folders inside this folder; {c.skipped}{' '}
            entr{c.skipped === 1 ? 'y' : 'ies'} will be left untouched. Nothing is deleted or overwritten.{' '}
            {expired ? 'This plan has expired; re-scan to approve.' : `Approval valid until ${time(plan.expiresAt)}.`}
          </p>
          <div className="task__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={tasks.approve}
              disabled={working || expired || c.moves === 0}
            >
              {c.moves === 0 ? 'Nothing to move' : `Approve and move ${c.moves} file${c.moves === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="button" onClick={tasks.reject} disabled={working}>
              Reject
            </button>
            <button type="button" className="button" onClick={tasks.replan} disabled={working}>
              Re-scan folder
            </button>
          </div>
        </>
      )}

      {task.status === 'executing' && (
        <div className="task__progress">
          <p className="task__text" role="status">
            {c.verified + c.failed + c.unknown} of {c.moves} moves finished ({c.verified} verified)
            {task.cancelRequested ? ' — stopping after the current file.' : '.'}
          </p>
          <progress max={c.moves} value={c.verified + c.failed + c.unknown} aria-label="Moves finished" />
          <button type="button" className="button" onClick={tasks.cancel} disabled={working || task.cancelRequested}>
            Stop
          </button>
        </div>
      )}

      {isTerminal(task.status) && task.status !== 'rejected' && plan && task.approvalDecision === 'approved' && (
        <p className="task__text" role="status">
          {c.verified} moved and verified · {c.failed} not moved · {c.unknown} unknown · {c.notAttempted} not
          attempted · {c.skipped} skipped by the plan.
        </p>
      )}
      {task.errorDetail && <p className="task__error">{task.errorDetail}</p>}
      {error && (
        <p className="task__error" role="alert">
          {error.detail} ({error.code})
        </p>
      )}
      {notice && <p className="task__text">{notice}</p>}

      {detail.operations.length > 0 && (
        <OperationTable
          operations={detail.operations}
          caption={task.status === 'awaiting_approval' ? 'Proposed operations' : 'Operations and results'}
        />
      )}

      {isTerminal(task.status) && (
        <div className="task__actions">
          <button type="button" className="button" onClick={tasks.dismiss}>
            Close task
          </button>
        </div>
      )}

      {detail.events.length > 0 && (
        <details className="task__journal">
          <summary>Journal ({detail.events.length} events) · task {task.id.slice(0, 8)}</summary>
          <ol>
            {detail.events.map((e) => (
              <li key={e.id}>
                <time dateTime={e.at}>{time(e.at)}</time> <strong>{e.kind}</strong> {e.detail}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
