"""Offline checks for the signal chain. No database, no network.

Synthesises source-filter speech with known formants and pitch, then asserts the
analysis recovers them. If these pass, a wrong answer downstream is a modelling
problem rather than a DSP bug — which is the distinction worth being able to
make quickly.

    python3 backend/tests/test_dsp.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import audio, dsp  # noqa: E402
from app.phones import Phone, TemplateRecognizer, estimate_warp  # noqa: E402

SR = 16000
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def synth_vowel(f0: float, formants: list[float], seconds: float,
                bandwidths: list[float] | None = None) -> np.ndarray:
    """Impulse train through cascaded two-pole resonators."""
    n = int(seconds * SR)
    x = np.zeros(n)
    period = int(SR / f0)
    x[::period] = 1.0

    bandwidths = bandwidths or [80.0] * len(formants)
    for f, bw in zip(formants, bandwidths):
        r = math.exp(-math.pi * bw / SR)
        theta = 2 * math.pi * f / SR
        a1, a2 = -2 * r * math.cos(theta), r * r
        y = np.zeros(n)
        for i in range(n):
            y[i] = x[i] - a1 * (y[i - 1] if i >= 1 else 0) - a2 * (y[i - 2] if i >= 2 else 0)
        x = y / max(np.max(np.abs(y)), 1e-9)
    return x * 0.8


def noise_fricative(centre: float, seconds: float) -> np.ndarray:
    rng = np.random.default_rng(7)
    n = int(seconds * SR)
    x = rng.standard_normal(n)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spec = np.fft.rfft(x) * np.exp(-0.5 * ((freqs - centre) / 1800.0) ** 2)
    y = np.fft.irfft(spec, n=n)
    return 0.5 * y / max(np.max(np.abs(y)), 1e-9)


# ---------------------------------------------------------------------------


def test_wav_roundtrip() -> None:
    print("\nWAV round-trip")
    x = synth_vowel(120, [700, 1200, 2500], 0.6)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    header = (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt "
              + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
              + (1).to_bytes(2, "little") + SR.to_bytes(4, "little")
              + (SR * 2).to_bytes(4, "little") + (2).to_bytes(2, "little")
              + (16).to_bytes(2, "little") + b"data" + len(pcm).to_bytes(4, "little"))
    y, sr = audio.prepare(header + pcm)
    check("decodes at 16 kHz", sr == 16000, f"sr={sr}")
    check("length preserved", abs(len(y) - len(x)) < 4, f"{len(y)} vs {len(x)}")
    check("waveform matches", float(np.corrcoef(y, x[: len(y)])[0, 1]) > 0.99)


def test_pitch() -> None:
    print("\nPitch")
    for f0 in (95.0, 145.0, 220.0):
        x = synth_vowel(f0, [600, 1100, 2400], 0.7)
        f = dsp.analyse(x, SR)
        est = np.nanmedian(f.f0[f.voicing > 0.6])
        err = abs(est - f0) / f0
        check(f"f0 ≈ {f0:.0f} Hz", err < 0.06, f"got {est:.1f} Hz ({err * 100:.1f}% off)")


def test_formants() -> None:
    print("\nFormants")
    cases = {
        "[i] 280/2250/2900": (280, 2250, 2900),
        "[ɑ] 730/1090/2440": (730, 1090, 2440),
        "[u] 320/870/2250": (320, 870, 2250),
    }
    # Per-formant tolerances, because the error is not uniform. LPC biases F1
    # upward toward the nearest voicing harmonic, and the bias is worst for
    # close vowels where F1 is low and the harmonic spacing is a large fraction
    # of it — [i] at f0 = 120 Hz has harmonics at 240 and 360 straddling a true
    # F1 of 280. This is a documented limitation of the method, not a defect
    # here, and it is tolerable downstream because every vowel measurement is a
    # within-speaker z-score, so a systematic F1 bias largely cancels.
    tolerance = (0.25, 0.10, 0.10)
    for name, (t1, t2, t3) in cases.items():
        x = synth_vowel(120, [t1, t2, t3, 3500], 0.8)
        f = dsp.analyse(x, SR)
        keep = f.speech & (f.voicing > 0.5)
        got = np.nanmedian(f.fmt[keep], axis=0)
        errs = [abs(g - t) / t for g, t in zip(got[:3], (t1, t2, t3))]
        ok = all(e < tol for e, tol in zip(errs, tolerance) if np.isfinite(e))
        resolved = int(np.isfinite(got[:3]).sum())
        check(name, ok and resolved == 3,
              f"got {np.round(got[:3]).tolist()}, err "
              f"{[f'{e * 100:.0f}%' for e in errs]} ({resolved}/3 resolved)")


def test_vad_and_bandwidth() -> None:
    print("\nVAD and bandwidth")
    voiced = synth_vowel(130, [600, 1200, 2500], 0.5)
    silence = np.zeros(int(0.4 * SR))
    x = np.concatenate([silence, voiced, silence, voiced, silence])
    f = dsp.analyse(x, SR)
    ratio = f.speech.mean()
    check("VAD finds roughly half the signal", 0.35 < ratio < 0.70, f"{ratio:.2f}")

    wide = dsp.analyse(noise_fricative(6000, 1.0), SR)
    check("wideband detected", wide.bandwidth_hz > 6000, f"{wide.bandwidth_hz:.0f} Hz")

    narrow_src = noise_fricative(6000, 1.0)
    spec = np.fft.rfft(narrow_src)
    freqs = np.fft.rfftfreq(len(narrow_src), 1 / SR)
    spec[freqs > 3400] = 0
    narrow = dsp.analyse(np.fft.irfft(spec, n=len(narrow_src)), SR)
    check("narrowband detected", narrow.bandwidth_hz < 3800, f"{narrow.bandwidth_hz:.0f} Hz")


def test_vtln() -> None:
    print("\nVocal tract length normalisation")
    # A short tract raises every formant; the warp should undo most of it.
    # F4 is in the synthesis on purpose: with only three resonators the LPC fit
    # inserts a spurious pole above F2 that gets sorted into the F3 slot, the
    # median F3 collapses, and the warp saturates at its clamp. Real speech
    # always has higher formants, so a three-formant test signal was measuring
    # an artefact of the test rather than of the estimator.
    for factor in (0.85, 1.0, 1.18):
        x = synth_vowel(140, [600 * factor, 1200 * factor, 2500 * factor,
                              3500 * factor], 0.8)
        f = dsp.analyse(x, SR)
        warp = estimate_warp(f)
        corrected = 2500 * factor * warp
        check(f"tract ×{factor}", abs(corrected - 2500) / 2500 < 0.15,
              f"warp {warp:.3f} → F3 {corrected:.0f} Hz")


def test_recogniser() -> None:
    print("\nRecogniser")
    inventory = [
        Phone("i", "IY", "vowel", "close-front", True, 280, 2250, 2890, None, None, 110, 7),
        Phone("ɑ", "AA", "vowel", "open-back", True, 730, 1090, 2440, None, None, 120, 7),
        Phone("s", "S", "fricative", "alveolar", False, None, None, None, 6600, 0.86, 100, 1),
        Phone("ʃ", "SH", "fricative", "postalveolar", False, None, None, None, 3700, 0.82, 110, 1),
        Phone("sil", "SIL", "silence", None, False, None, None, None, 200, 0.40, 90, 0),
    ]
    gap = np.zeros(int(0.25 * SR))
    x = np.concatenate([
        gap,
        synth_vowel(120, [730, 1090, 2440, 3400], 0.45),
        gap,
        noise_fricative(6600, 0.35),
        gap,
        synth_vowel(120, [280, 2250, 2890, 3400], 0.45),
        gap,
    ])
    frames = dsp.analyse(x, SR)
    rec = TemplateRecognizer().recognise(frames, inventory)
    seq = [s.ipa for s in rec.segments if s.manner != "silence"]

    check("produces segments", len(rec.segments) >= 3, f"{len(rec.segments)} segments")
    check("finds the open vowel", "ɑ" in seq, f"sequence {seq}")
    check("finds the close vowel", "i" in seq, f"sequence {seq}")
    check("prefers [s] over [ʃ] at 6.6 kHz", "s" in seq and seq.count("ʃ") <= seq.count("s"),
          f"sequence {seq}")
    check("silence recovered between tokens",
          any(s.manner == "silence" for s in rec.segments))
    post = rec.posteriors
    check("posteriors normalise", np.allclose(post.sum(axis=1), 1.0, atol=1e-6))


def test_levinson() -> None:
    print("\nLPC internals")
    # A known AR(2) process: the recovered coefficients should match.
    rng = np.random.default_rng(3)
    a1, a2 = -1.4, 0.85
    n = 4000
    e = rng.standard_normal(n)
    y = np.zeros(n)
    for i in range(2, n):
        y[i] = -a1 * y[i - 1] - a2 * y[i - 2] + e[i]
    frames = dsp.frame(y, SR, win_s=0.25, hop_s=0.25)
    coeffs, _ = dsp.lpc(frames, 2)
    got = coeffs.mean(axis=0)
    check("a1 recovered", abs(got[1] - a1) < 0.12, f"{got[1]:.3f} vs {a1}")
    check("a2 recovered", abs(got[2] - a2) < 0.12, f"{got[2]:.3f} vs {a2}")


if __name__ == "__main__":
    test_wav_roundtrip()
    test_levinson()
    test_pitch()
    test_formants()
    test_vad_and_bandwidth()
    test_vtln()
    test_recogniser()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all checks passed")
