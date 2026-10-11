"""The bridge to phonemescape: phones → distinctive features → natural classes.

The recogniser emits a posterior over the inventory in db/03_seed_phonetics.sql
for every frame. Multiplying that posterior by the inventory's feature matrix
gives the *expected* distinctive-feature bundle of each frame,

    E[f | frame t] = Σ_p P(p | t) · F[p, :]          F ∈ {-1, 0, +1}^(phones × 28)

which is a phonological description of the audio that does not depend on the
recogniser having picked the right phone, only on it having spread its mass
over phonetically similar ones. Averaged over speech frames it is one block of
the embedding (featurize.py); restricted to a natural class it is the target of
a sound-production surface (model.py, docs/AUDIO_FIELD.md §8).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Sequence

import numpy as np

from ._paths import ensure_phonemescape

ensure_phonemescape()

from phonemescape.features import FEATURE_NAMES  # noqa: E402
from phonemescape.segments import get_segment  # noqa: E402

TIE = "͡"


def resolve(ipa: str):
    """phonemescape Segment for an inventory symbol, or None for silence.

    The seed writes affricates without the tie bar (tʃ, dʒ, ts); IPA proper
    ties them, so try that spelling before giving up."""
    for spelling in (ipa, ipa[0] + TIE + ipa[1:] if len(ipa) == 2 else None):
        if not spelling:
            continue
        try:
            return get_segment(spelling)
        except (ValueError, KeyError):
            continue
    return None


@lru_cache(maxsize=8)
def _matrix(symbols: tuple[str, ...]) -> np.ndarray:
    out = np.zeros((len(symbols), len(FEATURE_NAMES)))
    for i, s in enumerate(symbols):
        seg = resolve(s)
        if seg is not None:
            out[i] = seg.feature_vector
    return out


def feature_matrix(symbols: Sequence[str]) -> np.ndarray:
    """(n_phones, 28) in {-1, 0, +1}; silence and unknown symbols are all-zero."""
    return _matrix(tuple(symbols))


def natural_class(symbols: Sequence[str], **spec: str) -> list[int]:
    """Indices of inventory phones matching a feature spec, e.g. strident='+'.

    Same vocabulary as phonemescape's `natural_class`: '+', '-' or '0' per
    feature name."""
    unknown = set(spec) - set(FEATURE_NAMES)
    if unknown:
        raise ValueError(f"unknown features: {sorted(unknown)}")
    want = {k: {"+": 1, "-": -1, "0": 0}[str(v)] for k, v in spec.items()}
    F = feature_matrix(symbols)
    col = {n: j for j, n in enumerate(FEATURE_NAMES)}
    hits = []
    for i, s in enumerate(symbols):
        if resolve(s) is None:
            continue
        if all(F[i, col[k]] == v for k, v in want.items()):
            hits.append(i)
    return hits


def target_indices(symbols: Sequence[str], target: str) -> tuple[list[int], str]:
    """Parse a production target: one IPA symbol ('θ'), or a natural class
    written as comma-separated feature values ('+strident,-voice')."""
    target = target.strip()
    if any(c in target for c in "+-=") and not resolve(target):
        spec = {}
        for part in target.split(","):
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
            else:
                v, k = part[0], part[1:]
            spec[k.strip()] = v.strip()
        idx = natural_class(symbols, **spec)
        label = "[" + " ".join(f"{v}{k}" for k, v in spec.items()) + "]"
    else:
        seg = resolve(target)
        idx = [i for i, s in enumerate(symbols)
               if s == target or (seg is not None and resolve(s) == seg)]
        label = f"[{target}]"
    if not idx:
        raise ValueError(f"no inventory phone matches {target!r}")
    return idx, label
