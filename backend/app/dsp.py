"""Signal processing: frames, spectra, formants, pitch.

Everything here is numpy + scipy. No trained model, no external binaries — the
front end sends 16-bit PCM and this file turns it into the acoustic
measurements the rest of the pipeline reasons about.

Frame geometry is the standard 25 ms window / 10 ms hop, which makes the frame
index directly interpretable as centiseconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.signal import get_window, lfilter

WIN_S = 0.025
HOP_S = 0.010
PREEMPH = 0.97


# ---------------------------------------------------------------------------
# Framing and spectra
# ---------------------------------------------------------------------------


def preemphasise(x: np.ndarray, coeff: float = PREEMPH) -> np.ndarray:
    return lfilter([1.0, -coeff], [1.0], x)


def frame(x: np.ndarray, sr: int, win_s: float = WIN_S, hop_s: float = HOP_S) -> np.ndarray:
    """Slice into overlapping frames. Returns (n_frames, win_n)."""
    win_n = int(round(win_s * sr))
    hop_n = int(round(hop_s * sr))
    if len(x) < win_n:
        x = np.pad(x, (0, win_n - len(x)))
    n = 1 + (len(x) - win_n) // hop_n
    idx = np.arange(win_n)[None, :] + hop_n * np.arange(n)[:, None]
    return x[idx]


def power_spectrum(frames: np.ndarray, n_fft: int = 512) -> np.ndarray:
    w = get_window("hamming", frames.shape[1], fftbins=True)
    spec = np.fft.rfft(frames * w, n=n_fft)
    return (np.abs(spec) ** 2) / n_fft


def mel_filterbank(sr: int, n_fft: int = 512, n_mel: int = 26,
                   fmin: float = 50.0, fmax: float | None = None) -> np.ndarray:
    fmax = fmax or sr / 2

    def to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def from_mel(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    pts = from_mel(np.linspace(to_mel(fmin), to_mel(fmax), n_mel + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mel, n_fft // 2 + 1))
    for i in range(n_mel):
        lo, mid, hi = bins[i], bins[i + 1], bins[i + 2]
        if mid == lo:
            mid = lo + 1
        if hi == mid:
            hi = mid + 1
        hi = min(hi, fb.shape[1] - 1)
        if mid >= fb.shape[1]:
            break
        fb[i, lo:mid] = np.linspace(0, 1, mid - lo, endpoint=False)
        fb[i, mid:hi] = np.linspace(1, 0, hi - mid, endpoint=False)
    return fb


FLAT_BAND_HZ = 1000.0     # ignore the low band: it is dead during /s/
FLAT_FLOOR = 1e-3         # dynamic-range floor, relative to the frame peak
FLAT_SCALE = (0.06, 0.40) # raw range observed for a modal vowel .. white noise


def spectral_flatness(pspec: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    """Noise-likeness in [0, 1]: 0 modal voice, ~0.5 fricative, 1 white noise.

    Three details matter, and each was a bug before it was a detail:

    * measured above 1 kHz only. Full-band flatness scores [s] as *less* noisy
      than [ʃ], because high-passed noise has a dead low band that reads as
      structure. Sibilants must be judged inside the band they occupy.
    * the spectrum is floored relative to the frame peak rather than at an
      absolute value, so the measure does not collapse to zero simply because
      the frame is loud.
    * rescaled onto a fixed, documented range, so the targets in the `phone`
      table are commensurate with what this returns. They are calibrated to
      this function; changing it means recalibrating db/03_seed_phonetics.sql.
    """
    band = pspec[:, freqs >= FLAT_BAND_HZ]
    if band.shape[1] < 4:
        band = pspec
    p = band / np.maximum(band.max(axis=1, keepdims=True), 1e-30)
    p = np.maximum(p, FLAT_FLOOR)
    raw = np.exp(np.mean(np.log(p), axis=1)) / p.mean(axis=1)
    lo, hi = FLAT_SCALE
    return np.clip((raw - lo) / (hi - lo), 0.0, 1.0)


def mfcc(pspec: np.ndarray, sr: int, n_fft: int = 512, n_mfcc: int = 13) -> np.ndarray:
    fb = mel_filterbank(sr, n_fft)
    energies = np.log(np.maximum(pspec @ fb.T, 1e-10))
    n_mel = energies.shape[1]
    # DCT-II, orthonormal.
    k = np.arange(n_mfcc)[:, None]
    m = np.arange(n_mel)[None, :]
    basis = np.cos(math.pi * k * (2 * m + 1) / (2 * n_mel))
    basis[0] *= 1 / math.sqrt(2)
    return energies @ basis.T * math.sqrt(2.0 / n_mel)


# ---------------------------------------------------------------------------
# Formants — Levinson-Durbin LPC, roots of the prediction polynomial
# ---------------------------------------------------------------------------


def _autocorr(f: np.ndarray, order: int) -> np.ndarray:
    n = f.shape[-1]
    spec = np.fft.rfft(f, n=2 * n)
    ac = np.fft.irfft(np.abs(spec) ** 2, n=2 * n)[..., : order + 1]
    return ac


def lpc(frames: np.ndarray, order: int) -> tuple[np.ndarray, np.ndarray]:
    """Batch Levinson-Durbin. Returns (coeffs (n, order+1), residual power)."""
    r = _autocorr(frames * get_window("hamming", frames.shape[1]), order)
    # Ridge the zero lag: keeps silent frames from producing garbage roots.
    r[:, 0] = r[:, 0] * 1.0001 + 1e-9

    n = frames.shape[0]
    a = np.zeros((n, order + 1))
    a[:, 0] = 1.0
    e = r[:, 0].copy()

    for i in range(1, order + 1):
        acc = r[:, i] + np.sum(a[:, 1:i] * r[:, i - 1 : 0 : -1], axis=1) if i > 1 else r[:, i]
        k = -acc / np.maximum(e, 1e-12)
        k = np.clip(k, -0.999, 0.999)
        new = a.copy()
        new[:, 1 : i + 1] = a[:, 1 : i + 1] + k[:, None] * a[:, i - 1 :: -1][:, : i]
        a = new
        e = e * (1 - k**2)
    return a, e


def formants(frames: np.ndarray, sr: int, max_n: int = 4) -> np.ndarray:
    """Formant frequencies per frame, (n_frames, max_n), NaN where unresolved.

    Standard order heuristic: two poles per kHz of bandwidth, plus two for the
    source. Roots are kept only if they are inside the unit circle, above 90 Hz,
    and narrow enough to be a resonance rather than spectral tilt.
    """
    order = int(2 + sr / 1000)
    a, _ = lpc(frames, order)
    out = np.full((frames.shape[0], max_n), np.nan)

    for i in range(frames.shape[0]):
        try:
            rts = np.roots(a[i])
        except np.linalg.LinAlgError:
            continue
        rts = rts[np.imag(rts) > 0.01]
        if rts.size == 0:
            continue
        mag = np.abs(rts)
        rts = rts[(mag > 0.7) & (mag < 1.0)]
        if rts.size == 0:
            continue
        freq = np.arctan2(np.imag(rts), np.real(rts)) * sr / (2 * math.pi)
        # 3 dB bandwidth of a pole at radius |z|: B = -(fs/π)·ln|z|.
        bw = -(sr / math.pi) * np.log(np.abs(rts))
        keep = (freq > 90) & (freq < sr / 2 - 150) & (bw < 900)
        freq = np.sort(freq[keep])
        out[i, : min(max_n, freq.size)] = freq[:max_n]
    return out


# ---------------------------------------------------------------------------
# Pitch — normalised autocorrelation
# ---------------------------------------------------------------------------


def pitch(frames: np.ndarray, sr: int, fmin: float = 60.0,
          fmax: float = 400.0) -> tuple[np.ndarray, np.ndarray]:
    """Returns (f0_hz with NaN where unvoiced, voicing strength 0..1)."""
    n = frames.shape[1]
    f = frames - frames.mean(axis=1, keepdims=True)
    spec = np.fft.rfft(f, n=2 * n)
    ac = np.fft.irfft(np.abs(spec) ** 2, n=2 * n)[:, :n]
    zero = np.maximum(ac[:, :1], 1e-12)
    ac = ac / zero

    lo = max(2, int(sr / fmax))
    hi = min(n - 1, int(sr / fmin))
    if hi <= lo:
        return np.full(len(frames), np.nan), np.zeros(len(frames))

    seg = ac[:, lo:hi]
    lag = np.argmax(seg, axis=1) + lo
    strength = seg.max(axis=1)

    # Parabolic refinement around the peak — worth it, because f0_span is
    # measured in semitones and a one-sample lag error is ~1 semitone at 200 Hz.
    f0 = np.full(len(frames), np.nan)
    for i, (l, s) in enumerate(zip(lag, strength)):
        if s < 0.30 or l <= 0 or l >= n - 1:
            continue
        y0, y1, y2 = ac[i, l - 1], ac[i, l], ac[i, l + 1]
        denom = y0 - 2 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-9 else 0.0
        f0[i] = sr / (l + np.clip(delta, -1, 1))
    return f0, strength


# ---------------------------------------------------------------------------
# Frame-level feature bundle
# ---------------------------------------------------------------------------


@dataclass
class Frames:
    sr: int
    hop_s: float
    energy: np.ndarray        # dB, per frame
    zcr: np.ndarray
    f0: np.ndarray            # Hz, NaN unvoiced
    voicing: np.ndarray       # 0..1
    fmt: np.ndarray           # (n, 4) Hz, NaN unresolved
    centroid: np.ndarray      # Hz
    spread: np.ndarray        # Hz
    flatness: np.ndarray      # 0..1 Wiener entropy
    rolloff: np.ndarray       # Hz, 85%
    mfcc: np.ndarray          # (n, 13)
    bandwidth_hz: float       # effective upper edge of the recording
    speech: np.ndarray        # bool VAD mask

    @property
    def n(self) -> int:
        return len(self.energy)

    def times(self) -> np.ndarray:
        return np.arange(self.n) * self.hop_s


def analyse(x: np.ndarray, sr: int) -> Frames:
    x = np.asarray(x, dtype=np.float64)
    peak = np.max(np.abs(x)) if x.size else 0.0
    if peak > 0:
        x = x / peak

    raw = frame(x, sr)
    pre = frame(preemphasise(x), sr)

    pspec = power_spectrum(pre)
    freqs = np.fft.rfftfreq(512, 1 / sr)

    total = np.maximum(pspec.sum(axis=1, keepdims=True), 1e-12)
    p = pspec / total
    centroid = p @ freqs
    spread = np.sqrt(np.maximum(p @ (freqs**2) - centroid**2, 0))
    flatness = spectral_flatness(pspec, freqs)

    csum = np.cumsum(pspec, axis=1) / total
    rolloff = freqs[np.argmax(csum >= 0.85, axis=1)]

    energy = 10 * np.log10(np.maximum((raw**2).mean(axis=1), 1e-12))
    zcr = np.mean(np.abs(np.diff(np.sign(raw), axis=1)) > 0, axis=1)

    f0, voicing = pitch(raw, sr)
    fmt = formants(pre, sr)

    # Effective bandwidth: the highest frequency still carrying real energy in
    # the loudest 20% of frames. Telephone audio lands near 3.4 kHz and that
    # single number decides whether F3 (hence rhoticity) is measurable at all.
    loud = pspec[energy > np.percentile(energy, 80)] if len(pspec) > 5 else pspec
    if loud.size:
        avg = loud.mean(axis=0)
        thresh = avg.max() * 1e-4
        above = np.nonzero(avg > thresh)[0]
        bandwidth = float(freqs[above[-1]]) if above.size else float(sr / 2)
    else:
        bandwidth = float(sr / 2)

    speech = _vad(energy, voicing)

    return Frames(sr=sr, hop_s=HOP_S, energy=energy, zcr=zcr, f0=f0, voicing=voicing,
                  fmt=fmt, centroid=centroid, spread=spread, flatness=flatness,
                  rolloff=rolloff, mfcc=mfcc(pspec, sr), bandwidth_hz=bandwidth,
                  speech=speech)


def _vad(energy: np.ndarray, voicing: np.ndarray) -> np.ndarray:
    """Energy threshold relative to the noise floor, plus a voicing rescue.

    The rescue matters: a quiet voiced [ð] between two loud vowels sits below an
    absolute threshold but is exactly the segment we most want to keep.
    """
    if len(energy) < 3:
        return np.ones(len(energy), dtype=bool)
    floor = np.percentile(energy, 10)
    ceil = np.percentile(energy, 95)
    thresh = floor + 0.25 * max(ceil - floor, 6.0)
    mask = (energy > thresh) | (voicing > 0.55)

    # Close gaps under 60 ms, drop islands under 40 ms.
    mask = _morph(mask, close=6, open_=4)
    return mask


def _morph(mask: np.ndarray, close: int, open_: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(close):
        out = out | (np.roll(out, 1) & np.roll(out, -1))
    runs = _runs(out)
    for a, b, val in runs:
        if val and (b - a) < open_:
            out[a:b] = False
    return out


def _runs(mask: np.ndarray) -> list[tuple[int, int, bool]]:
    """Contiguous constant runs as (start, stop, value)."""
    if len(mask) == 0:
        return []
    edges = np.nonzero(np.diff(mask.astype(int)))[0] + 1
    bounds = np.concatenate(([0], edges, [len(mask)]))
    return [(int(bounds[i]), int(bounds[i + 1]), bool(mask[bounds[i]]))
            for i in range(len(bounds) - 1)]
