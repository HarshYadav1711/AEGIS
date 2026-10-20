import { app, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BackendManager } from './backend';

/**
 * Development-only end-to-end check of the real app (enabled by AEGIS_SMOKE=1
 * on unpackaged runs). It drives the actual window and core process and reads
 * the rendered DOM; nothing here simulates a state.
 *
 * Steps: renderer isolation probes → orb reaches `idle` from a live /health →
 * unauthenticated core requests are refused → idle CPU sample → core is killed
 * and the orb must show `offline` → reconnect brings it back to `idle`.
 * Prints one `AEGIS_SMOKE_RESULT <json>` line and returns the exit code.
 */
export async function runSmokeTest(window: BrowserWindow, backend: BackendManager): Promise<number> {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const record = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const shotDir = process.env.AEGIS_SMOKE_SCREENSHOT_DIR;
  const contents = window.webContents;
  const consoleErrors: string[] = [];
  contents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message.slice(0, 200));
  });
  const evaluate = <T>(code: string): Promise<T> => contents.executeJavaScript(code, true) as Promise<T>;
  const orbState = () => evaluate<string | null>(`document.querySelector('[data-orb-state]')?.dataset.orbState ?? null`);

  async function waitForOrb(expected: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await orbState()) === expected) return true;
      await delay(200);
    }
    return false;
  }

  /** Change a React-controlled <select> the way a user would (native setter + change event). */
  async function selectOption(selector: string, value: string): Promise<void> {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await delay(100);
  }

  const canvasHash = () =>
    evaluate<string>(`(() => {
      const url = document.querySelector('.orb__canvas')?.toDataURL() ?? '';
      let h = 0;
      for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
      return url ? String(h) : '';
    })()`);

  async function screenshot(name: string): Promise<void> {
    if (!shotDir) return;
    await delay(400); // let the orb settle into the new state
    const image = await contents.capturePage();
    writeFileSync(path.join(shotDir, `${name}.png`), image.toPNG());
  }

  try {
    if (contents.isLoading()) await new Promise<void>((resolve) => contents.once('did-finish-load', () => resolve()));

    const probe = await evaluate<{ require: string; process: string; bridgeKeys: string[] }>(
      `({ require: typeof require, process: typeof process, bridgeKeys: Object.keys(window.aegis ?? {}).sort() })`,
    );
    record('renderer has no require()', probe.require === 'undefined', probe.require);
    record('renderer has no process', probe.process === 'undefined', probe.process);
    const expectedKeys = ['getAppInfo', 'getBackendStatus', 'onBackendStatus', 'restartBackend'];
    record('bridge exposes only the typed API', JSON.stringify(probe.bridgeKeys) === JSON.stringify(expectedKeys), probe.bridgeKeys.join(','));

    const startUrl = contents.getURL();
    const opened = await evaluate<boolean>(`window.open('https://example.com') !== null`);
    record('window.open is denied', opened === false);
    await evaluate(`void (window.location.href = 'https://example.com/')`);
    await delay(500);
    record('navigation away from the app is blocked', contents.getURL() === startUrl, contents.getURL());

    const online = await waitForOrb('idle', 25_000);
    record('orb reaches idle from live /health', online, `orb=${await orbState()} backend=${backend.status.state}`);
    record('backend state online', backend.status.state === 'online', backend.status.detail);
    await screenshot('01-online');

    const port = backend.port;
    if (port !== null) {
      const noAuth = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status, () => -1);
      record('core rejects request without token', noAuth === 401, `HTTP ${noAuth}`);
      const badAuth = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
      }).then((r) => r.status, () => -1);
      record('core rejects wrong token', badAuth === 401, `HTTP ${badAuth}`);
    } else {
      record('core port known', false);
    }

    const cpu = await sampleIdleCpu(5_000);
    record('idle CPU sampled', true, cpu);

    // Development preview must be visibly labelled and must not touch the live backend state.
    await selectOption('#orb-preview', 'thinking');
    const preview = await evaluate<{ state: string | null; flag: string | null; badge: string | null }>(
      `(() => { const o = document.querySelector('[data-orb-state]');
        return { state: o?.dataset.orbState ?? null, flag: o?.dataset.orbPreview ?? null,
                 badge: o?.querySelector('.orb__preview-badge')?.textContent ?? null }; })()`,
    );
    record(
      'preview state is labelled as simulated',
      preview.state === 'thinking' && preview.flag === 'true' && /simulated/i.test(preview.badge ?? ''),
      JSON.stringify(preview),
    );
    record('preview leaves backend state untouched', backend.status.state === 'online', backend.status.state);
    await screenshot('03-preview-thinking');
    await selectOption('#orb-preview', '');
    record('preview off restores live state', await waitForOrb('idle', 2_000));

    // Reduced motion: the canvas must stop changing between frames.
    await selectOption('#motion-pref', 'reduced');
    await delay(300);
    const frameA = await canvasHash();
    await delay(700);
    const frameB = await canvasHash();
    record('reduced motion renders a static orb', frameA === frameB && frameA.length > 0);
    await selectOption('#motion-pref', 'full');
    await delay(300);
    const frameC = await canvasHash();
    await delay(300);
    record('full motion animates the orb', frameC !== (await canvasHash()));
    await selectOption('#motion-pref', 'system');

    backend.killProcessForTest();
    const offline = await waitForOrb('offline', 10_000);
    record('orb shows offline after core is killed', offline, `orb=${await orbState()} detail=${backend.status.detail}`);
    await screenshot('02-offline');

    await backend.restart();
    const recovered = await waitForOrb('idle', 25_000);
    record('orb returns to idle after reconnect', recovered, `orb=${await orbState()}`);
  } catch (error) {
    record('smoke run completed without exceptions', false, error instanceof Error ? error.message : String(error));
  }

  record('renderer logged no console errors (incl. CSP violations)', consoleErrors.length === 0, consoleErrors.join(' | '));
  const ok = checks.every((c) => c.ok);
  console.log(`AEGIS_SMOKE_RESULT ${JSON.stringify({ ok, checks })}`);
  return ok ? 0 : 1;
}

/** Average CPU% per Electron process type over a window, from Electron's own metrics. */
async function sampleIdleCpu(windowMs: number): Promise<string> {
  app.getAppMetrics(); // first call primes the counters
  await delay(windowMs);
  return app
    .getAppMetrics()
    .map((m) => `${m.type}:${m.cpu.percentCPUUsage.toFixed(1)}%`)
    .join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
