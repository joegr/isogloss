/**
 * Any audio file the browser can play → 16 kHz mono 16-bit WAV.
 *
 * The archive's samples are MP3. Decoding them here, with the browser's own
 * codecs, keeps the server free of ffmpeg and means every recording reaches
 * the formant tracker as plain PCM — the same contract the analyser's own
 * recorder has (backend/app/audio.py). The original file is not uploaded; the
 * stored WAV is what the features were computed from, byte for byte.
 */

export const TARGET_SR = 16000;
export const MAX_SECONDS = 60; // backend/app/audio.py trims to this anyway

/** Average the channels. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/** Linear-interpolation resampler. Only used where OfflineAudioContext is not
 * available (tests); in the browser the context's own resampler does it. */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    const j = Math.floor(t);
    const f = t - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}

/** PCM16 little-endian RIFF/WAVE, mono. */
export function encodeWav(x: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + x.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits
  ascii(36, "data");
  v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export interface Converted {
  wav: ArrayBuffer;
  seconds: number;
  sourceRate: number;
  trimmed: boolean;
}

/** Decode with the browser, downmix, resample to 16 kHz, encode. */
export async function toWav(file: Blob): Promise<Converted> {
  const bytes = await file.arrayBuffer();
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error("this browser cannot decode that file");
  } finally {
    void ctx.close();
  }
  const trimmed = decoded.duration > MAX_SECONDS;
  const seconds = Math.min(decoded.duration, MAX_SECONDS);
  const frames = Math.ceil(seconds * TARGET_SR);

  let mono: Float32Array;
  if (typeof OfflineAudioContext !== "undefined") {
    // Render through a mono 16 kHz context: it downmixes and resamples with a
    // proper anti-aliasing filter, which linear interpolation does not have.
    const off = new OfflineAudioContext(1, frames, TARGET_SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    mono = (await off.startRendering()).getChannelData(0);
  } else {
    const chans = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    mono = resampleLinear(downmix(chans), decoded.sampleRate, TARGET_SR).subarray(0, frames);
  }
  return { wav: encodeWav(mono, TARGET_SR), seconds, sourceRate: decoded.sampleRate, trimmed };
}
