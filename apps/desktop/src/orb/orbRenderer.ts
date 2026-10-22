// Canvas 2D renderer for the AEGIS orb. Original geometry: a particle shell on a
// Fibonacci sphere, three inclined orbital rings, a breathing core and an
// optional scan arc. All motion comes from OrbMotion targets for the current
// state; this module never decides the state itself.

import { approach, ORB_MOTION, type OrbMotion, type OrbState } from './orbModel';

export type Rgb = readonly [number, number, number];

const SHELL_POINTS = 160;
const RING_SEGMENTS = 96;
const RINGS = [
  { tiltX: 1.15, tiltZ: 0.3, speed: 1, radius: 0.78 },
  { tiltX: 1.35, tiltZ: -0.85, speed: -0.7, radius: 0.86 },
  { tiltX: 0.4, tiltZ: 1.6, speed: 0.45, radius: 0.94 },
] as const;
const MAX_DPR = 2;

interface Point3 {
  x: number;
  y: number;
  z: number;
}

function fibonacciSphere(count: number): Point3[] {
  const points: Point3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    points.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return points;
}

function rotate(p: Point3, ax: number, ay: number, az: number): Point3 {
  // X axis
  let { x, y, z } = p;
  let c = Math.cos(ax);
  let s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  // Y axis
  c = Math.cos(ay);
  s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  // Z axis
  c = Math.cos(az);
  s = Math.sin(az);
  [x, y] = [x * c - y * s, x * s + y * c];
  return { x, y, z };
}

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export class OrbRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly shell = fibonacciSphere(SHELL_POINTS);
  private readonly resizeObserver: ResizeObserver;
  private motion: OrbMotion = { ...ORB_MOTION.connecting };
  private target: OrbMotion = ORB_MOTION.connecting;
  private tint: [number, number, number] = [200, 200, 200];
  private targetTint: Rgb = [200, 200, 200];
  private reducedMotion = false;
  private frame: number | null = null;
  private lastFrameAt = 0;
  private time = 0;
  private spinAngle = 0;
  private sweepAngle = 0;
  /** Real audio level (0..1) of the live microphone or playing speech, smoothed per frame. */
  private levelSource: (() => number) | null = null;
  private level = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  setState(state: OrbState, tint: Rgb): void {
    this.target = ORB_MOTION[state];
    this.targetTint = tint;
    if (this.reducedMotion) this.snapToTarget();
    this.kick();
  }

  /**
   * Drive particle displacement and core size from a real audio level (microphone
   * capture or speech playback). Null when no audio is live. Ignored in reduced
   * motion, where the orb stays a static frame.
   */
  setLevelSource(source: (() => number) | null): void {
    this.levelSource = source;
    if (!source) this.level = 0;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.snapToTarget();
    this.kick();
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.kick();
  };

  private snapToTarget(): void {
    this.motion = { ...this.target };
    this.tint = [...this.targetTint];
  }

  /** Start the loop, or draw one static frame in reduced-motion mode. */
  private kick(): void {
    if (this.reducedMotion) {
      this.stop();
      this.draw();
      return;
    }
    if (this.frame === null && !document.hidden) {
      this.lastFrameAt = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    const elapsed = now - this.lastFrameAt;
    if (elapsed < 1000 / this.target.maxFps - 1) return; // frame-rate cap per state
    const dt = Math.min(elapsed / 1000, 0.1);
    this.lastFrameAt = now;
    this.time += dt;

    const m = this.motion;
    const t = this.target;
    for (const key of Object.keys(t) as (keyof OrbMotion)[]) {
      m[key] = key === 'maxFps' ? t.maxFps : approach(m[key], t[key], dt, 3);
    }
    for (let i = 0; i < 3; i++) this.tint[i] = approach(this.tint[i]!, this.targetTint[i]!, dt, 3);
    const raw = this.levelSource ? Math.max(0, Math.min(1, this.levelSource())) : 0;
    this.level = approach(this.level, raw, dt, raw > this.level ? 18 : 6); // fast attack, slower release
    this.spinAngle += m.spin * dt;
    this.sweepAngle += 1.4 * dt;
    this.draw();
  };

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const { clientWidth, clientHeight } = this.canvas;
    const width = Math.max(1, Math.round(clientWidth * dpr));
    const height = Math.max(1, Math.round(clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.reducedMotion || this.frame === null) this.draw();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.34;
    const m = this.motion;
    const tint = this.tint;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * m.pulseHz);
    const level = this.reducedMotion ? 0 : this.level;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // Core glow.
    const coreR = R * (0.42 + 0.06 * pulse * m.energy + 0.16 * level);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(tint, (0.75 + 0.25 * pulse) * m.energy * m.presence));
    core.addColorStop(0.4, rgba(tint, 0.3 * m.energy * m.presence));
    core.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Orbital rings: back halves dimmer than front halves for depth.
    ctx.lineWidth = Math.max(1, R * 0.006);
    RINGS.forEach((ring, ringIndex) => {
      const phase = this.spinAngle * ring.speed * 1.6;
      let prev: Point3 | null = null;
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        const p = rotate({ x: Math.cos(a), y: 0, z: Math.sin(a) }, ring.tiltX, phase, ring.tiltZ);
        if (prev && i % 6 !== ringIndex) {
          const depth = (p.z + 1) / 2;
          ctx.strokeStyle = rgba(tint, (0.08 + 0.32 * depth) * m.presence);
          ctx.beginPath();
          ctx.moveTo(cx + prev.x * R * ring.radius, cy + prev.y * R * ring.radius);
          ctx.lineTo(cx + p.x * R * ring.radius, cy + p.y * R * ring.radius);
          ctx.stroke();
        }
        prev = p;
      }
    });

    // Particle shell with reactive radial displacement.
    const dotBase = Math.max(1, R * 0.011);
    for (let i = 0; i < this.shell.length; i++) {
      const base = this.shell[i]!;
      const charge = m.turbulence + 0.32 * level;
      const wobble = 1 + charge * Math.sin(this.time * 2.3 + i * 1.7) * Math.cos(this.time * 1.1 + i * 0.6);
      const p = rotate(base, 0.35, this.spinAngle, 0);
      const depth = (p.z + 1) / 2;
      const r = R * wobble;
      ctx.fillStyle = rgba(tint, (0.12 + 0.75 * depth) * m.presence);
      ctx.beginPath();
      ctx.arc(cx + p.x * r, cy + p.y * r, dotBase * (0.5 + depth), 0, Math.PI * 2);
      ctx.fill();
    }

    // Outer tick ring.
    const ticks = 72;
    ctx.lineWidth = Math.max(1, R * 0.008);
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * Math.PI * 2 - this.spinAngle * 0.25;
      const long = i % 6 === 0;
      const r0 = R * 1.18;
      const r1 = R * (long ? 1.25 : 1.21);
      ctx.strokeStyle = rgba(tint, (long ? 0.35 : 0.16) * m.presence);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // Scan arc (connecting / planning).
    if (m.sweep > 0.01) {
      ctx.lineWidth = Math.max(1.5, R * 0.018);
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(tint, 0.75 * m.sweep * m.presence);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.1, this.sweepAngle, this.sweepAngle + Math.PI * 0.35);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
