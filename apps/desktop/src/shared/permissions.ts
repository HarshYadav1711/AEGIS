// Permission policy for the app window (Electron main applies it; kept free of Electron imports so it is unit-tested).

/**
 * The single permission the app grants (Phase 5): microphone-only media capture,
 * requested by the main frame of the app's own page. Camera, screen capture and
 * every other permission stay denied. The renderer starts capture only when the
 * user presses the microphone button and stops every track when they press it
 * again, when the recording limit is reached, or when the page goes away.
 */
export function isMicrophoneRequest(
  isAppUrl: (url: string) => boolean,
  permission: string,
  pageUrl: string,
  isMainFrame: boolean,
  mediaTypes: readonly string[] | undefined,
): boolean {
  return (
    permission === 'media' &&
    isMainFrame &&
    isAppUrl(pageUrl) &&
    Array.isArray(mediaTypes) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === 'audio')
  );
}
