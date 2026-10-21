import { useEffect, useRef, useState } from 'react';

import type { RepoTasksState } from '../../hooks/useRepoTasks';
import { isRepoTerminal } from '../../hooks/useRepoTasks';
import type { RepoFindingStatus, RepoTaskStatus, RepoTaskSummary } from '../../shared/contracts';

const STATUS_LABELS: Record<RepoTaskStatus, string> = {
  awaiting_repo: 'Choose the repository',
  awaiting_approval: 'Plan ready — waiting for your approval',
  inspecting: 'Re-checking the planned evidence…',
  generating: 'Model is analysing the excerpts…',
  awaiting_save: 'Report ready — choose where to save it',
  completed: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
  rejected: 'Rejected — nothing was sent to the model',
};

const FINDING_LABELS: Record<RepoFindingStatus, string> = {
  likely_issue: 'Likely issue',
  plausible_concern: 'Plausible concern',
  best_practice: 'General best practice',
  insufficient_evidence: 'Insufficient evidence',
  removed: 'Removed — cited code was never shown',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString();
const ref = (path: string | null, start: number | null, end?: number | null) =>
  !path ? '(repository)' : !start ? path : `${path}:${start}${end && end !== start ? `-${end}` : ''}`;

/** The repository investigation on stage: picker, exact plan and consent, real progress, checked findings, save. */
export function RepoPanel({ repo }: { repo: RepoTasksState }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [vaultConsent, setVaultConsent] = useState(false);
  const { detail, pending, error, notice } = repo;
  const status = detail?.task.status;

  useEffect(() => {
    if (status) headingRef.current?.focus();
  }, [status]);

  if (!detail) return null;
  const { task, plan, report } = detail;
  const working = pending !== null;

  return (
    <section className="task" aria-labelledby="repo-title" data-status={status}>
      <header className="task__header">
        <h2 id="repo-title" className="task__title" ref={headingRef} tabIndex={-1}>
          Repository investigation{task.repoName ? `: ${task.repoName}` : ''}
        </h2>
        <span className="task__status" data-status={status}>
          {STATUS_LABELS[task.status]}
        </span>
      </header>
      <p className="task__meta">“{task.requestText}” · model {task.model}</p>

      {task.status === 'awaiting_repo' && (
        <>
          <p className="task__text">
            AEGIS will only <strong>read</strong> the folder you choose. It never runs the repository&apos;s code,
            scripts, tests or package managers, never writes inside it, and skips dependencies, build output, links,
            secrets such as <code>.env</code> and keys, and binaries. You will see exactly what goes to the model before
            anything is sent.
          </p>
          <div className="task__actions">
            <button type="button" className="button button--primary" onClick={repo.chooseRepo} disabled={working}>
              {pending === 'picking' ? 'Scanning…' : 'Choose repository…'}
            </button>
            <button type="button" className="button" onClick={repo.cancel} disabled={working}>
              Cancel
            </button>
          </div>
        </>
      )}

      {plan && (
        <details className="task__journal" open={task.status === 'awaiting_approval'}>
          <summary>
            Read-only scan of <span className="task__path">{plan.rootPath}</span>: {plan.filesRead} of {plan.filesSeen}{' '}
            files read by AEGIS&apos;s checks
          </summary>
          <p className="task__text">
            <strong>Languages:</strong>{' '}
            {plan.languages.map((l) => `${l.name} (${l.files} files, ${l.lines} lines)`).join(', ') || 'none'}
            <br />
            <strong>Frameworks (from manifests):</strong>{' '}
            {plan.frameworks.map((f) => `${f.label} (${ref(f.manifest, f.line)})`).join(', ') || 'none detected'}
            <br />
            <strong>Components:</strong> {plan.components.map((c) => `${c.name} (${c.files} files)`).join(', ') || '—'}
            <br />
            <strong>Test files:</strong> {plan.testFiles}
            <br />
            <strong>Not read:</strong>{' '}
            {Object.entries(plan.excluded)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ') || 'nothing excluded'}
          </p>
          {plan.sensitivePaths.length > 0 && (
            <p className="task__text">
              Sensitive files present (content never opened): <span className="task__path">{plan.sensitivePaths.join(', ')}</span>
            </p>
          )}
          {plan.suspiciousFiles.length > 0 && (
            <p className="task__error">
              {plan.suspiciousFiles.length} file(s) contain text addressed to AI assistants (possible prompt injection):{' '}
              {plan.suspiciousFiles.join(', ')}. They are treated as data and cannot change AEGIS&apos;s task or
              permissions.
            </p>
          )}
          <h3 className="report__heading">Confirmed observations (deterministic checks)</h3>
          <ul className="findings">
            {plan.checks.map((c) => (
              <li key={c.id} className="finding" data-status="confirmed">
                <span className="finding__status" data-status="confirmed">
                  {c.id} · {c.severity}
                </span>{' '}
                {c.title} <span className="task__evidence">{ref(c.path, c.line)}</span>
              </li>
            ))}
            {plan.checks.length === 0 && <li>No deterministic check matched.</li>}
          </ul>
          <h3 className="report__heading">Excerpts that will be sent to {task.model}</h3>
          <ol className="sources">
            {plan.context.map((c) => (
              <li key={c.id} className="sources__item">
                <span className="sources__status">{c.id}</span>
                <span className="task__path">
                  {c.path}:{c.start}-{c.end}
                </span>
                <span className="task__evidence">{c.reason}</span>
              </li>
            ))}
          </ol>
          <h3 className="report__heading">Memory that will be used as reference ({plan.memory.length})</h3>
          {plan.memory.length === 0 ? (
            <p className="task__text">No current memory matched.</p>
          ) : (
            <ul className="report__list">
              {plan.memory.map((m) => (
                <li key={m.id}>
                  {m.content}{' '}
                  <span className="task__evidence">
                    {m.kind}, {m.verification.replace('_', ' ')}, {m.scope}, v{m.version}, recorded{' '}
                    {m.recordedAt.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="report__heading">Vault notes proposed as evidence ({plan.vaultNotes.length})</h3>
          {plan.vaultNotes.length === 0 ? (
            <p className="task__text">No registered vault note matched.</p>
          ) : (
            <ul className="report__list">
              {plan.vaultNotes.map((n) => (
                <li key={n.noteId}>
                  {n.title} <span className="task__path">{n.relPath}</span>{' '}
                  <span className="task__evidence">
                    {n.author === 'aegis_user' ? 'AEGIS-written' : 'your note'}, version {n.version}, SHA-256{' '}
                    {n.sha256.slice(0, 12)}…
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {task.status === 'awaiting_approval' && plan && (
        <>
          {plan.vaultNotes.length > 0 && (
            <p className="consent">
              <input
                id="repo-vault-consent"
                type="checkbox"
                checked={vaultConsent && plan.modelIsLocal}
                disabled={!plan.modelIsLocal || working}
                onChange={(event) => setVaultConsent(event.target.checked)}
              />
              <label htmlFor="repo-vault-consent">
                Also give bounded excerpts of these {plan.vaultNotes.length} vault note(s) to the local model for this
                task only. Each is used only if it is still exactly the version listed above.
                {!plan.modelIsLocal && ' Not available: the selected model is not local.'}
              </label>
            </p>
          )}
          <div className="task__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => repo.approve(vaultConsent && plan.modelIsLocal)}
              disabled={working}
            >
              Approve and analyse {plan.context.length} excerpt{plan.context.length === 1 ? '' : 's'}
            </button>
            <button type="button" className="button" onClick={repo.chooseRepo} disabled={working}>
              Choose another folder…
            </button>
            <button type="button" className="button" onClick={repo.reject} disabled={working}>
              Reject
            </button>
          </div>
        </>
      )}

      {(task.status === 'inspecting' || task.status === 'generating') && (
        <div className="task__progress">
          <p className="task__text" role="status">
            {task.status === 'inspecting'
              ? 'Re-reading the planned excerpts and checking memory and notes are still current.'
              : `Waiting for ${task.model}; one call, bounded to the excerpts listed above.`}
            {task.cancelRequested ? ' Stopping…' : ''}
          </p>
          <button type="button" className="button" onClick={repo.cancel} disabled={working || task.cancelRequested}>
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
      {notice && (
        <p className="task__text" role="status">
          {notice}
        </p>
      )}

      {report && (
        <div className="report" aria-label="Report">
          <h3 className="report__heading">Summary (model)</h3>
          <p className="task__text">{report.summary || 'The model gave no summary.'}</p>
          <h3 className="report__heading">Model findings, checked against the cited code</h3>
          {report.findings.length === 0 && <p className="task__text">The model returned no findings.</p>}
          <ul className="findings">
            {report.findings.map((f) => (
              <li key={f.id} className="finding" data-status={f.status}>
                <span className="finding__status" data-status={f.status}>
                  {f.id} · {FINDING_LABELS[f.status]}
                </span>{' '}
                {f.title} <span className="task__path">{ref(f.path, f.startLine, f.endLine)}</span>
                <span className="task__evidence">{f.detail}</span>
                {f.quote && <code className="task__evidence">{f.quote}</code>}
                {f.recommendation && <span className="task__evidence">Recommendation: {f.recommendation}</span>}
                {f.reasons.length > 0 && <span className="task__evidence">{f.reasons.join(' ')}</span>}
              </li>
            ))}
          </ul>
          {report.hypotheses.length > 0 && (
            <>
              <h3 className="report__heading">Hypotheses (unverified)</h3>
              <ul className="report__list">
                {report.hypotheses.map((h) => (
                  <li key={h.problem}>
                    {h.problem}
                    <ul>
                      {h.explanations.map((e) => (
                        <li key={e.explanation}>
                          {e.explanation} <span className="task__evidence">For: {e.supporting}</span>{' '}
                          <span className="task__evidence">Against: {e.contradicting}</span>
                        </li>
                      ))}
                      {h.verificationSteps.map((s) => (
                        <li key={s}>Verify: {s}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="report__heading">Memory and notes considered</h3>
          <ul className="report__list">
            {report.memory.map((m) => (
              <li key={m.ref}>
                {m.used ? 'Used' : 'Withheld'}: {m.content} <span className="task__evidence">{m.label}, {m.scope}; {m.check}</span>
              </li>
            ))}
            {report.vault.map((n) => (
              <li key={n.noteId}>
                Vault note {n.relPath} (v{n.version}): {n.status}
                {n.detail && <span className="task__evidence">{n.detail}</span>}
              </li>
            ))}
            {report.memory.length + report.vault.length === 0 && <li>None.</li>}
          </ul>
          {report.proposals.length > 0 && (
            <>
              <h3 className="report__heading">Proposed memories (stored only if you add them)</h3>
              <ul className="report__list">
                {report.proposals.map((p, index) => (
                  <li key={p.subject}>
                    {p.content}{' '}
                    <button
                      type="button"
                      className="button"
                      onClick={() => repo.acceptProposal(index)}
                      disabled={working}
                    >
                      Add to memory
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="report__heading">Limitations</h3>
          <ul className="report__list">
            {report.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {report.uncertainties.map((item) => (
              <li key={`u-${item}`}>Model-reported: {item}</li>
            ))}
          </ul>
          <p className="task__text" role="status">
            Repository unchanged during the investigation: {report.unchanged ? 'yes' : 'NO'} ({report.entriesCompared}{' '}
            entries compared); {report.excerptsVerified} excerpt(s) hash-checked before use.
          </p>
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
          <button type="button" className="button button--primary" onClick={repo.save} disabled={working}>
            {pending === 'saving' ? 'Folder picker open…' : 'Save report…'}
          </button>
          <button type="button" className="button" onClick={repo.dismiss} disabled={working}>
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
            <button type="button" className="button button--primary" onClick={repo.openReport} disabled={working}>
              Open report
            </button>
          </div>
        </>
      )}

      {isRepoTerminal(task.status) && (
        <div className="task__actions">
          <button type="button" className="button" onClick={repo.dismiss}>
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

interface RepoHistoryProps {
  tasks: RepoTaskSummary[];
  disabled: boolean;
  onOpen: (taskId: string) => void;
}

/** Recent repository investigations from the core's journal. */
export function RepoHistory({ tasks, disabled, onOpen }: RepoHistoryProps) {
  return (
    <details className="panel">
      <summary>Repository investigations ({tasks.length})</summary>
      {tasks.length === 0 ? (
        <p className="panel__note">None yet. Try “Analyze this repository and explain its architecture”.</p>
      ) : (
        <ul className="task-history">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" className="task-history__item" disabled={disabled} onClick={() => onOpen(t.id)}>
                <span className="task-history__status" data-status={t.status}>
                  {t.status.replace('_', ' ')}
                </span>
                <span className="task-history__path" title={t.repoName ?? ''}>
                  {t.repoName ?? '(no folder chosen)'}
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
