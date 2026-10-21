import { useEffect, useRef } from 'react';

import type { ResearchTasksState } from '../../hooks/useResearchTasks';
import { isResearchTerminal } from '../../hooks/useResearchTasks';
import type {
  FindingStatus,
  ResearchSourceRecord,
  ResearchSourceStatus,
  ResearchTaskStatus,
  ResearchTaskSummary,
} from '../../shared/contracts';

const STATUS_LABELS: Record<ResearchTaskStatus, string> = {
  awaiting_approval: 'Waiting for your approval',
  researching: 'Reading approved sources…',
  generating: 'Model is writing findings…',
  awaiting_save: 'Report ready — choose where to save it',
  completed: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected — nothing was read',
};

const SOURCE_LABELS: Record<ResearchSourceStatus, string> = {
  planned: 'Will read',
  rejected: 'Refused',
  fetching: 'Reading…',
  extracted: 'Read',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Not read',
};

const FINDING_LABELS: Record<FindingStatus, string> = {
  supported: 'Supported',
  weak: 'Weak support',
  unsupported: 'Unsupported',
  removed: 'Removed — no valid citation',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString();

function SourceList({ sources }: { sources: ResearchSourceRecord[] }) {
  return (
    <ol className="sources" aria-label="Sources">
      {sources.map((s) => (
        <li key={s.id} className="sources__item">
          <span className="sources__status" data-status={s.status}>
            S{s.seq} · {SOURCE_LABELS[s.status]}
          </span>
          <span className="task__path">{s.canonicalUrl ?? s.requestedUrl}</span>
          {s.title && <span className="sources__title">{s.title}</span>}
          {(s.detail || s.retrievedAt) && (
            <span className="task__evidence">
              {s.retrievedAt && `Retrieved ${time(s.retrievedAt)}`}
              {s.sha256 && ` · ${s.textChars ?? 0} characters · SHA-256 ${s.sha256.slice(0, 12)}…`}
              {s.detail && ` · ${s.detail}`}
              {s.code && s.status !== 'extracted' && ` (${s.code})`}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The research task on stage: exact source plan, approval, real progress, verified findings and save. */
export function ResearchPanel({ research }: { research: ResearchTasksState }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { detail, refusal, pending, error, notice } = research;
  const status = detail?.task.status;

  useEffect(() => {
    if (status || refusal) headingRef.current?.focus();
  }, [status, refusal]);

  if (refusal && !detail) {
    return (
      <section className="task" aria-labelledby="research-title" data-status="failed">
        <header className="task__header">
          <h2 id="research-title" className="task__title" ref={headingRef} tabIndex={-1}>
            Research — no readable source
          </h2>
        </header>
        <p className="task__text">{refusal.detail}</p>
        <ul className="sources">
          {refusal.refused.map((r) => (
            <li key={r.url} className="sources__item">
              <span className="sources__status" data-status="rejected">
                Refused ({r.code})
              </span>
              <span className="task__path">{r.url}</span>
              <span className="task__evidence">{r.detail}</span>
            </li>
          ))}
        </ul>
        <p className="task__meta">Nothing was fetched. Nothing was sent to the model.</p>
        <div className="task__actions">
          <button type="button" className="button" onClick={research.dismiss}>
            Close
          </button>
        </div>
      </section>
    );
  }
  if (!detail) return null;

  const { task, sources, report } = detail;
  const planned = sources.filter((s) => s.status !== 'rejected' && !(s.status === 'skipped' && s.code === 'over_limit'));
  const done = planned.filter((s) => !['planned', 'fetching'].includes(s.status)).length;
  const working = pending !== null;

  return (
    <section className="task" aria-labelledby="research-title" data-status={status}>
      <header className="task__header">
        <h2 id="research-title" className="task__title" ref={headingRef} tabIndex={-1}>
          Research
        </h2>
        <span className="task__status" data-status={status}>
          {STATUS_LABELS[task.status]}
        </span>
      </header>
      <p className="task__meta">
        “{task.requestText}” ·{' '}
        {task.planSource === 'model' ? task.planDetail : `Keyword fallback (not a model decision): ${task.planDetail}`}
      </p>
      <p className="task__text">
        <strong>Question:</strong> {task.question}
        <br />
        <strong>Key terms:</strong> {task.keyTerms.join(', ') || '—'}
      </p>

      {task.status === 'awaiting_approval' && (
        <p className="task__text">
          AEGIS will read only the {planned.length} public page{planned.length === 1 ? '' : 's'} below, in an
          isolated browser with JavaScript off, then ask {task.model ?? 'the model'} for findings that must quote
          those pages. There is no web search, no login, no downloads, and nothing is written until you choose a
          folder.
        </p>
      )}

      <SourceList sources={sources} />

      {task.status === 'awaiting_approval' && (
        <div className="task__actions">
          <button type="button" className="button button--primary" onClick={research.approve} disabled={working}>
            Approve and read {planned.length} source{planned.length === 1 ? '' : 's'}
          </button>
          <button type="button" className="button" onClick={research.reject} disabled={working}>
            Reject
          </button>
        </div>
      )}

      {(task.status === 'researching' || task.status === 'generating') && (
        <div className="task__progress">
          <p className="task__text" role="status">
            {task.status === 'researching'
              ? `${done} of ${planned.length} sources processed.`
              : `All sources processed; waiting for ${task.model ?? 'the model'}.`}
            {task.cancelRequested ? ' Stopping…' : ''}
          </p>
          <progress max={planned.length + 1} value={done + (task.status === 'generating' ? 0.5 : 0)} aria-label="Research progress" />
          <button type="button" className="button" onClick={research.cancel} disabled={working || task.cancelRequested}>
            Stop
          </button>
        </div>
      )}

      {task.errorDetail && (
        <p className="task__error">
          {task.errorDetail} ({task.errorCode})
        </p>
      )}
      {error && (
        <p className="task__error" role="alert">
          {error.detail} ({error.code})
        </p>
      )}
      {notice && <p className="task__text">{notice}</p>}

      {report && (
        <div className="report" aria-label="Report">
          <h3 className="report__heading">Findings</h3>
          {report.findings.length === 0 && <p className="task__text">The model returned no findings.</p>}
          <ul className="findings">
            {report.findings.map((f) => (
              <li key={f.id} className="finding" data-status={f.status}>
                <span className="finding__status" data-status={f.status}>
                  {f.id} · {FINDING_LABELS[f.status]}
                </span>{' '}
                {f.claim} {f.citations.length > 0 && <span className="task__evidence">Cites {f.citations.join(', ')}</span>}
                {f.reasons.length > 0 && <span className="task__evidence">{f.reasons.join(' ')}</span>}
              </li>
            ))}
          </ul>
          <h3 className="report__heading">Limitations</h3>
          <ul className="report__list">
            {report.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {report.uncertainties.map((item) => (
              <li key={`u-${item}`}>Model-reported: {item}</li>
            ))}
          </ul>
          {task.reportMarkdown && (
            <details className="task__journal">
              <summary>Report Markdown ({task.reportMarkdown.length} characters)</summary>
              <pre className="report__markdown" tabIndex={0}>
                {task.reportMarkdown}
              </pre>
            </details>
          )}
        </div>
      )}

      {task.status === 'awaiting_save' && (
        <div className="task__actions">
          <button type="button" className="button button--primary" onClick={research.save} disabled={working}>
            {pending === 'saving' ? 'Folder picker open…' : 'Save report…'}
          </button>
          <button type="button" className="button" onClick={research.dismiss} disabled={working}>
            Close without saving
          </button>
        </div>
      )}

      {task.status === 'completed' && task.savedPath && (
        <>
          <p className="task__text" role="status">
            Saved and verified (SHA-256 {task.reportSha256?.slice(0, 12)}…): <span className="task__path">{task.savedPath}</span>
          </p>
          <div className="task__actions">
            <button type="button" className="button button--primary" onClick={research.openReport} disabled={working}>
              Open report
            </button>
          </div>
        </>
      )}

      {isResearchTerminal(task.status) && (
        <div className="task__actions">
          <button type="button" className="button" onClick={research.dismiss}>
            Close task
          </button>
        </div>
      )}

      {detail.events.length > 0 && (
        <details className="task__journal">
          <summary>
            Journal ({detail.events.length} events) · task {task.id.slice(0, 8)}
          </summary>
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

interface ResearchHistoryProps {
  tasks: ResearchTaskSummary[];
  disabled: boolean;
  onOpen: (taskId: string) => void;
}

/** Recent research tasks from the core's journal. */
export function ResearchHistory({ tasks, disabled, onOpen }: ResearchHistoryProps) {
  return (
    <details className="panel">
      <summary>Research tasks ({tasks.length})</summary>
      {tasks.length === 0 ? (
        <p className="panel__note">No research yet. Try “Research &lt;question&gt; https://…” with public page URLs.</p>
      ) : (
        <ul className="task-history">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="task-history__item" disabled={disabled} onClick={() => onOpen(t.id)}>
                <span className="task-history__status" data-status={t.status}>
                  {t.status.replace('_', ' ')}
                </span>
                <span className="task-history__path" title={t.question}>
                  {t.question}
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
