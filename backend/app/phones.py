"""Phone recognition.

A template recogniser: every phone in the inventory carries acoustic targets
(formants for sonorants, spectral moments for obstruents), each frame is scored
against every phone, and a Viterbi pass with duration and phonotactic
transition costs picks the sequence.

This is the classical approach — it is what phone recognisers did before
HMM-GMM systems, and before those became neural. It is here because it is
inspectable end to end: you can look at why a frame was called [s] rather than
[ʃ]. It is also, plainly, less accurate than a trained model. `Recognizer` is a
Protocol precisely so a wav2vec2 / Allosaurus adapter can replace it without
touching anything downstream — see ISOGLOSS_RECOGNIZER in config.py.

Vocal-tract length is normalised before any comparison. Without it the system
measures the speaker's height instead of their hometown.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol, Sequence

import numpy as np

from .dsp import Frames

REF_F3 = 2500.0            # adult-male reference third formant, for VTLN
SONORANT = {"vowel", "approximant", "nasal"}


@dataclass
class Phone:
    ipa: str
    arpa: str | None
    manner: str
    place: str | None
    voiced: bool
    f1: float | None
    f2: float | None
    f3: float | None
    centroid: float | None
    flatness: float | None
    typical_ms: float
    sonority: int


@dataclass
class Segment:
    ipa: str
    manner: str
    start_s: float
    end_s: float
    confidence: float
    f1: float = float("nan")
    f2: float = float("nan")
    f3: float = float("nan")

    @property
    def dur_ms(self) -> float:
        return (self.end_s - self.start_s) * 1000.0


@dataclass
class Recognition:
    segments: list[Segment]
    phone_string: list[str]
    warp: float                       # VTLN factor applied
    frame_labels: np.ndarray = field(repr=False, default=None)
    posteriors: np.ndarray = field(repr=False, default=None)   # (n_frames, n_phones)
    order: list[str] = field(default_factory=list)


class Recognizer(Protocol):
    def recognise(self, frames: Frames, phones: Sequence[Phone],
                  bigram: np.ndarray | None = None) -> Recognition: ...


# ---------------------------------------------------------------------------
# Vocal tract length normalisation
# ---------------------------------------------------------------------------


def estimate_warp(frames: Frames) -> float:
    """Ratio that maps this speaker's F3 onto the reference.

    F3 is used rather than F1/F2 because it is comparatively vowel-independent —
    it tracks the length of the tube, not what the tongue is doing inside it.
    """
    f3 = frames.fmt[:, 2]
    f2 = frames.fmt[:, 1]
    # LPC happily inserts a spurious pole between F2 and F3; taken as F3 it
    # drags the median down and the warp saturates at the clamp. Require the
    # candidate to sit well above F2 and above the floor of the plausible F3
    # range. Genuine r-coloured F3 lives near 1700 Hz, but a whole recording's
    # median is not going to be rhotic.
    good = (frames.speech & (frames.voicing > 0.6) & np.isfinite(f3)
            & (f3 > 1700) & (~np.isfinite(f2) | (f3 > f2 * 1.25)))
    if good.sum() < 8:
        return 1.0
    med = float(np.median(f3[good]))
    if not (1200 < med < 4200):
        return 1.0
    return float(np.clip(REF_F3 / med, 0.78, 1.30))


# ---------------------------------------------------------------------------
# Template scoring
# ---------------------------------------------------------------------------


def _relative_energy(energy: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(energy, 5), np.percentile(energy, 97)
    return np.clip((energy - lo) / max(hi - lo, 6.0), 0.0, 1.0)


def _gauss(x: np.ndarray, mu: float, sigma: float) -> np.ndarray:
    z = (x - mu) / sigma
    return -0.5 * z * z


def emission_matrix(frames: Frames, phones: Sequence[Phone], warp: float) -> np.ndarray:
    """(n_frames, n_phones) log-likelihoods."""
    n, k = frames.n, len(phones)
    out = np.full((n, k), -60.0)

    f1 = frames.fmt[:, 0] * warp
    f2 = frames.fmt[:, 1] * warp
    f3 = frames.fmt[:, 2] * warp
    cen = np.maximum(frames.centroid, 50.0)
    flat = frames.flatness
    voi = frames.voicing
    erel = _relative_energy(frames.energy)
    zcr = frames.zcr

    log_cen = np.log(cen)

    for j, p in enumerate(phones):
        if p.manner == "silence":
            # Silence must be *penalised* inside the VAD mask, not merely
            # scored. Without the penalty it quietly outbids voiceless
            # fricatives, which are low-energy and unvoiced and therefore look
            # a lot like silence frame by frame — the whole fricative gets
            # swallowed and never reaches the sociophonetic measurements.
            quiet = 4.0 * (1.0 - erel) - 6.0 * voi
            out[:, j] = np.where(frames.speech, quiet - 12.0, 6.0)
            continue

        s = np.zeros(n)

        if p.manner in SONORANT:
            # Formant match, over whichever formants were actually resolved.
            got = np.zeros(n)
            for meas, target, rel in ((f1, p.f1, 0.17), (f2, p.f2, 0.13), (f3, p.f3, 0.10)):
                if target is None:
                    continue
                ok = np.isfinite(meas)
                contrib = np.zeros(n)
                contrib[ok] = _gauss(meas[ok], target, rel * target)
                s += np.clip(contrib, -12.0, 0.0)
                got += ok
            # Nothing resolved: fall back to a weak prior rather than a lie.
            s = np.where(got > 0, s, -8.0)
            s += 3.0 * (voi - 0.5)
            if p.manner == "vowel":
                s += 3.5 * (erel - 0.4) - 2.0 * zcr
            elif p.manner == "nasal":
                # Nasals: voiced, mid-low energy, strongly periodic.
                s += 2.0 * (0.55 - abs(erel - 0.45)) - 2.0 * zcr
                s += 1.5 * (0.35 - flat)
            else:
                s += 1.5 * (0.6 - abs(erel - 0.55)) - 1.5 * zcr

        elif p.manner in ("fricative", "affricate"):
            if p.centroid:
                s += np.clip(_gauss(log_cen, math.log(p.centroid), 0.34), -12.0, 0.0)
            if p.flatness is not None:
                s += np.clip(_gauss(flat, p.flatness, 0.16), -8.0, 0.0)
            s += (3.0 * (voi - 0.5)) if p.voiced else (3.0 * (0.5 - voi))
            s += 2.0 * zcr - 1.0
            s += 1.5 * (0.6 - abs(erel - 0.35))

        elif p.manner == "stop":
            # A stop is closure then burst. Frame-locally that reads as low
            # energy with a flat, high-frequency transient; the duration model
            # in the Viterbi is what actually keeps stops short.
            s += 2.5 * (0.5 - abs(erel - 0.22))
            s += (2.0 * (voi - 0.5)) if p.voiced else (2.0 * (0.5 - voi))
            if p.centroid:
                s += 0.6 * np.clip(_gauss(log_cen, math.log(p.centroid), 0.55), -8.0, 0.0)
            s += 1.0 * (flat - 0.4)

        # Everything below the VAD floor is silence, whatever it scored.
        s = np.where(frames.speech, s, -40.0)
        out[:, j] = s

    # Silence is allowed (indeed preferred) outside the VAD mask.
    sil = [j for j, p in enumerate(phones) if p.manner == "silence"]
    if sil:
        out[~frames.speech, sil[0]] = 6.0
    return out


# ---------------------------------------------------------------------------
# Viterbi
# ---------------------------------------------------------------------------


def _transitions(phones: Sequence[Phone], hop_s: float,
                 bigram: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """Returns (log P(stay), log P(leave) + bigram)."""
    typ = np.array([max(p.typical_ms, 25.0) / 1000.0 for p in phones])
    p_leave = np.clip(hop_s / typ, 0.02, 0.7)
    log_stay = np.log(1.0 - p_leave)
    log_leave = np.log(p_leave)

    k = len(phones)
    if bigram is None:
        trans = np.full((k, k), -math.log(k))
    else:
        trans = bigram.copy()
    np.fill_diagonal(trans, -60.0)          # leaving means leaving
    trans = trans + log_leave[:, None]
    return log_stay, trans


def viterbi(emis: np.ndarray, phones: Sequence[Phone], hop_s: float,
            bigram: np.ndarray | None = None) -> np.ndarray:
    n, k = emis.shape
    log_stay, trans = _transitions(phones, hop_s, bigram)

    delta = emis[0].copy()
    back = np.zeros((n, k), dtype=np.int32)

    for t in range(1, n):
        stay = delta + log_stay
        move = delta[:, None] + trans           # (from, to)
        best_from = np.argmax(move, axis=0)
        best_move = move[best_from, np.arange(k)]

        take_stay = stay > best_move
        back[t] = np.where(take_stay, np.arange(k), best_from)
        delta = np.where(take_stay, stay, best_move) + emis[t]
        delta -= delta.max()                    # keep it in range

    path = np.zeros(n, dtype=np.int32)
    path[-1] = int(np.argmax(delta))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


class TemplateRecognizer:
    """The default, dependency-free recogniser."""

    name = "template"

    def recognise(self, frames: Frames, phones: Sequence[Phone],
                  bigram: np.ndarray | None = None) -> Recognition:
        warp = estimate_warp(frames)
        emis = emission_matrix(frames, phones, warp)
        path = viterbi(emis, phones, frames.hop_s, bigram)

        # Frame posteriors, kept because the accent features need soft evidence
        # (the TH measure is a ratio of posterior mass, not a hard count).
        shifted = emis - emis.max(axis=1, keepdims=True)
        post = np.exp(shifted)
        post /= np.maximum(post.sum(axis=1, keepdims=True), 1e-12)

        segments: list[Segment] = []
        for a, b in _label_runs(path):
            p = phones[path[a]]
            conf = float(post[a:b, path[a]].mean())
            f = frames.fmt[a:b] * warp
            # An all-NaN column is normal (obstruents have no resolvable
            # formants), so take the median only over columns that have data.
            mids = np.full(f.shape[1], np.nan)
            for c in range(f.shape[1]):
                col = f[:, c][np.isfinite(f[:, c])]
                if col.size:
                    mids[c] = np.median(col)
            segments.append(Segment(
                ipa=p.ipa, manner=p.manner,
                start_s=a * frames.hop_s, end_s=b * frames.hop_s,
                confidence=conf, f1=float(mids[0]), f2=float(mids[1]), f3=float(mids[2])))

        return Recognition(
            segments=segments,
            phone_string=[s.ipa for s in segments if s.manner != "silence"],
            warp=warp, frame_labels=path, posteriors=post,
            order=[p.ipa for p in phones])


def _label_runs(path: np.ndarray) -> list[tuple[int, int]]:
    if len(path) == 0:
        return []
    edges = np.nonzero(np.diff(path))[0] + 1
    bounds = np.concatenate(([0], edges, [len(path)]))
    return [(int(bounds[i]), int(bounds[i + 1])) for i in range(len(bounds) - 1)]
