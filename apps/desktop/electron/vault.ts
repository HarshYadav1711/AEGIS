import { existsSync } from 'node:fs';
import path from 'node:path';

import { dialog, shell, type BrowserWindow } from 'electron';

import {
  parseVaultEnvelope,
  parseVaultList,
  parseVaultNoteEnvelope,
  parseVaultSearch,
  type AddVaultNoteArgs,
  type ChatResult,
  type VaultNote,
  type VaultRecord,
  type VaultSearchResult,
  type VaultWriteAreaArgs,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import { coreCall, failure } from './files';

const REQUEST_TIMEOUT_MS = 10_000;
/** Registering or re-scanning reads every changed note (bounded by the core at 5000 notes of 1 MB). */
const INDEX_TIMEOUT_MS = 120_000;

/**
 * Main-process client for vault indexing (M0A).
 *
 * Trust boundary: the only vault path that reaches the core comes from the
 * native folder picker opened here. A note is opened by id; its path comes
 * from the core, which re-checks it against the vault scope, and main opens
 * only an existing .md file inside that vault.
 */
export class VaultService {
  private readonly backend: BackendManager;
  private pickerOpen = false;

  constructor(backend: BackendManager) {
    this.backend = backend;
  }

  list(): Promise<ChatResult<VaultRecord[]>> {
    return coreCall(this.backend, 'GET', '/vaults', REQUEST_TIMEOUT_MS, undefined, parseVaultList);
  }

  async choose(window: BrowserWindow | null): Promise<ChatResult<VaultRecord | null>> {
    if (!window || window.isDestroyed()) return failure('no_window', 'The app window is not available.');
    if (this.pickerOpen) return failure('picker_open', 'A folder picker is already open.');
    this.pickerOpen = true;
    let picked: Electron.OpenDialogReturnValue;
    try {
      picked = await dialog.showOpenDialog(window, {
        title: 'Choose an Obsidian vault, or an empty folder for a new AEGIS vault',
        buttonLabel: 'Use this vault',
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
    } finally {
      this.pickerOpen = false;
    }
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: true, value: null };
    return coreCall(this.backend, 'POST', '/vaults', INDEX_TIMEOUT_MS, { root_path: folder }, parseVaultEnvelope);
  }

  reindex(vaultId: string): Promise<ChatResult<VaultRecord>> {
    return coreCall(this.backend, 'POST', `/vaults/${vaultId}/reindex`, INDEX_TIMEOUT_MS, undefined, parseVaultEnvelope);
  }

  setWriteArea(args: VaultWriteAreaArgs): Promise<ChatResult<VaultRecord>> {
    return coreCall(this.backend, 'POST', `/vaults/${args.vaultId}/write-area`, REQUEST_TIMEOUT_MS,
      { enabled: args.enabled }, parseVaultEnvelope);
  }

  remove(vaultId: string): Promise<ChatResult<true>> {
    return coreCall(this.backend, 'POST', `/vaults/${vaultId}/remove`, REQUEST_TIMEOUT_MS, undefined,
      (raw) => (typeof raw === 'object' && raw !== null ? true : null));
  }

  search(query: string): Promise<ChatResult<VaultSearchResult>> {
    return coreCall(this.backend, 'GET', `/vault-search?q=${encodeURIComponent(query)}`, INDEX_TIMEOUT_MS, undefined,
      parseVaultSearch);
  }

  addNote(args: AddVaultNoteArgs): Promise<ChatResult<VaultNote>> {
    return coreCall(this.backend, 'POST', `/vaults/${args.vaultId}/notes`, INDEX_TIMEOUT_MS,
      { title: args.title, body: args.body }, parseVaultNoteEnvelope);
  }

  async openNote(noteId: string): Promise<ChatResult<true>> {
    const note = await coreCall(this.backend, 'GET', `/vault-notes/${noteId}`, REQUEST_TIMEOUT_MS, undefined,
      parseVaultNoteEnvelope);
    if (!note.ok) return note;
    const located = await coreCall(this.backend, 'GET', `/vault-notes/${noteId}/path`, REQUEST_TIMEOUT_MS, undefined,
      (raw) => (typeof raw === 'object' && raw !== null && typeof (raw as { path?: unknown }).path === 'string'
        ? (raw as { path: string }).path : null));
    if (!located.ok) return located;
    const file = path.resolve(located.value);
    const root = path.resolve(note.value.vaultRoot);
    if (path.extname(file).toLowerCase() !== '.md' || !file.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      return failure('outside_vault', 'The note path is not a Markdown file inside its vault.');
    }
    if (!existsSync(file)) return failure('file_missing', 'The note is no longer at its indexed location.');
    const problem = await shell.openPath(file);
    return problem ? failure('open_failed', `Windows could not open the note: ${problem}`) : { ok: true, value: true };
  }
}
