import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  isUuid,
  parseInterpretArgs,
  parseInterpretResearchArgs,
  parseAddMemoryArgs,
  parseCorrectMemoryArgs,
  parseMemoryDecisionArgs,
  parseMemoryQueryArgs,
  parseMemorySettingsArgs,
  parseAddVaultNoteArgs,
  parseVaultQuery,
  parseVaultWriteAreaArgs,
  parsePlanDecisionArgs,
  parseRepoApproveArgs,
  parseRepoProposalArgs,
  parseSendMessageArgs,
  type AppInfo,
  type BackendStatus,
  type IpcChannel,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import type { ChatService } from './chat';
import type { FileTaskService } from './files';
import type { MemoryService } from './memory';
import type { VaultService } from './vault';
import type { RepoService } from './repo';
import type { ResearchService } from './research';
import { assertTrustedSender, type RendererLocation } from './security';

const STATUS_CHANGED: IpcChannel = 'aegis:backend:status-changed';
const CHAT_EVENT: IpcChannel = 'aegis:chat:event';
const FILES_EVENT: IpcChannel = 'aegis:files:event';

/**
 * Register the complete, fixed set of IPC handlers. Each handler declares the
 * exact arguments it accepts and validates them; anything else is rejected so
 * the surface cannot grow implicitly.
 */
export function registerIpc(
  backend: BackendManager,
  chat: ChatService,
  files: FileTaskService,
  research: ResearchService,
  memory: MemoryService,
  vault: VaultService,
  repo: RepoService,
  appWindow: () => WebContents | null,
  location: RendererLocation,
): void {
  const handle = <T>(channel: IpcChannel, run: () => T | Promise<T>): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedSender(event, appWindow, location);
      if (args.length > 0) throw new Error(`${channel} takes no arguments.`);
      return run();
    });
  };
  const handleOne = <A, T>(
    channel: IpcChannel,
    parse: (value: unknown) => A | null,
    run: (arg: A) => T | Promise<T>,
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedSender(event, appWindow, location);
      const arg = args.length === 1 ? parse(args[0]) : null;
      if (arg === null) throw new Error(`${channel} received invalid arguments.`);
      return run(arg);
    });
  };
  const uuidArg = (value: unknown): string | null => (isUuid(value) ? value : null);

  handle<BackendStatus>('aegis:backend:get-status', () => backend.status);
  handle<BackendStatus>('aegis:backend:restart', () => backend.restart());
  handle<AppInfo>('aegis:app:get-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    isDevelopment: !app.isPackaged,
  }));

  handle('aegis:chat:list-conversations', () => chat.listConversations());
  handle('aegis:chat:create-conversation', () => chat.createConversation());
  handleOne('aegis:chat:get-conversation', uuidArg, (id) => chat.getConversation(id));
  handleOne('aegis:chat:cancel', uuidArg, (id) => chat.cancel(id));
  handleOne('aegis:chat:send', parseSendMessageArgs, (args) =>
    chat.send(args, (progress) => {
      const contents = appWindow();
      if (contents && !contents.isDestroyed()) contents.send(CHAT_EVENT, progress);
    }),
  );

  // File tasks. No channel accepts a filesystem path: the folder comes from the native picker in main.
  handleOne('aegis:files:interpret', parseInterpretArgs, (args) => files.interpret(args));
  handleOne('aegis:files:choose-folder', uuidArg, (taskId) => {
    const contents = appWindow();
    const window = contents ? BrowserWindow.fromWebContents(contents) : null;
    return files.chooseFolder(taskId, window, (progress) => {
      if (contents && !contents.isDestroyed()) contents.send(FILES_EVENT, progress);
    });
  });
  handleOne('aegis:files:get-task', uuidArg, (taskId) => files.getTask(taskId));
  handle('aegis:files:list-tasks', () => files.listTasks());
  handleOne('aegis:files:approve', parsePlanDecisionArgs, (args) => files.approve(args));
  handleOne('aegis:files:reject', parsePlanDecisionArgs, (args) => files.reject(args));
  handleOne('aegis:files:cancel', uuidArg, (taskId) => files.cancel(taskId));
  handleOne('aegis:files:replan', uuidArg, (taskId) => files.replan(taskId));

  // Research. No channel accepts a URL list, a digest or a filesystem path: sources are parsed by the core
  // from the request text, the save folder comes from the native picker, the opened path from the journal.
  handleOne('aegis:research:interpret', parseInterpretResearchArgs, (args) => research.interpret(args));
  handleOne('aegis:research:get-task', uuidArg, (taskId) => research.getTask(taskId));
  handle('aegis:research:list-tasks', () => research.listTasks());
  handleOne('aegis:research:approve', uuidArg, (taskId) => research.approve(taskId));
  handleOne('aegis:research:reject', uuidArg, (taskId) => research.reject(taskId));
  handleOne('aegis:research:cancel', uuidArg, (taskId) => research.cancel(taskId));
  handleOne('aegis:research:save', uuidArg, (taskId) => {
    const contents = appWindow();
    return research.save(taskId, contents ? BrowserWindow.fromWebContents(contents) : null);
  });
  handleOne('aegis:research:open-report', uuidArg, (taskId) => research.openReport(taskId));

  // Memory. Arguments are text and ids only; the core decides status, verification and provenance.
  handleOne('aegis:memory:list', parseMemoryQueryArgs, (args) => memory.list(args));
  handleOne('aegis:memory:add', parseAddMemoryArgs, (args) => memory.add(args));
  handleOne('aegis:memory:correct', parseCorrectMemoryArgs, (args) => memory.correct(args));
  handleOne('aegis:memory:decide', parseMemoryDecisionArgs, (args) => memory.decide(args));
  handleOne('aegis:memory:set-settings', parseMemorySettingsArgs, (args) => memory.setSettings(args));

  // Vaults. No channel accepts a path: the vault comes from the native picker, a note is opened by id.
  handle('aegis:vault:list', () => vault.list());
  handle('aegis:vault:choose', () => {
    const contents = appWindow();
    return vault.choose(contents ? BrowserWindow.fromWebContents(contents) : null);
  });
  handleOne('aegis:vault:reindex', uuidArg, (id) => vault.reindex(id));
  handleOne('aegis:vault:set-write-area', parseVaultWriteAreaArgs, (args) => vault.setWriteArea(args));
  handleOne('aegis:vault:remove', uuidArg, (id) => vault.remove(id));
  handleOne('aegis:vault:search', parseVaultQuery, (query) => vault.search(query));
  handleOne('aegis:vault:add-note', parseAddVaultNoteArgs, (args) => vault.addNote(args));
  handleOne('aegis:vault:open-note', uuidArg, (id) => vault.openNote(id));

  // Repository investigation. No channel accepts a path, a file list, a note id or a digest: the repository and the
  // save folder come from native pickers in main, the files and notes are fixed by the core's approved plan.
  const windowOf = () => {
    const contents = appWindow();
    return contents ? BrowserWindow.fromWebContents(contents) : null;
  };
  handleOne('aegis:repo:interpret', parseInterpretResearchArgs, (args) => repo.interpret(args));
  handleOne('aegis:repo:choose-repo', uuidArg, (taskId) => repo.chooseRepo(taskId, windowOf()));
  handleOne('aegis:repo:get-task', uuidArg, (taskId) => repo.getTask(taskId));
  handle('aegis:repo:list-tasks', () => repo.listTasks());
  handleOne('aegis:repo:approve', parseRepoApproveArgs, (args) => repo.approve(args));
  handleOne('aegis:repo:reject', uuidArg, (taskId) => repo.reject(taskId));
  handleOne('aegis:repo:cancel', uuidArg, (taskId) => repo.cancel(taskId));
  handleOne('aegis:repo:save', uuidArg, (taskId) => repo.save(taskId, windowOf()));
  handleOne('aegis:repo:open-report', uuidArg, (taskId) => repo.openReport(taskId));
  handleOne('aegis:repo:accept-proposal', parseRepoProposalArgs, (args) => repo.acceptProposal(args));

  backend.on('status', (status) => {
    const contents = appWindow();
    if (contents && !contents.isDestroyed()) contents.send(STATUS_CHANGED, status);
  });
}
