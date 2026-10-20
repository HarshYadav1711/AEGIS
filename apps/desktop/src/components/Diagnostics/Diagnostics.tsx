import type { AppInfo, BackendStatus } from '../../shared/contracts';

interface DiagnosticsProps {
  status: BackendStatus | null;
  appInfo: AppInfo | null;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

function formatTime(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleTimeString();
}

/** Progressive-disclosure view of exactly what the app knows. Unknowns stay "unknown". */
export function Diagnostics({ status, appInfo }: DiagnosticsProps) {
  const health = status?.health ?? null;
  const rows: [string, string][] = [
    ['Backend state', status?.state ?? 'waiting for first report'],
    ['Detail', status?.detail ?? '—'],
    ['Last health check', formatTime(status?.checkedAt ?? null)],
    ['Core version', health?.version ?? 'unknown'],
    ['Core uptime', health ? `${Math.floor(health.uptimeSeconds)} s` : 'unknown'],
    ['Database reachable', yesNo(health?.database.ok)],
    ['Schema version', health?.database.schemaVersion?.toString() ?? 'unknown'],
    ['Journal mode', health?.database.journalMode ?? 'unknown'],
    ['FTS5 available', yesNo(health?.database.fts5Available)],
    ['Chat capability', health ? (health.capabilities.chat ? 'available' : 'not available') : 'unknown'],
    ['Model provider', health?.provider?.id ?? 'unknown'],
    ['Provider endpoint', health?.provider?.baseUrl ?? 'unknown'],
    ['Provider reachable', yesNo(health?.provider?.reachable)],
    ['Provider detail', health?.provider?.detail ?? 'unknown'],
    ['Installed models', health?.provider ? health.provider.models.join(', ') || 'none' : 'unknown'],
    ['Credentials', 'none used (local provider only)'],
    ['Desktop version', appInfo?.version ?? 'unknown'],
    ['Electron', appInfo?.electron ?? 'unknown'],
  ];
  return (
    <details className="panel">
      <summary>Diagnostics</summary>
      <dl className="diagnostics">
        {rows.map(([term, value]) => (
          <div key={term} className="diagnostics__row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
