import { app, session, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { isMicrophoneRequest } from '../src/shared/permissions';

/**
 * Describes the single renderer location the app is allowed to show.
 * Development: the Vite dev server origin. Production: the bundled index.html.
 */
export interface RendererLocation {
  url: string;
  isAllowed(candidate: string): boolean;
}

export function createRendererLocation(devServerUrl: string | undefined, indexFileUrl: string): RendererLocation {
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    return {
      url: devServerUrl,
      isAllowed: (candidate) => safeOrigin(candidate) === origin,
    };
  }
  const expected = new URL(indexFileUrl);
  return {
    url: indexFileUrl,
    isAllowed: (candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'file:' && parsed.pathname === expected.pathname;
      } catch {
        return false;
      }
    },
  };
}

function safeOrigin(candidate: string): string | null {
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/** Dev-only CSP. Vite's HMR client and React refresh preamble need inline script/style and a websocket. */
function devContentSecurityPolicy(devServerUrl: string): string {
  const { host } = new URL(devServerUrl);
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * App-wide hardening that must be installed before any window exists:
 * deny every permission request except microphone capture for the app page,
 * block navigation away from the app, block new windows and <webview>, and
 * (in dev) attach a CSP header. The production CSP is a <meta> tag injected
 * into index.html at build time.
 */
export function installAppHardening(location: RendererLocation, devServerUrl: string | undefined): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const pageUrl = contents.getURL();
    callback(isMicrophoneRequest(location.isAllowed, permission, pageUrl, details.isMainFrame, mediaTypes));
  });
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    // Device labels for the microphone picker need the check to pass for audio; nothing else does.
    const pageUrl = contents?.getURL() ?? '';
    const mediaType = 'mediaType' in details ? details.mediaType : undefined;
    return isMicrophoneRequest(location.isAllowed, permission, pageUrl, details.isMainFrame, mediaType ? [mediaType] : undefined);
  });
  ses.setDevicePermissionHandler(() => false);

  if (devServerUrl) {
    const csp = devContentSecurityPolicy(devServerUrl);
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
      });
    });
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!location.isAllowed(url)) {
        event.preventDefault();
        console.warn('[aegis-desktop] blocked navigation to a non-app URL');
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!location.isAllowed(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

/**
 * Accept an IPC call only from the main frame of the app window, currently
 * showing the app's own URL. Throws otherwise (the renderer sees a rejection).
 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  appWindow: () => WebContents | null,
  location: RendererLocation,
): void {
  const expected = appWindow();
  const frame = event.senderFrame;
  const trusted =
    expected !== null &&
    event.sender.id === expected.id &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    location.isAllowed(frame.url);
  if (!trusted) throw new Error('Rejected IPC call from an untrusted sender.');
}
