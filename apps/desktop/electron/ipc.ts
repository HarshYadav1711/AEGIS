import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  isUuid,
  parseInterpretArgs,
  parsePlanDecisionArgs,
  parseSendMessageArgs,
  type AppInfo,
  type BackendStatus,
  type IpcChannel,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import type { ChatService } from './chat';
import type { FileTaskService } from './files';
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

  backend.on('status', (status) => {
    const contents = appWindow();
    if (contents && !contents.isDestroyed()) contents.send(STATUS_CHANGED, status);
  });
}
