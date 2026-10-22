// Pure audio helpers for push-to-talk (no DOM access, unit-tested with the Node runner).
// The recording is converted to the one format the core accepts: 16 kHz, mono, 16-bit PCM WAV.

// Kept free of runtime imports so the Node test runner can load it; tests check these equal the contract values.
export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 60;

/** Concatenate captured chunks into one buffer. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Downsample by averaging each output sample's input window (a simple low-pass that avoids aliasing). */
export function downsample(input: Float32Array, inRate: number, outRate = VOICE_SAMPLE_RATE): Float32Array {
  if (!(inRate > 0) || !(outRate > 0)) throw new Error('sample rates must be positive');
  if (inRate === outRate) return input.slice();
  if (inRate < outRate) throw new Error('upsampling is not supported');
  const ratio = inRate / outRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** 16-bit PCM mono WAV. Samples are clipped to [-1, 1]. */
export function encodeWav(samples: Float32Array, rate = VOICE_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Root-mean-square of a block. */
export function rms(block: Float32Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  return Math.sqrt(sum / block.length);
}

/** Map RMS to a 0..1 display level on a log scale (-60 dBFS → 0, -10 dBFS → 1). */
export function levelFromRms(value: number): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

/** Byte-time-domain analyser data (128 = silence) to RMS in [0, 1]. */
export function rmsFromBytes(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

/** Convert one finished capture into the WAV the core accepts, or say why it cannot be sent. */
export function recordingToWav(
  chunks: readonly Float32Array[],
  inRate: number,
): { ok: true; wav: Uint8Array; seconds: number } | { ok: false; reason: 'empty' | 'too_long' } {
  const samples = downsample(concat(chunks), inRate);
  const seconds = samples.length / VOICE_SAMPLE_RATE;
  if (samples.length === 0) return { ok: false, reason: 'empty' };
  if (seconds > MAX_RECORDING_SECONDS) return { ok: false, reason: 'too_long' };
  return { ok: true, wav: encodeWav(samples), seconds };
}
