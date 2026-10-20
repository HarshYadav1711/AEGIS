// Sandboxed preload. It may only require 'electron', so the contracts module is
// imported for types alone and channel names are inlined (checked by `satisfies`).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { AegisBridge, AppInfo, BackendStatus, IpcChannel } from '../src/shared/contracts';

const channels = {
  getStatus: 'aegis:backend:get-status',
  restart: 'aegis:backend:restart',
  statusChanged: 'aegis:backend:status-changed',
  appInfo: 'aegis:app:get-info',
} as const satisfies Record<string, IpcChannel>;

const bridge: AegisBridge = {
  getBackendStatus: () => ipcRenderer.invoke(channels.getStatus) as Promise<BackendStatus>,
  restartBackend: () => ipcRenderer.invoke(channels.restart) as Promise<BackendStatus>,
  getAppInfo: () => ipcRenderer.invoke(channels.appInfo) as Promise<AppInfo>,
  onBackendStatus(listener) {
    // Wrap so the renderer never receives the IpcRendererEvent (which exposes `sender`).
    const wrapped = (_event: IpcRendererEvent, status: BackendStatus) => listener(status);
    ipcRenderer.on(channels.statusChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(channels.statusChanged, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('aegis', Object.freeze(bridge));
