import { LIVE_ORB_STATES, ORB_LABELS, ORB_STATES, type OrbState } from '../../orb/orbModel';

interface StatePreviewProps {
  value: OrbState | null;
  onChange: (value: OrbState | null) => void;
}

/**
 * DEVELOPMENT ONLY. Lets a developer inspect styling for states that no real
 * event can produce yet. Everything chosen here is simulated and labelled so.
 */
export function StatePreview({ value, onChange }: StatePreviewProps) {
  return (
    <details className="panel panel--dev">
      <summary>Development state preview (simulated)</summary>
      <p className="panel__note">
        Shows orb styling for any state, including ones real events do not produce yet. While a preview is
        active the orb is labelled “Preview · simulated” and does not reflect the backend.
      </p>
      <div className="preview-controls">
        <label htmlFor="orb-preview">Preview state</label>
        <select
          id="orb-preview"
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value ? (event.target.value as OrbState) : null)}
        >
          <option value="">Off — show live state</option>
          {ORB_STATES.map((state) => (
            <option key={state} value={state}>
              {ORB_LABELS[state]}
              {LIVE_ORB_STATES.includes(state) ? '' : ' (not live yet)'}
            </option>
          ))}
        </select>
        {value && (
          <button type="button" className="button" onClick={() => onChange(null)}>
            Stop preview
          </button>
        )}
      </div>
    </details>
  );
}
