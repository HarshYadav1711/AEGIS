import { useEffect, useRef } from 'react';

import { ORB_LABELS, type OrbState } from '../../orb/orbModel';
import { OrbRenderer, type Rgb } from '../../orb/orbRenderer';

interface OrbProps {
  state: OrbState;
  reducedMotion: boolean;
  /** True when `state` comes from the development preview rather than live events. */
  isPreview: boolean;
  onActivate: () => void;
  describedBy: string;
}

/** Reads the per-state tint token (`--orb-tint: r g b`) from CSS. */
function readTint(element: Element): Rgb {
  const raw = getComputedStyle(element).getPropertyValue('--orb-tint').trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  return [200, 200, 200];
}

export function Orb({ state, reducedMotion, isPreview, onActivate, describedBy }: OrbProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new OrbRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    // data-orb-state is already applied, so the CSS tint for this state is resolvable.
    if (buttonRef.current) rendererRef.current?.setState(state, readTint(buttonRef.current));
  }, [state]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="orb"
      data-orb-state={state}
      data-orb-preview={isPreview ? 'true' : undefined}
      aria-label={`AEGIS status orb: ${ORB_LABELS[state]}${isPreview ? ' (preview)' : ''}. Activate to focus the message box.`}
      aria-describedby={describedBy}
      onClick={onActivate}
    >
      <canvas ref={canvasRef} className="orb__canvas" aria-hidden="true" />
      {isPreview && <span className="orb__preview-badge">Preview · simulated</span>}
    </button>
  );
}
