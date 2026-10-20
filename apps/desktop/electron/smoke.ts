import { app, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BackendManager } from './backend';

/**
 * Development-only end-to-end check of the real app (enabled by AEGIS_SMOKE=1
 * on unpackaged runs). It drives the actual window and core process and reads
 * the rendered DOM; nothing here simulates a state.
 *
 * Steps: renderer isolation probes → orb reaches its ready state from a live
 * /health (`idle` when a model is available, otherwise `error`) → unauthenticated
 * core requests are refused → malformed IPC arguments are refused → idle CPU
 * sample → core is killed and the orb must show `offline` → reconnect.
 *
 * With AEGIS_SMOKE_CHAT_MODEL=<installed Ollama model> it then runs a REAL model
 * conversation through the UI (see runChatScenario). Without it the chat
 * scenario is reported as NOT CONFIGURED, never as passed.
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
    const expectedKeys = [
      'cancelGeneration',
      'createConversation',
      'getAppInfo',
      'getBackendStatus',
      'getConversation',
      'listConversations',
      'onBackendStatus',
      'onChatEvent',
      'restartBackend',
      'sendMessage',
    ];
    record('bridge exposes only the typed API', JSON.stringify(probe.bridgeKeys) === JSON.stringify(expectedKeys), probe.bridgeKeys.join(','));

    const startUrl = contents.getURL();
    const opened = await evaluate<boolean>(`window.open('https://example.com') !== null`);
    record('window.open is denied', opened === false);
    await evaluate(`void (window.location.href = 'https://example.com/')`);
    await delay(500);
    record('navigation away from the app is blocked', contents.getURL() === startUrl, contents.getURL());

    const deadline = Date.now() + 25_000;
    while (backend.status.state !== 'online' && Date.now() < deadline) await delay(200);
    record('backend state online', backend.status.state === 'online', backend.status.detail);
    const provider = backend.status.health?.provider ?? null;
    const readyState = provider?.reachable && provider.models.length > 0 ? 'idle' : 'error';
    const online = await waitForOrb(readyState, 5_000);
    record(
      `orb shows ${readyState === 'idle' ? 'idle (model ready)' : 'error (no model available)'} from live /health`,
      online,
      `orb=${await orbState()} provider=${provider ? `${provider.id} reachable=${provider.reachable} models=${provider.models.length}` : 'none'}`,
    );
    await screenshot('01-online');

    const rejected = await evaluate<string[]>(`(async () => {
      const out = [];
      const attempts = [
        () => window.aegis.getConversation('../../etc'),
        () => window.aegis.cancelGeneration(42),
        () => window.aegis.sendMessage({ conversationId: 'x', requestId: 'y', content: 'hi', model: 'm' }),
        () => window.aegis.sendMessage({ conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), content: 'hi', model: 'm', tools: ['shell'] }),
      ];
      for (const attempt of attempts) {
        try { await attempt(); out.push('accepted'); } catch { out.push('rejected'); }
      }
      return out;
    })()`);
    record('malformed chat IPC arguments are rejected in main', rejected.every((r) => r === 'rejected'), rejected.join(','));

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
    record('preview off restores live state', await waitForOrb(readyState, 2_000));

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
    const recovered = await waitForOrb(readyState, 25_000);
    record(`orb returns to ${readyState} after reconnect`, recovered, `orb=${await orbState()}`);

    const chatModel = process.env.AEGIS_SMOKE_CHAT_MODEL?.trim();
    if (chatModel) {
      await runChatScenario({ evaluate, record, screenshot, waitForOrb, backend, model: chatModel });
    } else {
      console.log('[smoke] real-model chat scenario NOT CONFIGURED (set AEGIS_SMOKE_CHAT_MODEL)');
    }
  } catch (error) {
    record('smoke run completed without exceptions', false, error instanceof Error ? error.message : String(error));
  }

  record('renderer logged no console errors (incl. CSP violations)', consoleErrors.length === 0, consoleErrors.join(' | '));
  const ok = checks.every((c) => c.ok);
  console.log(`AEGIS_SMOKE_RESULT ${JSON.stringify({ ok, checks })}`);
  return ok ? 0 : 1;
}

interface ChatScenarioContext {
  evaluate: <T>(code: string) => Promise<T>;
  record: (name: string, ok: boolean, detail?: string) => void;
  screenshot: (name: string) => Promise<void>;
  waitForOrb: (expected: string, timeoutMs: number) => Promise<boolean>;
  backend: BackendManager;
  model: string;
}

/**
 * REAL model conversation through the actual UI: type → Send → orb thinking →
 * responding → succeeded; Stop mid-reply → cancelled; kill the core mid-reply →
 * offline, then the stored reply reads failed/interrupted after reconnect; the
 * saved conversation reopens from SQLite; a missing model fails visibly.
 */
async function runChatScenario(ctx: ChatScenarioContext): Promise<void> {
  const { evaluate, record, screenshot, waitForOrb, backend, model } = ctx;
  const LONG_PROMPT = 'Write a detailed 800-word story about a lighthouse keeper who discovers a hidden room.';

  // Record every orb state change so brief states (thinking) are not missed by polling.
  await evaluate(`(() => {
    window.__orbLog = [];
    const orb = document.querySelector('[data-orb-state]');
    new MutationObserver(() => window.__orbLog.push(orb.dataset.orbState))
      .observe(orb, { attributes: true, attributeFilter: ['data-orb-state'] });
  })()`);
  const orbLog = (reset = false) =>
    evaluate<string[]>(`(() => { const l = window.__orbLog.slice(); if (${reset}) window.__orbLog = []; return l; })()`);
  const lastAssistant = () =>
    evaluate<{ status: string | null; text: string; meta: string; error: string }>(`(() => {
      const items = [...document.querySelectorAll('.message[data-role="assistant"]')];
      const m = items[items.length - 1];
      return { status: m?.dataset.status ?? null, text: m?.querySelector('.message__text')?.textContent ?? '',
               meta: m?.querySelector('.message__meta')?.textContent ?? '',
               error: m?.querySelector('.message__error')?.textContent ?? '' };
    })()`);
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(150);
    }
    return false;
  };
  const typeAndSend = async (text: string) => {
    await evaluate(`(() => {
      const select = document.querySelector('#model-select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(model)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const box = document.querySelector('#composer-input');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(150);
    await evaluate(`document.querySelector('.composer button[type="submit"]').click()`);
  };
  const clickStop = () =>
    evaluate(`[...document.querySelectorAll('.composer button')].find((b) => b.textContent === 'Stop')?.click()`);

  const installed = backend.status.health?.provider?.models ?? [];
  record(`chat model ${model} is installed`, installed.includes(model), installed.join(','));
  if (!installed.includes(model)) return;

  // 1. A real reply.
  await evaluate(`document.querySelector('.conversations__new').click()`);
  await orbLog(true);
  const started = Date.now();
  await typeAndSend('In one short sentence, what is a desktop assistant?');
  const succeeded = await waitForOrb('succeeded', 240_000);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const log = await orbLog(true);
  const reply = await lastAssistant();
  record('real model reply completes (orb succeeded)', succeeded, `${seconds}s orb=${log.join('>')}`);
  const iThink = log.indexOf('thinking');
  const iResp = log.indexOf('responding');
  const iDone = log.indexOf('succeeded');
  record('orb went thinking → responding → succeeded', iThink >= 0 && iThink < iResp && iResp < iDone, log.join('>'));
  record(
    'reply is non-empty, complete and attributed to the model',
    reply.status === 'complete' && reply.text.trim().length > 0 && reply.meta.includes(model),
    `${reply.meta} | ${reply.text.slice(0, 160)}`,
  );
  await screenshot('04-real-reply');
  record('orb settles back to idle after success', await waitForOrb('idle', 6_000));

  // 2. User cancellation mid-reply.
  await typeAndSend(LONG_PROMPT);
  const responding = await waitForOrb('responding', 240_000);
  await delay(800);
  await clickStop();
  const cancelled = await waitForOrb('cancelled', 15_000);
  const stopped = await lastAssistant();
  record('Stop cancels a streaming reply (orb cancelled)', responding && cancelled, `orb=${(await orbLog(true)).join('>')}`);
  record('cancelled reply is marked stopped, not complete', stopped.status === 'cancelled' && /stopped/.test(stopped.meta), stopped.meta);
  await screenshot('05-cancelled');
  await waitForOrb('idle', 6_000);

  // 3. Core dies mid-reply.
  await typeAndSend(LONG_PROMPT);
  const responding2 = await waitForOrb('responding', 240_000);
  await delay(800);
  backend.killProcessForTest();
  const offline = await waitForOrb('offline', 10_000);
  const broken = await lastAssistant();
  record(
    'core killed mid-reply: orb offline, reply not shown as complete',
    responding2 && offline && broken.status === 'failed',
    `${broken.status} ${broken.error}`,
  );
  await screenshot('06-killed-mid-reply');
  await backend.restart();
  await waitForOrb('idle', 30_000);
  const reloaded = await waitFor(async () => (await lastAssistant()).error.includes('interrupted'), 10_000);
  record('after restart the stored reply reads failed/interrupted', reloaded, (await lastAssistant()).error);

  // 4. Persistence: reopen the conversation from the list after the restart.
  await evaluate(`document.querySelector('.conversations__new').click()`);
  await delay(300);
  await evaluate(`document.querySelector('.conversations__item').click()`);
  const reopened = await waitFor(async () => (await evaluate<number>(`document.querySelectorAll('.message').length`)) >= 6, 10_000);
  const statuses = await evaluate<string[]>(
    `[...document.querySelectorAll('.message[data-role="assistant"]')].map((m) => m.dataset.status)`,
  );
  record(
    'conversation reopens from SQLite after core restart',
    reopened && statuses.join(',') === 'complete,cancelled,failed',
    statuses.join(','),
  );
  await screenshot('07-reopened');

  // 5. A model the provider does not have fails visibly (real provider error through the bridge).
  const missing = await evaluate<{ type: string; code: string | null }>(`(async () => {
    const created = await window.aegis.createConversation();
    const r = await window.aegis.sendMessage({ conversationId: created.value.id, requestId: crypto.randomUUID(),
                                               content: 'hi', model: 'aegis-missing-model:0b' });
    return { type: r.type, code: r.error?.code ?? null };
  })()`);
  record('missing model is reported as failed/model_not_found', missing.type === 'failed' && missing.code === 'model_not_found', JSON.stringify(missing));
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
