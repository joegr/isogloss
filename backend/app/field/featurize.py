"""Raw audio → a fixed-length acoustic vector, and per-phone production rates.

This is the deterministic half of the encoder: numpy only, no learned
parameters, and the same code path the analyser uses (audio.prepare →
dsp.analyse → the template recogniser → accent.measure). The learned half — a
projection trained against geography — lives in model.py.

Four blocks, concatenated (docs/AUDIO_FIELD.md §2):

  cepstral   24   mean and SD of MFCC 1..12 over speech frames — spectral envelope
  prosody     4   f0 SD and range in semitones, voiced share, segment rate
  phonology  28   expected distinctive-feature bundle, Σ_p P(p|t)·F[p] averaged
                  over speech frames — phonemescape's feature space
  accent     14   the sociophonetic measurements of accent.py, NaN where the
                  analyser could not measure them reliably

Every recording is decoded with the *language-neutral* phonotactic model. The
analyser re-decodes under the identified language because that measures better;
here consistency matters more than accuracy, since an embedding that changes
with a language decision would put a language-ID error straight into the
geography.

`FEATURE_VERSION` names this recipe. Recordings store their raw audio, so a
change here is followed by re-featurising the store rather than re-collecting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .. import accent, audio, dsp
from ..phones import Phone, TemplateRecognizer
from . import phonology

FEATURE_VERSION = "f1"

ACCENT_KEYS = ("npvi_v", "pct_v", "delta_c", "vowel_area", "rhoticity", "goose_f2",
               "trap_bath", "low_back_merge", "diph_index", "vot_ms", "f0_span",
               "final_rise", "t_glottal", "th_shift")
MIN_RELIABILITY = 0.10


def feature_names() -> list[str]:
    from phonemescape.features import FEATURE_NAMES
    return ([f"mfcc{i}_mean" for i in range(1, 13)]
            + [f"mfcc{i}_sd" for i in range(1, 13)]
            + ["f0_sd_st", "f0_range_st", "voiced_share", "segment_rate"]
            + [f"df_{n}" for n in FEATURE_NAMES]
            + [f"acc_{k}" for k in ACCENT_KEYS])


BLOCKS = {"cepstral": (0, 24), "prosody": (24, 28), "phonology": (28, 56),
          "accent": (56, 70)}


@dataclass
class Featurized:
    vector: np.ndarray                 # (70,), NaN = not measurable
    phone_rates: np.ndarray            # (n_phones,), share of speech frames
    speech_frames: int
    duration_s: float
    phone_string: str
    notes: list[str] = field(default_factory=list)
    version: str = FEATURE_VERSION


def featurize(data: bytes, inventory: Sequence[Phone]) -> Featurized:
    """WAV bytes → Featurized. Raises audio.AudioError on unusable audio."""
    x, sr = audio.prepare(data)
    return featurize_samples(x, sr, inventory)


def featurize_samples(x: np.ndarray, sr: int, inventory: Sequence[Phone]) -> Featurized:
    frames = dsp.analyse(x, sr)
    rec = TemplateRecognizer().recognise(frames, inventory, bigram=None)
    meas = accent.measure(frames, rec)

    speech = frames.speech
    notes: list[str] = []
    if speech.sum() < 20:
        notes.append("under 0.2 s of detected speech; the vector is mostly noise")
        speech = np.ones_like(speech)

    # -- cepstral ------------------------------------------------------------
    c = frames.mfcc[speech][:, 1:13]
    cep = np.concatenate([c.mean(axis=0), c.std(axis=0)])

    # -- prosody -------------------------------------------------------------
    f0 = frames.f0[speech]
    f0 = f0[np.isfinite(f0) & (f0 > 0)]
    if f0.size >= 10:
        st = 12.0 * np.log2(f0 / np.median(f0))
        f0_sd, f0_rng = float(st.std()), float(np.percentile(st, 90) - np.percentile(st, 10))
    else:
        f0_sd = f0_rng = np.nan
    voiced = float((frames.voicing[speech] > 0.5).mean())
    speech_s = max(speech.sum() * frames.hop_s, 1e-3)
    n_seg = sum(1 for s in rec.segments if s.manner != "silence")
    pros = np.array([f0_sd, f0_rng, voiced, n_seg / speech_s])

    # -- phonology: posteriors through the distinctive-feature matrix ----------
    symbols = [p.ipa for p in inventory]
    post = rec.posteriors[speech]                       # (t, n_phones)
    rates = post.mean(axis=0)
    F = phonology.feature_matrix(symbols)               # (n_phones, 28)
    sil = np.array([p.manner == "silence" for p in inventory])
    sound = post[:, ~sil]
    mass = np.maximum(sound.sum(axis=1, keepdims=True), 1e-9)
    phon = ((sound / mass) @ F[~sil]).mean(axis=0)

    # -- accent ----------------------------------------------------------------
    acc = np.array([meas[k].value if k in meas and meas[k].reliability >= MIN_RELIABILITY
                    else np.nan for k in ACCENT_KEYS], dtype=float)

    vec = np.concatenate([cep, pros, phon, acc]).astype(float)
    return Featurized(vector=vec, phone_rates=rates.astype(float),
                      speech_frames=int(frames.speech.sum()),
                      duration_s=round(len(x) / sr, 3),
                      phone_string=" ".join(rec.phone_string), notes=notes)
