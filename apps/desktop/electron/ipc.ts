import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  isUuid,
  parseSendMessageArgs,
  type AppInfo,
  type BackendStatus,
  type IpcChannel,
} from '../src/shared/contracts';
import type { BackendManager } from './backend';
import type { ChatService } from './chat';
import { assertTrustedSender, type RendererLocation } from './security';

const STATUS_CHANGED: IpcChannel = 'aegis:backend:status-changed';
const CHAT_EVENT: IpcChannel = 'aegis:chat:event';

/**
 * Register the complete, fixed set of IPC handlers. Each handler declares the
 * exact arguments it accepts and validates them; anything else is rejected so
 * the surface cannot grow implicitly.
 */
export function registerIpc(
  backend: BackendManager,
  chat: ChatService,
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

  backend.on('status', (status) => {
    const contents = appWindow();
    if (contents && !contents.isDestroyed()) contents.send(STATUS_CHANGED, status);
  });
}
