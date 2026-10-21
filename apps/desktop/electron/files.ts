import { dialog, type BrowserWindow } from 'electron';

import {
  parseFileTaskDetailWithDigest,
  parseFileTaskList,
  type ChatError,
  type ChatResult,
  type FileInterpretation,
  type FilePlanDecisionArgs,
  type FileTaskDetail,
  type FileTaskProgressEvent,
  type FileTaskRecord,
  type InterpretFileRequestArgs,
} from '../src/shared/contracts';
import { CoreUnavailableError, type BackendManager } from './backend';

const REQUEST_TIMEOUT_MS = 10_000;
/** Interpretation may load a local model first (several seconds on a cold start). */
const INTERPRET_TIMEOUT_MS = 90_000;
/** Planning lists one folder and hashes files up to the core's byte budget. */
const PLAN_TIMEOUT_MS = 120_000;

/**
 * Main-process client for the file-organization workflow.
 *
 * Trust boundary: the only folder path that ever reaches the core comes from
 * the native folder picker opened here. Approvals arrive from the renderer as
 * (taskId, planId) only; main attaches the digest of the plan it last received
 * from the core and showed to the renderer, so the core executes exactly that
 * plan or nothing.
 */
export class FileTaskService {
  private readonly backend: BackendManager;
  /** planId -> { taskId, digest } for plans main has shown to the renderer. */
  private readonly digests = new Map<string, { taskId: string; digest: string }>();
  private pickerOpen = false;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  async interpret(args: InterpretFileRequestArgs): Promise<ChatResult<FileInterpretation>> {
    return this.call('POST', '/file-tasks/interpret', INTERPRET_TIMEOUT_MS, args, (raw) => {
      if (typeof raw !== 'object' || raw === null) return null;
      const v = raw as Record<string, unknown>;
      if (v.intent !== 'organize_by_type' && v.intent !== 'none') return null;
      if (v.source !== 'prefilter' && v.source !== 'model' && v.source !== 'keyword_fallback') return null;
      if (typeof v.detail !== 'string' || (v.model !== null && typeof v.model !== 'string')) return null;
      let task: FileTaskDetail | null = null;
      if (v.task !== null) {
        task = this.remember(v.task);
        if (!task) return null;
      }
      if ((v.intent === 'organize_by_type') !== (task !== null)) return null;
      return { intent: v.intent, source: v.source, model: v.model as string | null, detail: v.detail, task };
    });
  }

  /**
   * Show the native folder picker for this task. Resolves with null when the
   * user closes the picker without choosing (nothing is sent to the core).
   */
  async chooseFolder(
    taskId: string,
    window: BrowserWindow | null,
    emit: (event: FileTaskProgressEvent) => void,
  ): Promise<ChatResult<FileTaskDetail | null>> {
    if (!window || window.isDestroyed()) return failure('no_window', 'The app window is not available.');
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    // Only show the picker for a task the core says is waiting for a folder.
    const current = await this.getTask(taskId);
    if (!current.ok) return current;
    if (current.value.task.status !== 'awaiting_folder' && current.value.task.status !== 'awaiting_approval') {
      return failure('task_not_open', 'This task is no longer waiting for a folder.');
    }
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    this.pickerOpen = true;
    let picked: Electron.OpenDialogReturnValue;
    try {
      picked = await dialog.showOpenDialog(window, {
        title: 'Choose the folder AEGIS may organize',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
    } finally {
      this.pickerOpen = false;
    }
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: true, value: null };
    emit({ type: 'planning', taskId });
    return this.call('POST', `/file-tasks/${taskId}/scope`, PLAN_TIMEOUT_MS, { root_path: folder }, (raw) =>
      this.remember(raw),
    );
  }

  getTask(taskId: string): Promise<ChatResult<FileTaskDetail>> {
    return this.call('GET', `/file-tasks/${taskId}`, REQUEST_TIMEOUT_MS, undefined, (raw) => this.remember(raw));
  }

  listTasks(): Promise<ChatResult<FileTaskRecord[]>> {
    return this.call('GET', '/file-tasks', REQUEST_TIMEOUT_MS, undefined, parseFileTaskList);
  }

  approve(args: FilePlanDecisionArgs): Promise<ChatResult<FileTaskDetail>> {
    const known = this.digests.get(args.planId);
    if (!known || known.taskId !== args.taskId) {
      return Promise.resolve(failure('unknown_plan', 'This plan was not shown in this session; refresh the task.'));
    }
    return this.call(
      'POST',
      `/file-tasks/${args.taskId}/approve`,
      REQUEST_TIMEOUT_MS,
      { plan_id: args.planId, plan_digest: known.digest },
      (raw) => this.remember(raw),
    );
  }

  reject(args: FilePlanDecisionArgs): Promise<ChatResult<FileTaskDetail>> {
    return this.call('POST', `/file-tasks/${args.taskId}/reject`, REQUEST_TIMEOUT_MS, { plan_id: args.planId }, (raw) =>
      this.remember(raw),
    );
  }

  cancel(taskId: string): Promise<ChatResult<FileTaskDetail>> {
    return this.call('POST', `/file-tasks/${taskId}/cancel`, REQUEST_TIMEOUT_MS, undefined, (raw) => this.remember(raw));
  }

  replan(taskId: string): Promise<ChatResult<FileTaskDetail>> {
    return this.call('POST', `/file-tasks/${taskId}/replan`, PLAN_TIMEOUT_MS, undefined, (raw) => this.remember(raw));
  }

  /** Parse a task payload, keep its plan digest in main, and return the renderer-safe part. */
  private remember(raw: unknown): FileTaskDetail | null {
    const parsed = parseFileTaskDetailWithDigest(raw);
    if (!parsed) return null;
    const { detail, digest } = parsed;
    if (detail.plan && digest) this.digests.set(detail.plan.id, { taskId: detail.task.id, digest });
    return detail;
  }

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    timeoutMs: number,
    body: unknown,
    parse: (value: unknown) => T | null,
  ): Promise<ChatResult<T>> {
    return coreCall(this.backend, method, path, timeoutMs, body, parse);
  }
}

/** One authenticated call to the core, with the response validated by `parse`. Never throws. */
export async function coreCall<T>(
  backend: BackendManager,
  method: 'GET' | 'POST',
  path: string,
  timeoutMs: number,
  body: unknown,
  parse: (value: unknown) => T | null,
): Promise<ChatResult<T>> {
  try {
    const response = await backend.request(path, { method, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: await errorFromResponse(response) };
    const value = parse(await response.json());
    if (value === null) {
      return failure('invalid_core_response', 'The core returned data that does not match the contract.');
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CoreUnavailableError) return failure('core_unavailable', error.message);
    if (error instanceof Error && error.name === 'TimeoutError') {
      return failure('timeout', 'The core did not answer in time. Check the task list for its recorded state.');
    }
    return failure('core_unavailable', 'Could not reach the local core.');
  }
}

export function failure(code: string, detail: string): { ok: false; error: ChatError } {
  return { ok: false, error: { code, detail } };
}

const DESCRIPTIONS: Record<string, string> = {
  not_awaiting_approval: 'This task is no longer waiting for approval (it was already decided or cancelled).',
  plan_not_current: 'This plan was replaced by a newer one; review the current plan.',
  plan_digest_mismatch: 'The stored plan does not match what was shown; it was not executed.',
  plan_expired: 'The plan expired before approval. Re-scan the folder to get a fresh plan.',
  empty_plan: 'There is nothing to move in this plan.',
  task_not_open: 'This task is no longer open for that step.',
  task_already_finished: 'This task has already finished.',
  task_not_found: 'This task no longer exists.',
  database_unavailable: 'The local database is unavailable (see Diagnostics).',
  another_task_running: 'Another research task is still running; wait for it or stop it first.',
  task_not_running: 'This research task is not running.',
  not_awaiting_save: 'This report is not waiting to be saved (it was already saved or the task ended).',
  file_exists: 'A report with this name already exists in that folder; AEGIS never overwrites files.',
  protected_folder: 'That folder is a protected system or app folder; choose another one.',
  network_path: 'Network folders are not supported; choose a local folder.',
  link_in_path: 'The folder path contains a link or junction; choose an ordinary folder.',
  drive_root: 'Choose a folder inside the drive, not the drive itself.',
  not_found: 'The folder no longer exists.',
  root_changed: 'The folder changed while saving; nothing was overwritten. Try again.',
  verify_failed: 'The written file did not match the report; check it before use.',
  write_failed: 'The report could not be written to that folder.',
  memory_not_found: 'This memory no longer exists.',
  secret_detected: 'This looks like a password, key or token; AEGIS does not store secrets.',
  memory_too_long: 'A memory can be at most 500 characters.',
  empty_memory: 'A memory needs some text.',
  no_project: 'Set a current project first, or save the memory as global.',
  invalid_project: 'Project names use letters, digits, spaces, ".", "_" or "-" (max 40).',
  expiry_in_past: 'The expiry date must be in the future.',
  not_current: 'Only the current version of a memory can be changed; this one was already replaced or rejected.',
  not_reviewable: 'Only a candidate or disputed memory can be confirmed.',
  expired: 'This memory has expired; add it again if it is still true.',
  unchanged: 'The correction is identical to the current text.',
  duplicate_memory: 'Another current memory already says exactly this.',
  tool_outcome: 'A verified task outcome cannot be edited; reject or delete it instead.',
  not_a_vault: 'That folder is neither an Obsidian vault (no .obsidian folder) nor empty. Choose a vault or an empty folder.',
  vault_exists: 'That folder is already registered as a vault.',
  vault_not_found: 'This vault is no longer registered.',
  vault_unavailable: 'The vault folder could not be read (moved, replaced or inaccessible).',
  read_only_vault: 'This vault is read-only for AEGIS. Allow the AEGIS folder first.',
  write_area_invalid: 'The AEGIS folder in this vault is not an ordinary folder; nothing was written.',
  note_not_found: 'This note is not in the index.',
  note_deleted: 'This note was deleted from the vault.',
  not_a_repository: 'No readable source or text files were found in that folder.',
  inside_repository: 'The report cannot be saved inside the inspected repository; choose another folder.',
  vault_requires_local_model: 'Vault notes can only be given to a local model; approve without vault notes.',
  proposal_not_found: 'That memory proposal does not exist in this report.',
  no_report: 'This task has no report yet.',
};

async function errorFromResponse(response: Response): Promise<ChatError> {
  let code = `http_${response.status}`;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') code = body.detail;
    else if (response.status === 422) code = 'invalid_request';
  } catch {
    /* non-JSON error body: keep the HTTP status code */
  }
  return { code, detail: DESCRIPTIONS[code] ?? `The core refused the request (HTTP ${response.status}).` };
}
