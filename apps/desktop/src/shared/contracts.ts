// Contracts shared by Electron main, preload and renderer.
//
// This file must stay free of runtime imports and non-erasable TypeScript
// syntax (enums, namespaces) so that main (tsc/CommonJS), the renderer (Vite)
// and the Node test runner (type stripping) can all load it.

/** Every IPC channel the app uses. Preload exposes nothing else. */
export type IpcChannel =
  | 'aegis:backend:get-status'
  | 'aegis:backend:restart'
  | 'aegis:backend:status-changed'
  | 'aegis:app:get-info';

/**
 * Lifecycle of the local Python core as observed by Electron main.
 * - starting: process spawned, waiting for the ready handshake / first health
 * - online:   authenticated /health succeeded and reported status "ok"
 * - degraded: /health succeeded but the core reported a failing subsystem
 * - offline:  process exited or stopped answering health checks
 * - error:    the core could not be started at all
 */
export type BackendState = 'starting' | 'online' | 'degraded' | 'offline' | 'error';

export const BACKEND_STATES: readonly BackendState[] = [
  'starting',
  'online',
  'degraded',
  'offline',
  'error',
];

export interface DatabaseHealth {
  ok: boolean;
  schemaVersion: number | null;
  journalMode: string | null;
  fts5Available: boolean | null;
}

/** Validated subset of the core's GET /health response. */
export interface HealthSnapshot {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  database: DatabaseHealth;
  capabilities: { chat: boolean };
}

export interface BackendStatus {
  state: BackendState;
  /** Human-readable explanation. Never contains credentials. */
  detail: string;
  /** ISO timestamp of the most recent health attempt, if any. */
  checkedAt: string | null;
  /** Last successful health payload while online/degraded, otherwise null. */
  health: HealthSnapshot | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  /** True when running from source (not a packaged build). */
  isDevelopment: boolean;
}

/** The only API the renderer can reach (window.aegis). */
export interface AegisBridge {
  getBackendStatus(): Promise<BackendStatus>;
  restartBackend(): Promise<BackendStatus>;
  onBackendStatus(listener: (status: BackendStatus) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Parse the core's snake_case /health JSON into a HealthSnapshot.
 * Returns null for anything that does not match the contract exactly.
 */
export function parseHealthResponse(value: unknown): HealthSnapshot | null {
  if (!isRecord(value)) return null;
  const { status, service, version, uptime_seconds, database, capabilities } = value;
  if (service !== 'aegis-core') return null;
  if (status !== 'ok' && status !== 'degraded') return null;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null;
  if (typeof uptime_seconds !== 'number' || !Number.isFinite(uptime_seconds) || uptime_seconds < 0) {
    return null;
  }
  if (!isRecord(database) || !isRecord(capabilities)) return null;
  const { ok, schema_version, journal_mode, fts5_available } = database;
  if (typeof ok !== 'boolean' || !isNullableNumber(schema_version)) return null;
  if (journal_mode !== null && typeof journal_mode !== 'string') return null;
  if (fts5_available !== null && typeof fts5_available !== 'boolean') return null;
  if (typeof capabilities.chat !== 'boolean') return null;
  return {
    status,
    version,
    uptimeSeconds: uptime_seconds,
    database: {
      ok,
      schemaVersion: schema_version,
      journalMode: journal_mode,
      fts5Available: fts5_available,
    },
    capabilities: { chat: capabilities.chat },
  };
}

function isHealthSnapshot(value: unknown): value is HealthSnapshot {
  if (!isRecord(value) || !isRecord(value.database) || !isRecord(value.capabilities)) return false;
  const db = value.database;
  return (
    (value.status === 'ok' || value.status === 'degraded') &&
    typeof value.version === 'string' &&
    typeof value.uptimeSeconds === 'number' &&
    typeof db.ok === 'boolean' &&
    isNullableNumber(db.schemaVersion) &&
    (db.journalMode === null || typeof db.journalMode === 'string') &&
    (db.fts5Available === null || typeof db.fts5Available === 'boolean') &&
    typeof value.capabilities.chat === 'boolean'
  );
}

/** Runtime guard for status objects crossing the IPC boundary. */
export function isBackendStatus(value: unknown): value is BackendStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.state === 'string' &&
    (BACKEND_STATES as readonly string[]).includes(value.state) &&
    typeof value.detail === 'string' &&
    (value.checkedAt === null || typeof value.checkedAt === 'string') &&
    (value.health === null || isHealthSnapshot(value.health))
  );
}
