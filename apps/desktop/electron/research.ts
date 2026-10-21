import { existsSync } from 'node:fs';
import path from 'node:path';

import { dialog, shell, type BrowserWindow } from 'electron';

import {
  parseRefusedSources,
  parseResearchDetailWithDigest,
  parseResearchTaskList,
  type ChatResult,
  type InterpretResearchArgs,
  type ResearchInterpretation,
  type ResearchTaskDetail,
  type ResearchTaskSummary,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import { coreCall, failure } from './files';

const REQUEST_TIMEOUT_MS = 10_000;
/** Planning may load a local model and resolve each URL's DNS. */
const INTERPRET_TIMEOUT_MS = 90_000;

/**
 * Main-process client for the research workflow.
 *
 * Trust boundary: the renderer sends only the request text, a model name and
 * task ids. Approval uses the plan digest main received from the core and
 * showed to the renderer; the save folder comes from the native picker opened
 * here; the report path that is opened comes from the core's journal.
 */
export class ResearchService {
  private readonly backend: BackendManager;
  /** taskId -> plan digest of the plan main has shown to the renderer. */
  private readonly digests = new Map<string, string>();
  private pickerOpen = false;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  interpret(args: InterpretResearchArgs): Promise<ChatResult<ResearchInterpretation>> {
    return this.call('POST', '/research-tasks/interpret', INTERPRET_TIMEOUT_MS, args, (raw) => {
      if (typeof raw !== 'object' || raw === null) return null;
      const v = raw as Record<string, unknown>;
      if ((v.intent !== 'research' && v.intent !== 'none') || typeof v.detail !== 'string') return null;
      const refused = parseRefusedSources(v.refused);
      const task = v.task === null ? null : this.remember(v.task);
      if (!refused || (v.task !== null && task === null)) return null;
      return { intent: v.intent, detail: v.detail, refused, task };
    });
  }

  getTask(taskId: string): Promise<ChatResult<ResearchTaskDetail>> {
    return this.call('GET', `/research-tasks/${taskId}`, REQUEST_TIMEOUT_MS, undefined, (raw) => this.remember(raw));
  }

  listTasks(): Promise<ChatResult<ResearchTaskSummary[]>> {
    return this.call('GET', '/research-tasks', REQUEST_TIMEOUT_MS, undefined, parseResearchTaskList);
  }

  approve(taskId: string): Promise<ChatResult<ResearchTaskDetail>> {
    const digest = this.digests.get(taskId);
    if (!digest) {
      return Promise.resolve(failure('unknown_plan', 'This plan was not shown in this session; refresh the task.'));
    }
    return this.post(taskId, 'approve', { plan_digest: digest });
  }

  reject(taskId: string): Promise<ChatResult<ResearchTaskDetail>> {
    return this.post(taskId, 'reject', undefined);
  }

  cancel(taskId: string): Promise<ChatResult<ResearchTaskDetail>> {
    return this.post(taskId, 'cancel', undefined);
  }

  /** Native folder picker, then the core writes a new file there (never overwriting). */
  async save(taskId: string, window: BrowserWindow | null): Promise<ChatResult<ResearchTaskDetail | null>> {
    if (!window || window.isDestroyed()) return failure('no_window', 'The app window is not available.');
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    const current = await this.getTask(taskId);
    if (!current.ok) return current;
    if (current.value.task.status !== 'awaiting_save') {
      return failure('not_awaiting_save', 'This report is not waiting to be saved.');
    }
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    this.pickerOpen = true;
    let picked: Electron.OpenDialogReturnValue;
    try {
      picked = await dialog.showOpenDialog(window, {
        title: 'Choose the folder to save the research report in',
        buttonLabel: 'Save report here',
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
    } finally {
      this.pickerOpen = false;
    }
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: true, value: null };
    return this.post(taskId, 'save', { root_path: folder });
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

  private post(taskId: string, action: string, body: unknown): Promise<ChatResult<ResearchTaskDetail>> {
    return this.call('POST', `/research-tasks/${taskId}/${action}`, REQUEST_TIMEOUT_MS, body, (raw) =>
      this.remember(raw),
    );
  }

  private remember(raw: unknown): ResearchTaskDetail | null {
    const parsed = parseResearchDetailWithDigest(raw);
    if (!parsed) return null;
    this.digests.set(parsed.detail.task.id, parsed.digest);
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
