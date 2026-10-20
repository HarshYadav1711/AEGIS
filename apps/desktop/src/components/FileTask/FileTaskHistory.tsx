import type { FileTaskRecord } from '../../shared/contracts';

interface FileTaskHistoryProps {
  tasks: FileTaskRecord[];
  disabled: boolean;
  onOpen: (taskId: string) => void;
}

/** Recent file tasks from the core's journal; opening one shows its recorded plan and results. */
export function FileTaskHistory({ tasks, disabled, onOpen }: FileTaskHistoryProps) {
  return (
    <details className="panel">
      <summary>File tasks ({tasks.length})</summary>
      {tasks.length === 0 ? (
        <p className="panel__note">No file tasks yet. Try “Organize the files in a folder by type”.</p>
      ) : (
        <ul className="task-history">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="task-history__item" disabled={disabled} onClick={() => onOpen(t.id)}>
                <span className="task-history__status" data-status={t.status}>
                  {t.status.replace('_', ' ')}
                </span>
                <span className="task-history__path" title={t.rootPath ?? undefined}>
                  {t.rootPath ? t.rootPath.split(/[\\/]/).filter(Boolean).at(-1) : 'no folder chosen'}
                </span>
                <time dateTime={t.createdAt}>{new Date(t.createdAt).toLocaleString()}</time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
