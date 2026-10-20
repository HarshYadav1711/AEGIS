import type { FileOperationRecord } from '../../shared/contracts';

const RESULT_LABELS: Record<FileOperationRecord['status'], string> = {
  planned: 'Will move',
  skipped: 'Skipped',
  started: 'Moving…',
  verified: 'Moved · verified',
  failed: 'Not moved',
  unknown: 'Unknown',
  not_attempted: 'Not attempted',
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function evidence(op: FileOperationRecord): string | null {
  if (op.status !== 'verified' || !op.verification) return op.detail ?? op.planReason;
  const v = op.verification;
  const hash = v.sha256_match === true ? ', SHA-256 match' : v.sha256_match === null ? ', not hashed (large file)' : '';
  return `Found at destination: same file ID, size and timestamp${hash}; source gone.`;
}

interface OperationTableProps {
  operations: FileOperationRecord[];
  caption: string;
}

/** Exact plan / journal rows. File names are untrusted text and are rendered as plain text only. */
export function OperationTable({ operations, caption }: OperationTableProps) {
  if (operations.length === 0) {
    return <p className="task__empty">The folder has no entries.</p>;
  }
  return (
    <div className="task__table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="task__table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">File</th>
            <th scope="col">Action</th>
            <th scope="col">Destination</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => (
            <tr key={op.id} data-status={op.status}>
              <td>{op.seq}</td>
              <td className="task__name">
                {op.sourceName}
                {op.size !== null && <span className="task__size"> · {formatSize(op.size)}</span>}
              </td>
              <td>{op.action === 'move' ? 'Move' : 'Skip'}</td>
              <td className="task__name">{op.destRel ?? '—'}</td>
              <td>
                <span className="task__result" data-status={op.status}>
                  {RESULT_LABELS[op.status]}
                </span>
                {evidence(op) && <span className="task__evidence">{evidence(op)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
