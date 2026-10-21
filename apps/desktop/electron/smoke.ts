import { app, dialog, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
 *
 * With AEGIS_SMOKE_RESEARCH_MODEL=<model> and AEGIS_SMOKE_RESEARCH_DIR=<existing folder> it runs a
 * REAL public-web research task through the UI (see runResearchScenario); only the native folder
 * dialog is answered by this harness, with that folder.
 * With AEGIS_SMOKE_MEMORY_MODEL=<model> it runs the REAL memory scenario through the UI (see
 * runMemoryScenario): remember in chat -> restart -> recall -> correct in the Memory panel -> recall.
 * AEGIS_SMOKE_MEMORY_PHASE=remember|recall splits it across two app launches that share
 * AEGIS_SMOKE_USER_DATA, so the restart in between is a full application restart.
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
      'addMemory',
      'approveFilePlan',
      'approveResearchPlan',
      'cancelFileTask',
      'cancelGeneration',
      'cancelResearchTask',
      'chooseFolderForTask',
      'correctMemory',
      'createConversation',
      'decideMemory',
      'getAppInfo',
      'getBackendStatus',
      'getConversation',
      'getFileTask',
      'getResearchTask',
      'interpretFileRequest',
      'interpretResearchRequest',
      'listConversations',
      'listFileTasks',
      'listMemories',
      'listResearchTasks',
      'onBackendStatus',
      'onChatEvent',
      'onFileTaskEvent',
      'openResearchReport',
      'rejectFilePlan',
      'rejectResearchPlan',
      'replanFileTask',
      'restartBackend',
      'saveResearchReport',
      'sendMessage',
      'setMemorySettings',
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

    // File IPC accepts ids only: no channel lets the renderer name a folder, a digest or an approval flag.
    const fileRejected = await evaluate<string[]>(`(async () => {
      const out = [];
      const id = crypto.randomUUID();
      const attempts = [
        () => window.aegis.chooseFolderForTask('C:/Windows'),
        () => window.aegis.approveFilePlan({ taskId: id, planId: id, planDigest: '0'.repeat(64) }),
        () => window.aegis.approveFilePlan({ taskId: id, planId: id, approved: true }),
        () => window.aegis.interpretFileRequest({ text: 'organize files', model: null, rootPath: 'C:/' }),
        () => window.aegis.getFileTask('../../etc'),
      ];
      for (const attempt of attempts) {
        try { await attempt(); out.push('accepted'); } catch { out.push('rejected'); }
      }
      return out;
    })()`);
    record(
      'malformed file IPC arguments (paths, digests, approval flags) are rejected',
      fileRejected.every((r) => r === 'rejected'),
      fileRejected.join(','),
    );
    const unknownPlan = await evaluate<{ ok: boolean; code?: string }>(`(async () => {
      const id = crypto.randomUUID();
      const r = await window.aegis.approveFilePlan({ taskId: id, planId: id });
      return r.ok ? { ok: true } : { ok: false, code: r.error.code };
    })()`);
    record(
      'approval of a plan main never showed is refused',
      !unknownPlan.ok && unknownPlan.code === 'unknown_plan',
      JSON.stringify(unknownPlan),
    );
    const unknownTask = await evaluate<{ ok: boolean; code?: string }>(`(async () => {
      const r = await window.aegis.chooseFolderForTask(crypto.randomUUID());
      return r.ok ? { ok: true } : { ok: false, code: r.error.code };
    })()`);
    record(
      'folder picker is not opened for a task the core does not know',
      !unknownTask.ok && unknownTask.code === 'task_not_found',
      JSON.stringify(unknownTask),
    );

    // Research IPC accepts the request text, a model name and task ids only: no URL list, digest or path.
    const researchRejected = await evaluate<string[]>(`(async () => {
      const out = [];
      const id = crypto.randomUUID();
      const attempts = [
        () => window.aegis.interpretResearchRequest({ text: 'research x', model: 'm', urls: ['http://127.0.0.1/'] }),
        () => window.aegis.interpretResearchRequest({ text: 'research x', model: null }),
        () => window.aegis.approveResearchPlan({ taskId: id, planDigest: '0'.repeat(64) }),
        () => window.aegis.saveResearchReport('C:/Windows'),
        () => window.aegis.openResearchReport('../../report.md'),
      ];
      for (const attempt of attempts) {
        try { await attempt(); out.push('accepted'); } catch { out.push('rejected'); }
      }
      return out;
    })()`);
    record(
      'malformed research IPC arguments (URL lists, digests, paths) are rejected',
      researchRejected.every((r) => r === 'rejected'),
      researchRejected.join(','),
    );
    const privateUrls = await evaluate<{ ok: boolean; intent?: string; task?: boolean; codes?: string[] }>(`(async () => {
      const r = await window.aegis.interpretResearchRequest({
        text: 'research http://127.0.0.1:8080/admin https://localhost/ https://192.168.1.1/ https://printer.local/',
        model: 'smoke-model',
      });
      return r.ok
        ? { ok: true, intent: r.value.intent, task: r.value.task !== null, codes: r.value.refused.map((x) => x.code) }
        : { ok: false };
    })()`);
    record(
      'private / local research URLs are refused before any fetch (no task created)',
      privateUrls.ok && privateUrls.intent === 'research' && privateUrls.task === false && privateUrls.codes?.length === 4,
      JSON.stringify(privateUrls),
    );
    const researchUnknown = await evaluate<string[]>(`(async () => {
      const id = crypto.randomUUID();
      const a = await window.aegis.approveResearchPlan(id);
      const o = await window.aegis.openResearchReport(id);
      return [a.ok ? 'ok' : a.error.code, o.ok ? 'ok' : o.error.code];
    })()`);
    record(
      'research approval / open of an unknown task is refused',
      researchUnknown[0] === 'unknown_plan' && researchUnknown[1] === 'task_not_found',
      researchUnknown.join(','),
    );

    // Memory IPC accepts text and ids only: no status, verification, provenance or raw scope.
    const memoryRejected = await evaluate<string[]>(`(async () => {
      const out = [];
      const id = crypto.randomUUID();
      const attempts = [
        () => window.aegis.addMemory({ content: 'x', kind: 'fact', subject: null, scope: 'global', expiresOn: null, status: 'active' }),
        () => window.aegis.addMemory({ content: 'x', kind: 'experience', subject: null, scope: 'global', expiresOn: null }),
        () => window.aegis.addMemory({ content: 'x', kind: 'fact', subject: null, scope: 'project:other', expiresOn: null }),
        () => window.aegis.correctMemory({ id: '../1', content: 'x' }),
        () => window.aegis.decideMemory({ id, action: 'activate' }),
        () => window.aegis.setMemorySettings({ captureEnabled: 'yes', project: null }),
        () => window.aegis.listMemories({ query: 'x', includeHistory: false, sql: '1=1' }),
      ];
      for (const attempt of attempts) {
        try { await attempt(); out.push('accepted'); } catch { out.push('rejected'); }
      }
      return out;
    })()`);
    record(
      'malformed memory IPC arguments (status, kind, raw scope, ids) are rejected',
      memoryRejected.every((r) => r === 'rejected'),
      memoryRejected.join(','),
    );
    const memorySecret = await evaluate<{ ok: boolean; code?: string }>(`(async () => {
      const r = await window.aegis.addMemory({ content: 'my password is hunter2', kind: 'fact', subject: null,
                                               scope: 'global', expiresOn: null });
      return r.ok ? { ok: true } : { ok: false, code: r.error.code };
    })()`);
    record(
      'a secret typed as a memory is refused by the core',
      !memorySecret.ok && memorySecret.code === 'secret_detected',
      JSON.stringify(memorySecret),
    );

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
    const memoryModel = process.env.AEGIS_SMOKE_MEMORY_MODEL?.trim();
    if (memoryModel) {
      const phase = process.env.AEGIS_SMOKE_MEMORY_PHASE?.trim() || 'all';
      await runMemoryScenario({ evaluate, record, screenshot, waitForOrb, backend, model: memoryModel }, phase, readyState);
    } else {
      console.log('[smoke] real memory scenario NOT CONFIGURED (set AEGIS_SMOKE_MEMORY_MODEL)');
    }
    const researchModel = process.env.AEGIS_SMOKE_RESEARCH_MODEL?.trim();
    const researchDir = process.env.AEGIS_SMOKE_RESEARCH_DIR?.trim();
    if (researchModel && researchDir) {
      await runResearchScenario({ evaluate, record, screenshot, waitForOrb, backend, model: researchModel }, researchDir);
    } else {
      console.log('[smoke] real research scenario NOT CONFIGURED (set AEGIS_SMOKE_RESEARCH_MODEL and _DIR)');
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

const RESEARCH_REQUEST =
  process.env.AEGIS_SMOKE_RESEARCH_REQUEST?.trim() ||
  'Research how asyncio tasks are cancelled and what TaskGroup does on errors ' +
    'https://docs.python.org/3/library/asyncio-task.html https://en.wikipedia.org/wiki/Async/await ' +
    'http://127.0.0.1:8080/admin';

/**
 * REAL research through the actual UI: type a request with public URLs (plus one local URL that must be
 * refused) → plan shown, nothing read → Approve → orb executing while pages are read → thinking while
 * the model writes → report with verified findings → Save (folder dialog answered by this harness) →
 * file on disk matches the report hash → Open report (real shell.openPath) → a request naming only
 * private/local URLs is refused without a task.
 */
async function runResearchScenario(ctx: ChatScenarioContext, saveDir: string): Promise<void> {
  const { evaluate, record, screenshot, waitForOrb, backend, model } = ctx;
  const installed = backend.status.health?.provider?.models ?? [];
  record(`research model ${model} is installed`, installed.includes(model), installed.join(','));
  if (!installed.includes(model)) return;

  await evaluate(`(() => {
    window.__orbLog = [];
    const orb = document.querySelector('[data-orb-state]');
    new MutationObserver(() => window.__orbLog.push(orb.dataset.orbState))
      .observe(orb, { attributes: true, attributeFilter: ['data-orb-state'] });
  })()`);
  const orbLog = () => evaluate<string[]>('window.__orbLog.slice()');
  const panelText = () => evaluate<string>(`document.querySelector('section.task')?.innerText ?? ''`);
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  const button = (label: string) =>
    evaluate<boolean>(
      `!![...document.querySelectorAll('section.task button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}) && !b.disabled)`,
    );
  const click = (label: string) =>
    evaluate(
      `[...document.querySelectorAll('section.task button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))?.click()`,
    );
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(250);
    }
    return false;
  };
  const send = async (text: string) => {
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

  await send(RESEARCH_REQUEST);
  const planned = await waitFor(() => button('Approve and read'), 120_000);
  const plan = flat(await panelText());
  record(
    'research plan shown before anything is read; local URL refused',
    planned && plan.includes('Refused') && plan.includes('127.0.0.1') && (await waitForOrb('waiting_approval', 2_000)),
    plan.slice(0, 500),
  );
  await screenshot('08-research-plan');

  const started = Date.now();
  await click('Approve and read');
  const reading = await waitFor(async () => (await panelText()).includes('Reading approved sources'), 20_000);
  await screenshot('09-research-reading');
  const ready = await waitFor(() => button('Save report'), 480_000);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const log = await orbLog();
  record(
    'research ran: orb executing → thinking → waiting for save',
    reading && ready && log.indexOf('executing') >= 0 && log.indexOf('executing') < log.lastIndexOf('thinking'),
    `${seconds}s orb=${log.join('>')}`,
  );
  const findings = await evaluate<string[]>(
    `[...document.querySelectorAll('.finding')].map((f) => f.dataset.status + ': ' + f.innerText.slice(0, 200))`,
  );
  const sources = await evaluate<string[]>(`[...document.querySelectorAll('.sources__item')].map((s) => s.innerText)`);
  record(
    'report shows verified findings and source provenance',
    findings.length > 0 && sources.length > 0,
    `${findings.map(flat).join(' || ')} ## ${sources.map(flat).join(' || ')}`,
  );
  await evaluate(`document.querySelector('.report')?.scrollIntoView({ block: 'start' })`);
  await screenshot('10-research-report');

  // Harness-only: answer the native folder dialog with the configured folder.
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [saveDir] })) as unknown as typeof dialog.showOpenDialog;
  await click('Save report');
  const saved = await waitFor(() => button('Open report'), 30_000);
  const detail = await evaluate<{ path: string | null; sha: string | null; status: string }>(`(async () => {
    const list = await window.aegis.listResearchTasks();
    const latest = list.ok ? list.value[0] : null;
    const d = latest ? await window.aegis.getResearchTask(latest.id) : null;
    return d && d.ok
      ? { path: d.value.task.savedPath, sha: d.value.task.reportSha256, status: d.value.task.status }
      : { path: null, sha: null, status: 'unknown' };
  })()`);
  const readSaved = (file: string | null) => {
    try {
      return file ? readFileSync(file, 'utf8') : '';
    } catch {
      return '';
    }
  };
  const onDisk = readSaved(detail.path);
  const hashOk = createHash('sha256').update(onDisk, 'utf8').digest('hex') === detail.sha;
  record(
    'report saved in the chosen folder and matches its hash',
    saved && detail.status === 'completed' && hashOk && !!detail.path?.startsWith(saveDir) &&
      onDisk.startsWith('# Research report'),
    `${detail.path} (${onDisk.length} chars)`,
  );
  await evaluate(`[...document.querySelectorAll('section.task button')].find((b) => b.textContent === 'Open report')?.scrollIntoView({ block: 'end' })`);
  await screenshot('11-research-saved');
  await click('Open report');
  await delay(1500);
  const openError = await evaluate<string>(`document.querySelector('section.task [role="alert"]')?.textContent ?? ''`);
  record('Open report hands the saved file to Windows without error', openError === '', openError);

  await click('Close task');
  await waitForOrb('idle', 8_000);
  await send('research http://127.0.0.1:8080/admin https://localhost/ https://192.168.1.1/ https://printer.local/');
  const refused = await waitFor(async () => (await panelText()).includes('no readable source'), 30_000);
  record(
    'private/local-only research request is refused in the UI with no task',
    refused,
    flat(await panelText()).slice(0, 400),
  );
  await screenshot('12-research-refused');
  await click('Close');
}

/**
 * REAL memory round trip through the actual UI and a real model. Only the stored memory and the
 * model's real reply are checked; nothing is injected. Phases: 'all' (core process restart in the
 * middle), or 'remember' / 'recall' in two launches sharing AEGIS_SMOKE_USER_DATA (full app restart).
 */
async function runMemoryScenario(ctx: ChatScenarioContext, phase: string, readyState: string): Promise<void> {
  const { evaluate, record, screenshot, waitForOrb, backend, model } = ctx;
  const QUESTION = 'What is my test folder name? Answer with the name only.';
  const installed = backend.status.health?.provider?.models ?? [];
  record(`memory model ${model} is installed`, installed.includes(model), installed.join(','));
  if (!installed.includes(model)) return;

  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await delay(200);
    }
    return false;
  };
  const setValue = (selector: string, value: string) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const ask = async (text: string): Promise<{ ok: boolean; reply: string; seconds: string }> => {
    await waitForOrb(readyState, 10_000);
    await evaluate(`document.querySelector('.conversations__new').click()`);
    await delay(200);
    await evaluate(`(() => {
      const select = document.querySelector('#model-select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(model)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await setValue('#composer-input', text);
    await delay(150);
    const started = Date.now();
    await evaluate(`document.querySelector('.composer button[type="submit"]').click()`);
    const ok = await waitForOrb('succeeded', 240_000);
    const reply = await evaluate<string>(`(() => {
      const items = [...document.querySelectorAll('.message[data-role="assistant"]')];
      return items[items.length - 1]?.querySelector('.message__text')?.textContent ?? '';
    })()`);
    return { ok, reply, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  };
  const items = () =>
    evaluate<{ id: string; status: string; text: string; meta: string }[]>(`[...document.querySelectorAll('.memory__item')]
      .map((li) => ({ id: li.dataset.memoryId, status: li.dataset.status,
                      text: li.querySelector('.memory__content')?.textContent ?? '',
                      meta: [...li.querySelectorAll('.memory__meta')].map((m) => m.textContent).join(' | ') }))`);
  const openPanel = () =>
    evaluate(`(() => { const d = document.querySelector('details.memory'); if (!d.open) d.open = true; })()`);

  if (phase === 'all' || phase === 'remember') {
    const remembered = await ask('Remember: my test folder name is Zephyr-42');
    record('chat "Remember: ..." turn completes with the real model', remembered.ok,
      `${remembered.seconds}s ${remembered.reply.slice(0, 160)}`);
    await openPanel();
    const stored = await waitFor(
      async () => (await items()).some((m) => m.status === 'active' && m.text.includes('Zephyr-42')), 10_000);
    const item = (await items()).find((m) => m.text.includes('Zephyr-42'));
    record(
      'Memory panel shows it as an active statement from the chat message',
      stored && !!item && /stated by you/.test(item.meta) && /from chat message/.test(item.meta),
      JSON.stringify(item ?? null),
    );
    await screenshot('13-memory-remembered');
  }
  if (phase === 'all') {
    backend.killProcessForTest();
    record('core stopped for the restart', await waitForOrb('offline', 10_000));
    await backend.restart();
    record('core restarted', await waitForOrb(readyState, 30_000));
  }
  if (phase === 'all' || phase === 'recall') {
    const recalled = await ask(QUESTION);
    record('after restart the real model recalls the stored memory', recalled.ok && /zephyr-42/i.test(recalled.reply),
      `${recalled.seconds}s ${recalled.reply.slice(0, 160)}`);

    await openPanel();
    await waitFor(async () => (await items()).some((m) => m.text.includes('Zephyr-42')), 10_000);
    const target = (await items()).find((m) => m.status === 'active' && m.text.includes('Zephyr-42'));
    record('the remembered memory is still listed after the restart', !!target, JSON.stringify(target ?? null));
    if (!target) return;
    const li = `.memory__item[data-memory-id="${target.id}"]`;
    const clickIn = (label: string) =>
      evaluate(`[...document.querySelectorAll('${li} button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
    await clickIn('Correct');
    await delay(200);
    await setValue(`#correct-${target.id}`, 'My test folder name is Orion-7');
    await delay(150);
    await clickIn('Save correction');
    const corrected = await waitFor(
      async () => (await items()).some((m) => m.status === 'active' && m.text.includes('Orion-7')), 10_000);
    await evaluate(`[...document.querySelectorAll('details.memory label')]
      .find((l) => l.textContent.includes('Show history')).querySelector('input').click()`);
    await waitFor(async () => (await items()).some((m) => m.id === target.id), 5_000);
    const old = (await items()).find((m) => m.id === target.id);
    record(
      'correction in the panel creates a new version; the old one is shown as superseded',
      corrected && old?.status === 'superseded' && /superseded by a newer version/.test(old.meta),
      JSON.stringify(old ?? null),
    );
    await screenshot('14-memory-corrected');

    const after = await ask(QUESTION);
    record(
      'after the correction the real model answers with the corrected value only',
      after.ok && /orion-7/i.test(after.reply) && !/zephyr/i.test(after.reply),
      `${after.seconds}s ${after.reply.slice(0, 160)}`,
    );
    await screenshot('15-memory-recalled-corrected');
  }
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
