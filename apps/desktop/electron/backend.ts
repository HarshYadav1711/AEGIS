import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { parseHealthResponse, type BackendStatus } from '../src/shared/contracts';

const READY_PREFIX = 'AEGIS_READY ';
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 1_500;
const FAILURES_BEFORE_OFFLINE = 2;
const SHUTDOWN_GRACE_MS = 3_000;

/** Environment variables the core is allowed to inherit. Everything else is dropped. */
const INHERITED_ENV = ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC'];

export interface BackendPaths {
  /** services/core directory (working directory of the core). */
  coreDir: string;
  /** Explicit interpreter path inside the project's virtual environment. */
  python: string;
  /** Directory where the core keeps its SQLite database. */
  dataDir: string;
}

export function resolveBackendPaths(repoRoot: string, dataDir: string): BackendPaths {
  const coreDir = path.join(repoRoot, 'services', 'core');
  const python =
    process.platform === 'win32'
      ? path.join(coreDir, '.venv', 'Scripts', 'python.exe')
      : path.join(coreDir, '.venv', 'bin', 'python');
  return { coreDir, python, dataDir };
}

interface RunningCore {
  child: ChildProcess;
  generation: number;
  token: string;
  port: number | null;
}

/**
 * Owns the Python core process: spawn, ready handshake, authenticated health
 * polling and shutdown. Emits 'status' with a BackendStatus on every change.
 *
 * The per-launch token is generated here, written to the core's stdin and used
 * only in the Authorization header of main-process requests. It is never put
 * in argv, environment variables, logs or anything sent to the renderer.
 */
export class BackendManager extends EventEmitter<{ status: [BackendStatus] }> {
  private core: RunningCore | null = null;
  private generation = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private stopping = false;
  private current: BackendStatus = {
    state: 'starting',
    detail: 'Starting local core…',
    checkedAt: null,
    health: null,
  };

  private readonly paths: BackendPaths;

  constructor(paths: BackendPaths) {
    super();
    this.paths = paths;
  }

  get status(): BackendStatus {
    return this.current;
  }

  start(): void {
    if (this.core) return;
    this.stopping = false;
    this.consecutiveFailures = 0;
    const generation = ++this.generation;

    if (!existsSync(this.paths.python)) {
      this.setStatus({
        state: 'error',
        detail: `Python environment not found at ${this.paths.python}. Run scripts\\setup.ps1 first.`,
        checkedAt: null,
        health: null,
      });
      return;
    }

    this.setStatus({ state: 'starting', detail: 'Starting local core…', checkedAt: null, health: null });

    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.AEGIS_DATA_DIR = this.paths.dataDir;
    env.PYTHONNOUSERSITE = '1';
    env.PYTHONUNBUFFERED = '1';

    const child = spawn(this.paths.python, ['-m', 'app.main'], {
      cwd: this.paths.coreDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const token = randomBytes(32).toString('hex');
    const core: RunningCore = { child, generation, token, port: null };
    this.core = core;

    child.on('error', (error) => {
      if (!this.isCurrent(generation)) return;
      console.error(`[aegis-core] failed to spawn: ${error.message}`);
      this.handleExit(generation, `Could not start the core process (${error.message}).`, true);
    });
    child.on('exit', (code, signal) => {
      if (!this.isCurrent(generation)) return;
      const how = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      const wasReady = core.port !== null;
      this.handleExit(
        generation,
        wasReady ? `Core process exited (${how}).` : `Core exited before becoming ready (${how}).`,
        !wasReady,
      );
    });

    // Core logs go to stderr. They never contain the token.
    createInterface({ input: child.stderr! }).on('line', (line) => {
      console.error(`[aegis-core] ${line}`);
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (core.port !== null || !line.startsWith(READY_PREFIX)) return;
      const port = parseReadyLine(line);
      if (port === null) {
        console.error('[aegis-desktop] malformed ready line from core; stopping it');
        child.kill();
        return;
      }
      core.port = port;
      this.clearStartupTimer();
      void this.checkHealth(generation);
      this.pollTimer = setInterval(() => void this.checkHealth(generation), POLL_INTERVAL_MS);
    });

    child.stdin!.on('error', () => {
      /* EPIPE when the core exits first; the exit handler reports it. */
    });
    child.stdin!.write(`${token}\n`);

    this.startupTimer = setTimeout(() => {
      if (!this.isCurrent(generation) || core.port !== null) return;
      console.error('[aegis-desktop] core did not become ready in time; stopping it');
      this.handleExit(
        generation,
        `Core did not report ready within ${STARTUP_TIMEOUT_MS / 1000} s.`,
        true,
      );
      child.kill();
    }, STARTUP_TIMEOUT_MS);
  }

  async restart(): Promise<BackendStatus> {
    if (this.current.state === 'starting' && this.core) return this.current;
    await this.stop();
    this.start();
    return this.current;
  }

  /** Graceful stop: close stdin (the core treats EOF as a shutdown request), then kill. */
  async stop(): Promise<void> {
    const core = this.core;
    this.stopping = true;
    this.clearTimers();
    if (!core) return;
    this.core = null;
    this.generation++;
    const exited = new Promise<void>((resolve) => {
      if (core.child.exitCode !== null || core.child.signalCode !== null) resolve();
      else core.child.once('exit', () => resolve());
    });
    core.child.stdin?.end();
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS),
    );
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      console.error('[aegis-desktop] core did not exit gracefully; terminating');
      core.child.kill();
      await exited;
    }
  }

  /** Port of the running core, for main-process-only diagnostics (smoke test). */
  get port(): number | null {
    return this.core?.port ?? null;
  }

  /** Hard-kill the core without the graceful path. Used to exercise connection loss. */
  killProcessForTest(): boolean {
    return this.core?.child.kill() ?? false;
  }

  private isCurrent(generation: number): boolean {
    return !this.stopping && this.core !== null && this.core.generation === generation;
  }

  private handleExit(generation: number, detail: string, failedToStart: boolean): void {
    if (!this.isCurrent(generation)) return;
    this.clearTimers();
    this.core = null;
    this.setStatus({
      state: failedToStart ? 'error' : 'offline',
      detail,
      checkedAt: new Date().toISOString(),
      health: null,
    });
  }

  private async checkHealth(generation: number): Promise<void> {
    const core = this.core;
    if (!core || core.port === null || !this.isCurrent(generation)) return;
    const checkedAt = new Date().toISOString();
    let failure: string;
    try {
      const response = await fetch(`http://127.0.0.1:${core.port}/health`, {
        headers: { Authorization: `Bearer ${core.token}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!this.isCurrent(generation)) return;
      if (response.ok) {
        const health = parseHealthResponse(await response.json());
        if (!this.isCurrent(generation)) return;
        if (health) {
          this.consecutiveFailures = 0;
          const ok = health.status === 'ok';
          this.setStatus({
            state: ok ? 'online' : 'degraded',
            detail: ok
              ? 'Local core is healthy.'
              : 'Local core is running but reported a failing subsystem (see diagnostics).',
            checkedAt,
            health,
          });
          return;
        }
        failure = 'Core returned a health response that does not match the contract.';
      } else {
        failure = `Core health check returned HTTP ${response.status}.`;
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      failure =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Core health check timed out.'
          : 'Core health check failed to connect.';
    }
    // Tolerate a single transient miss; report offline once failures repeat.
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURES_BEFORE_OFFLINE) return;
    this.setStatus({ state: 'offline', detail: failure, checkedAt, health: null });
  }

  private setStatus(next: BackendStatus): void {
    this.current = next;
    this.emit('status', next);
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private clearTimers(): void {
    this.clearStartupTimer();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

/** Parse `AEGIS_READY {"port": 12345}`; returns null unless it is a loopback-usable port. */
export function parseReadyLine(line: string): number | null {
  try {
    const payload: unknown = JSON.parse(line.slice(READY_PREFIX.length));
    if (typeof payload !== 'object' || payload === null) return null;
    const port = (payload as { port?: unknown }).port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return null;
    }
    return port;
  } catch {
    return null;
  }
}
