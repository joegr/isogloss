"""Sociophonetic measurement.

Turns frames + a phone segmentation into the 14-dimensional accent vector that
db/05_seed_sites.sql defines. Every measurement comes back with a reliability
in [0, 1], and that number is not decoration: it is the per-feature weight in
the geolocation likelihood (docs/DIFFUSION.md §6). A feature measured from
three tokens of narrowband audio should not be allowed to move the posterior,
and here it cannot.

Deliberately ASR-free. Without a word transcript you cannot identify Wells'
lexical sets, so nothing here pretends to: the vowel measurements describe the
*geometry* of the speaker's vowel distribution rather than the position of any
named vowel. That geometry still separates the major varieties, and it degrades
honestly rather than silently.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.spatial import ConvexHull, QhullError

from .dsp import Frames
from .phones import Recognition, Segment

VOWEL = "vowel"
SILENCE = "silence"


@dataclass
class Measurement:
    key: str
    value: float
    reliability: float
    tokens: int
    note: str = ""


def _reliability(n: int, need: float) -> float:
    return float(n / (n + need)) if n > 0 else 0.0


def _vowels(rec: Recognition, min_ms: float = 40.0) -> list[Segment]:
    return [s for s in rec.segments if s.manner == VOWEL and s.dur_ms >= min_ms]


def _consonant_intervals(rec: Recognition) -> list[float]:
    """Durations (ms) of maximal runs of non-vocalic, non-silent material."""
    out, run = [], 0.0
    for s in rec.segments:
        if s.manner == SILENCE:
            if run > 0:
                out.append(run)
            run = 0.0
        elif s.manner == VOWEL:
            if run > 0:
                out.append(run)
            run = 0.0
        else:
            run += s.dur_ms
    if run > 0:
        out.append(run)
    return out


def _lobanov(vowels: list[Segment]) -> tuple[np.ndarray, np.ndarray]:
    """z-score F1/F2 within speaker. Returns (points (n,2), mask of usable)."""
    f1 = np.array([v.f1 for v in vowels])
    f2 = np.array([v.f2 for v in vowels])
    ok = np.isfinite(f1) & np.isfinite(f2)
    pts = np.full((len(vowels), 2), np.nan)
    if ok.sum() >= 3:
        z1 = (f1[ok] - f1[ok].mean()) / max(f1[ok].std(), 1e-6)
        z2 = (f2[ok] - f2[ok].mean()) / max(f2[ok].std(), 1e-6)
        pts[ok, 0], pts[ok, 1] = z1, z2
    return pts, ok


def _two_means(x: np.ndarray, iters: int = 25) -> float:
    """Separation between two 1-D clusters, in units of the overall SD."""
    if len(x) < 6:
        return float("nan")
    lo, hi = np.percentile(x, 20), np.percentile(x, 80)
    if hi - lo < 1e-9:
        return 0.0
    c = np.array([lo, hi])
    for _ in range(iters):
        d = np.abs(x[:, None] - c[None, :])
        lab = np.argmin(d, axis=1)
        for j in (0, 1):
            if (lab == j).any():
                c[j] = x[lab == j].mean()
    return float(abs(c[1] - c[0]) / max(x.std(), 1e-6))


# ---------------------------------------------------------------------------
# The measurements
# ---------------------------------------------------------------------------


def measure(frames: Frames, rec: Recognition) -> dict[str, Measurement]:
    vowels = _vowels(rec)
    pts, ok = _lobanov(vowels)
    warp = rec.warp
    band = frames.bandwidth_hz
    m: dict[str, Measurement] = {}

    def put(key, value, rel, tokens, note=""):
        if value is None or not np.isfinite(value):
            m[key] = Measurement(key, float("nan"), 0.0, tokens, note or "not measurable")
        else:
            m[key] = Measurement(key, float(value), float(np.clip(rel, 0, 1)), tokens, note)

    # -- rhythm ------------------------------------------------------------
    vdur = np.array([v.dur_ms for v in vowels])
    if len(vdur) >= 3:
        d1, d2 = vdur[:-1], vdur[1:]
        npvi = 100.0 * np.mean(np.abs(d1 - d2) / np.maximum((d1 + d2) / 2, 1e-6))
    else:
        npvi = None
    put("npvi_v", npvi, _reliability(len(vdur), 12), len(vdur))

    cdur = _consonant_intervals(rec)
    speech_ms = float(frames.speech.sum() * frames.hop_s * 1000.0)
    pct_v = 100.0 * vdur.sum() / speech_ms if speech_ms > 0 and len(vdur) else None
    put("pct_v", pct_v, _reliability(len(vdur), 10), len(vdur))
    put("delta_c", float(np.std(cdur)) if len(cdur) >= 3 else None,
        _reliability(len(cdur), 10), len(cdur))

    # -- vowel space -------------------------------------------------------
    formant_gate = 1.0 if band >= 3400 else 0.4
    good = pts[ok] if ok.any() else np.zeros((0, 2))
    area = None
    if len(good) >= 5:
        try:
            area = float(ConvexHull(good).volume) / 6.0     # ~1.0 for a full system
        except QhullError:
            area = None
    put("vowel_area", area, formant_gate * _reliability(len(good), 14), len(good),
        "" if band >= 3400 else f"narrowband audio ({band:.0f} Hz)")

    # -- rhoticity ---------------------------------------------------------
    # F3 is the whole measurement, so bandwidth is a hard gate rather than a
    # discount: below ~3.5 kHz there is no F3 in the file to look at.
    f3_all = frames.fmt[:, 2] * warp
    med_f3 = float(np.nanmedian(f3_all[frames.speech])) if frames.speech.any() else np.nan
    rho, n_rho = None, 0
    if np.isfinite(med_f3) and vowels:
        hits = []
        for v in vowels:
            a = int(v.start_s / frames.hop_s)
            b = max(a + 1, int(v.end_s / frames.hop_s))
            tail = f3_all[a + int(0.6 * (b - a)) : b]
            tail = tail[np.isfinite(tail)]
            if tail.size == 0:
                continue
            f2tail = frames.fmt[a + int(0.6 * (b - a)) : b, 1] * warp
            f2tail = f2tail[np.isfinite(f2tail)]
            lowered = float(tail.min()) < 0.84 * med_f3
            close = f2tail.size > 0 and (float(tail.min()) - float(f2tail.min())) < 900
            hits.append(1.0 if (lowered and close) else 0.0)
        if hits:
            rho, n_rho = float(np.mean(hits)), len(hits)
    band_gate = 1.0 if band >= 3800 else (0.15 if band >= 3200 else 0.0)
    put("rhoticity", rho, band_gate * _reliability(n_rho, 10), n_rho,
        "" if band >= 3800 else f"F3 unreliable at {band:.0f} Hz bandwidth")

    # -- vowel-space geometry ---------------------------------------------
    f1w = np.array([v.f1 for v in vowels]) * 1.0
    f2w = np.array([v.f2 for v in vowels]) * 1.0
    valid = np.isfinite(f1w) & np.isfinite(f2w)

    goose = trap = merge = None
    n_high = n_low = n_back = 0
    if valid.sum() >= 6:
        z1, z2 = pts[valid, 0], pts[valid, 1]
        raw2 = f2w[valid]
        raw1 = f1w[valid]

        high = z1 < -0.25
        n_high = int(high.sum())
        if n_high >= 3:
            back_of_high = raw2[high] <= np.median(raw2[high])
            goose = float(np.clip((raw2[high][back_of_high].mean() - 900) / 1000.0, 0, 1))

        low = z1 > 0.35
        n_low = int(low.sum())
        if n_low >= 6:
            trap = float(np.clip(_two_means(z2[low]) / 2.0, 0, 1))

        back = z2 < -0.35
        n_back = int(back.sum())
        if n_back >= 6:
            merge = float(np.clip(1.0 - _two_means(z1[back]) / 1.6, 0, 1))

    put("goose_f2", goose, formant_gate * _reliability(n_high, 8), n_high)
    put("trap_bath", trap, formant_gate * _reliability(n_low, 12), n_low)
    put("low_back_merge", merge, formant_gate * _reliability(n_back, 12), n_back)

    # -- diphthongisation --------------------------------------------------
    traj, n_traj = [], 0
    if ok.any():
        f1s, f2s = frames.fmt[:, 0] * warp, frames.fmt[:, 1] * warp
        mu1, sd1 = np.nanmean(f1s[frames.speech]), np.nanstd(f1s[frames.speech])
        mu2, sd2 = np.nanmean(f2s[frames.speech]), np.nanstd(f2s[frames.speech])
        for v in vowels:
            if v.dur_ms < 90:
                continue
            a = int(v.start_s / frames.hop_s)
            b = max(a + 2, int(v.end_s / frames.hop_s))
            i, j = a + int(0.2 * (b - a)), a + int(0.8 * (b - a))
            if not (np.isfinite(f1s[i]) and np.isfinite(f1s[j])
                    and np.isfinite(f2s[i]) and np.isfinite(f2s[j])):
                continue
            d1 = (f1s[j] - f1s[i]) / max(sd1, 1e-6)
            d2 = (f2s[j] - f2s[i]) / max(sd2, 1e-6)
            traj.append(math.hypot(d1, d2))
        n_traj = len(traj)
    put("diph_index", float(np.clip(np.mean(traj) / 2.2, 0, 1)) if n_traj >= 3 else None,
        formant_gate * _reliability(n_traj, 8), n_traj)

    # -- VOT ---------------------------------------------------------------
    vots = []
    for i, s in enumerate(rec.segments):
        if s.manner != "stop" or s.ipa not in ("p", "t", "k"):
            continue
        end = int(s.end_s / frames.hop_s)
        for t in range(end, min(end + 14, frames.n)):
            if frames.voicing[t] > 0.6:
                vots.append((t - end) * frames.hop_s * 1000.0)
                break
    put("vot_ms", float(np.median(vots)) if len(vots) >= 2 else None,
        _reliability(len(vots), 6), len(vots))

    # -- intonation --------------------------------------------------------
    f0 = frames.f0[frames.speech]
    f0 = f0[np.isfinite(f0)]
    span = None
    if f0.size >= 20:
        # 10th/90th rather than 5th/95th: the tails of an autocorrelation pitch
        # track are where its octave errors live, and this is a range statistic.
        lo, hi = np.percentile(f0, 10), np.percentile(f0, 90)
        if lo > 0:
            span = 12.0 * math.log2(hi / lo)
    put("f0_span", span, _reliability(int(f0.size), 60), int(f0.size))

    rises, n_phr = _final_rises(frames)
    put("final_rise", rises, _reliability(n_phr, 4), n_phr)

    # -- variant ratios from posterior mass --------------------------------
    put("t_glottal", *_posterior_ratio(rec, {"ʔ"}, {"t", "ʔ"}))
    put("th_shift", *_posterior_ratio(rec, {"f", "v", "t", "d", "s", "z"},
                                      {"θ", "ð", "f", "v", "t", "d", "s", "z"},
                                      anchor={"θ", "ð"}))
    return m


def _final_rises(frames: Frames) -> tuple[float | None, int]:
    """Fraction of phrases ending on a rise.

    Phrases are runs of speech separated by >=200 ms of silence; the contour is
    the last 300 ms of voiced f0, fitted in semitones per second.
    """
    mask = frames.speech
    if mask.sum() < 20:
        return None, 0
    edges = np.nonzero(np.diff(mask.astype(int)))[0] + 1
    bounds = np.concatenate(([0], edges, [len(mask)]))

    phrases, i = [], 0
    while i < len(bounds) - 1:
        a, b = bounds[i], bounds[i + 1]
        if mask[a] and (b - a) >= 25:
            phrases.append((a, b))
        i += 1

    rises = 0
    counted = 0
    for a, b in phrases:
        w = frames.f0[max(a, b - 30) : b]
        t = np.arange(len(w)) * frames.hop_s
        good = np.isfinite(w)
        if good.sum() < 8:
            continue
        st = 12.0 * np.log2(np.maximum(w[good], 1e-6) / np.nanmedian(w[good]))
        slope = float(np.polyfit(t[good], st, 1)[0])
        counted += 1
        if slope > 1.5:
            rises += 1
    if counted == 0:
        return None, 0
    return rises / counted, counted


def _posterior_ratio(rec: Recognition, numerator: set[str], denominator: set[str],
                     anchor: set[str] | None = None) -> tuple[float | None, float, int]:
    """Share of posterior mass on `numerator` within `denominator`.

    Soft rather than counted, because the whole point of these variables is that
    the competing realisations are acoustically close. `anchor` restricts the
    frames considered to those where the conservative variant was at least in
    contention — otherwise every [s] in the recording dilutes the ratio.
    """
    if rec.posteriors is None or not rec.order:
        return None, 0.0, 0
    idx = {ipa: i for i, ipa in enumerate(rec.order)}
    num = [idx[i] for i in numerator if i in idx]
    den = [idx[i] for i in denominator if i in idx]
    if not num or not den:
        return None, 0.0, 0

    post = rec.posteriors
    rows = post[:, den].sum(axis=1) > 0.35
    if anchor:
        anc = [idx[i] for i in anchor if i in idx]
        if anc:
            rows &= post[:, anc].sum(axis=1) > 0.02
    n = int(rows.sum())
    if n < 4:
        return None, 0.0, n
    num_mass = post[rows][:, num].sum()
    den_mass = post[rows][:, den].sum()
    return float(num_mass / max(den_mass, 1e-9)), _reliability(n, 25), n


def summarise_rhythm(m: dict[str, Measurement]) -> dict[str, float]:
    """The subset language identification needs."""
    out = {}
    for k in ("npvi_v", "pct_v", "delta_c", "vowel_area"):
        v = m.get(k)
        if v and np.isfinite(v.value) and v.reliability > 0.2:
            out[k] = v.value
    return out
