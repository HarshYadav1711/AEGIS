import { app, BrowserWindow, Menu, type WebContents } from 'electron';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BackendManager, resolveBackendPaths } from './backend';
import { ChatService } from './chat';
import { registerIpc } from './ipc';
import { createRendererLocation, installAppHardening } from './security';
import { runSmokeTest } from './smoke';

// Only honour the dev server URL for unpackaged runs, and only on loopback.
const devServerUrl = (() => {
  const raw = process.env.AEGIS_DEV_SERVER_URL;
  if (!raw || app.isPackaged) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('AEGIS_DEV_SERVER_URL must be an http://localhost or http://127.0.0.1 URL.');
  }
  return url.toString();
})();
const smokeMode = process.env.AEGIS_SMOKE === '1' && !app.isPackaged;

// app.getAppPath() is apps/desktop when running from source.
const desktopRoot = app.getAppPath();
const repoRoot = path.resolve(desktopRoot, '..', '..');
const indexFileUrl = pathToFileURL(path.join(desktopRoot, 'dist', 'index.html')).toString();
const location = createRendererLocation(devServerUrl, indexFileUrl);

if (smokeMode) {
  // Smoke runs create real conversations; keep them out of the user's own profile and database.
  app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'aegis-smoke-')));
}

app.enableSandbox();
let mainWindow: BrowserWindow | null = null;
const appWindow = (): WebContents | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (app.isPackaged) {
    // Phase 0 runs from source only; a packaged layout for the core is not defined yet.
    console.error('[aegis-desktop] packaged builds are not supported in Phase 0');
  }

  installAppHardening(location, devServerUrl);
  if (!devServerUrl) Menu.setApplicationMenu(null);

  const backend = new BackendManager(resolveBackendPaths(repoRoot, app.getPath('userData')));
  const chat = new ChatService(backend);
  registerIpc(backend, chat, appWindow, location);

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void backend.stop().finally(() => app.quit());
  });
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('window-all-closed', () => app.quit());

  mainWindow = createWindow();
  backend.start();

  if (smokeMode) {
    const code = await runSmokeTest(mainWindow, backend);
    quitting = true;
    await backend.stop();
    app.exit(code);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    show: false,
    title: 'AEGIS',
    backgroundColor: '#0f1012',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });
  void window.loadURL(location.url);
  return window;
}
