import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import type { AppInfo, BackendStatus, IpcChannel } from '../src/shared/contracts';
import type { BackendManager } from './backend';
import { assertTrustedSender, type RendererLocation } from './security';

const STATUS_CHANGED: IpcChannel = 'aegis:backend:status-changed';

/**
 * Register the complete, fixed set of IPC handlers. None of them accept
 * arguments; any payload is rejected so the surface cannot grow implicitly.
 */
export function registerIpc(
  backend: BackendManager,
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

  handle<BackendStatus>('aegis:backend:get-status', () => backend.status);
  handle<BackendStatus>('aegis:backend:restart', () => backend.restart());
  handle<AppInfo>('aegis:app:get-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    isDevelopment: !app.isPackaged,
  }));

  backend.on('status', (status) => {
    const contents = appWindow();
    if (contents && !contents.isDestroyed()) contents.send(STATUS_CHANGED, status);
  });
}
