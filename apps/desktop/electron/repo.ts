import { existsSync } from 'node:fs';
import path from 'node:path';

import { dialog, shell, type BrowserWindow } from 'electron';

import {
  parseRepoDetailWithDigest,
  parseRepoTaskList,
  type ChatResult,
  type InterpretResearchArgs,
  type MemoryAddOutcome,
  type RepoApproveArgs,
  type RepoInterpretation,
  type RepoProposalArgs,
  type RepoProposalOutcome,
  type RepoTaskDetail,
  type RepoTaskSummary,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import { coreCall, failure } from './files';

const REQUEST_TIMEOUT_MS = 10_000;
/** The read-only scan of a large repository (bounded by the core) plus memory/vault lookups. */
const SCAN_TIMEOUT_MS = 120_000;
const OUTCOMES: readonly MemoryAddOutcome[] = ['saved', 'duplicate', 'disputed'];

/**
 * Main-process client for the repository investigation workflow.
 *
 * Trust boundary: the renderer sends only the request text, a model name, task ids, a vault-consent flag and a
 * proposal index. The repository and the save folder come from native pickers opened here; approval uses the
 * plan digest main received from the core; the report path that is opened comes from the core's journal.
 */
export class RepoService {
  private readonly backend: BackendManager;
  /** taskId -> plan digest of the plan main has shown to the renderer. */
  private readonly digests = new Map<string, string>();
  private pickerOpen = false;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  interpret(args: InterpretResearchArgs): Promise<ChatResult<RepoInterpretation>> {
    return this.call('POST', '/repo-tasks/interpret', REQUEST_TIMEOUT_MS, args, (raw) => {
      if (typeof raw !== 'object' || raw === null) return null;
      const v = raw as Record<string, unknown>;
      if ((v.intent !== 'repo' && v.intent !== 'none') || typeof v.detail !== 'string') return null;
      const task = v.task === null ? null : this.remember(v.task);
      if (v.task !== null && task === null) return null;
      return { intent: v.intent, detail: v.detail, task };
    });
  }

  /** Native folder picker for the repository; the core validates it and scans it read-only. */
  async chooseRepo(taskId: string, window: BrowserWindow | null): Promise<ChatResult<RepoTaskDetail | null>> {
    const current = await this.getTask(taskId);
    if (!current.ok) return current;
    const status = current.value.task.status;
    if (status !== 'awaiting_repo' && status !== 'awaiting_approval') {
      return failure('task_not_open', 'This task is no longer waiting for a repository.');
    }
    const folder = await this.pick(window, 'Choose the repository AEGIS may read (read-only)', 'Inspect this folder');
    if (!folder.ok) return folder;
    if (folder.value === null) return { ok: true, value: null };
    return this.call('POST', `/repo-tasks/${taskId}/scope`, SCAN_TIMEOUT_MS, { root_path: folder.value }, (raw) =>
      this.remember(raw),
    );
  }

  getTask(taskId: string): Promise<ChatResult<RepoTaskDetail>> {
    return this.call('GET', `/repo-tasks/${taskId}`, REQUEST_TIMEOUT_MS, undefined, (raw) => this.remember(raw));
  }

  listTasks(): Promise<ChatResult<RepoTaskSummary[]>> {
    return this.call('GET', '/repo-tasks', REQUEST_TIMEOUT_MS, undefined, parseRepoTaskList);
  }

  approve(args: RepoApproveArgs): Promise<ChatResult<RepoTaskDetail>> {
    const digest = this.digests.get(args.taskId);
    if (!digest) return Promise.resolve(failure('unknown_plan', 'This plan was not shown in this session; refresh it.'));
    return this.post(args.taskId, 'approve', { plan_digest: digest, use_vault_notes: args.useVaultNotes });
  }

  reject(taskId: string): Promise<ChatResult<RepoTaskDetail>> {
    return this.post(taskId, 'reject', undefined);
  }

  cancel(taskId: string): Promise<ChatResult<RepoTaskDetail>> {
    return this.post(taskId, 'cancel', undefined);
  }

  /** Native folder picker, then the core writes a new file there (never overwriting, never inside the repo). */
  async save(taskId: string, window: BrowserWindow | null): Promise<ChatResult<RepoTaskDetail | null>> {
    const current = await this.getTask(taskId);
    if (!current.ok) return current;
    if (current.value.task.status !== 'awaiting_save') {
      return failure('not_awaiting_save', 'This report is not waiting to be saved.');
    }
    const folder = await this.pick(window, 'Choose the folder to save the repository report in', 'Save report here');
    if (!folder.ok) return folder;
    if (folder.value === null) return { ok: true, value: null };
    return this.post(taskId, 'save', { root_path: folder.value });
  }

  /** Open the saved report with the default app. The path comes from the core's journal, not the renderer. */
  async openReport(taskId: string): Promise<ChatResult<true>> {
    const current = await this.getTask(taskId);
    if (!current.ok) return current;
    const saved = current.value.task.savedPath;
    if (current.value.task.status !== 'completed' || !saved || path.extname(saved).toLowerCase() !== '.md') {
      return failure('not_saved', 'This report has not been saved yet.');
    }
    if (!existsSync(saved)) return failure('file_missing', 'The saved report is no longer at its recorded location.');
    const problem = await shell.openPath(saved);
    return problem ? failure('open_failed', `Windows could not open the report: ${problem}`) : { ok: true, value: true };
  }

  acceptProposal(args: RepoProposalArgs): Promise<ChatResult<RepoProposalOutcome>> {
    return this.call(
      'POST',
      `/repo-tasks/${args.taskId}/proposals/${args.index}/accept`,
      REQUEST_TIMEOUT_MS,
      undefined,
      (raw) => {
        if (typeof raw !== 'object' || raw === null) return null;
        const v = raw as Record<string, unknown>;
        const detail = this.remember(v.detail);
        const outcome = OUTCOMES.find((o) => o === v.outcome);
        return detail && outcome ? { outcome, detail } : null;
      },
    );
  }

  private async pick(window: BrowserWindow | null, title: string, buttonLabel: string): Promise<ChatResult<string | null>> {
    if (!window || window.isDestroyed()) return failure('no_window', 'The app window is not available.');
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    this.pickerOpen = true;
    try {
      const picked = await dialog.showOpenDialog(window, {
        title,
        buttonLabel,
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      const folder = picked.filePaths[0];
      return { ok: true, value: picked.canceled || !folder ? null : folder };
    } finally {
      this.pickerOpen = false;
    }
  }

  private post(taskId: string, action: string, body: unknown): Promise<ChatResult<RepoTaskDetail>> {
    return this.call('POST', `/repo-tasks/${taskId}/${action}`, REQUEST_TIMEOUT_MS, body, (raw) => this.remember(raw));
  }

  private remember(raw: unknown): RepoTaskDetail | null {
    const parsed = parseRepoDetailWithDigest(raw);
    if (!parsed) return null;
    if (parsed.digest) this.digests.set(parsed.detail.task.id, parsed.digest);
    return parsed.detail;
  }

  private call<T>(
    method: 'GET' | 'POST',
    route: string,
    timeoutMs: number,
    body: unknown,
    parse: (value: unknown) => T | null,
  ): Promise<ChatResult<T>> {
    return coreCall(this.backend, method, route, timeoutMs, body, parse);
  }
}
