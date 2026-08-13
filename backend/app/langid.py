"""Language identification.

PRLM, in the sense of Zissman (1996): recognise phones with one
language-independent recogniser, then score the resulting string under each
language's phonotactic model. Three further terms are added because they are
cheap and carry real information:

  * rhythm — nPVI_V / %V / ΔC separate the stress-, syllable- and mora-timed
    classes better than phonotactics does,
  * vowel-system size, inferred from how far the speaker's vowels disperse,
  * a weak speaker-population prior.

The phonotactic model is generated from two per-language numbers
(`cv_strictness`, `cluster_tol`) plus a small table of named exceptions, rather
than a full bigram matrix. See db/03_seed_phonetics.sql for why.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .phones import Phone, Recognition

VOWELISH = {"vowel"}
FLOOR_LOGP = math.log(1e-4)      # a phone the language does not have


@dataclass
class Language:
    code: str
    name: str
    family: str | None
    rhythm_class: str | None
    npvi_v_mean: float
    npvi_v_sd: float
    pct_v_mean: float
    pct_v_sd: float
    delta_c_mean: float
    delta_c_sd: float
    vowel_inventory: int
    cv_strictness: float
    cluster_tol: float
    speakers_m: float
    inventory: dict[str, float]                 # ipa -> unigram probability
    exceptions: dict[tuple[str, str], float]    # (prev, next) -> logp


@dataclass
class LangScore:
    code: str
    name: str
    family: str | None
    probability: float
    logscore: float
    parts: dict[str, float]


def bigram_matrix(lang: Language, phones: list[Phone]) -> np.ndarray:
    """log P(next | prev) over the universal phone set, for the Viterbi pass.

    Composed from the language's unigram inventory and its syllable-structure
    numbers, then overridden by any named exceptions.
    """
    k = len(phones)
    uni = np.array([lang.inventory.get(p.ipa, 1e-4) for p in phones])
    uni = uni / uni.sum()

    is_v = np.array([p.manner in VOWELISH for p in phones])
    is_sil = np.array([p.manner == "silence" for p in phones])

    cv, tol = lang.cv_strictness, lang.cluster_tol
    mult = np.ones((k, k))
    cons = ~is_v & ~is_sil
    mult[np.ix_(cons, is_v)] = 1.0 + 3.0 * cv
    mult[np.ix_(cons, cons)] = max(0.05, 1.0 - cv) * (0.3 + tol)
    mult[np.ix_(is_v, is_v)] = 0.4              # hiatus is dispreferred nearly everywhere

    m = mult * uni[None, :]
    m /= m.sum(axis=1, keepdims=True)
    out = np.log(np.maximum(m, 1e-9))

    index = {p.ipa: i for i, p in enumerate(phones)}
    for (prev, nxt), logp in lang.exceptions.items():
        if prev in index and nxt in index:
            out[index[prev], index[nxt]] = logp
    return out


def _soft_unigram(rec: Recognition, lang: Language) -> float:
    """Expected log unigram probability under this language's inventory.

    Uses frame posteriors rather than the decoded string: if a frame is
    genuinely ambiguous between [θ] and [f], a language lacking [θ] should be
    penalised in proportion to that ambiguity, not by the winner-take-all label.
    """
    if rec.posteriors is None or not rec.order:
        return 0.0
    logp = np.array([math.log(lang.inventory[i]) if i in lang.inventory else FLOOR_LOGP
                     for i in rec.order])
    mass = rec.posteriors.sum(axis=0)
    mass = mass / max(mass.sum(), 1e-9)
    return float(mass @ logp)


def _phonotactic(rec: Recognition, lang: Language, phones: list[Phone]) -> float:
    seq = [s.ipa for s in rec.segments]
    if len(seq) < 2:
        return 0.0
    bg = bigram_matrix(lang, phones)
    index = {p.ipa: i for i, p in enumerate(phones)}

    total, n = 0.0, 0
    prev = "^"
    for ipa in seq + ["$"]:
        key = (prev, ipa)
        if key in lang.exceptions:
            total += lang.exceptions[key]
        elif prev in index and ipa in index:
            total += float(bg[index[prev], index[ipa]])
        prev = ipa
        n += 1
    return total / max(n, 1)


def _rhythm(rhythm: dict[str, float], lang: Language) -> float:
    s = 0.0
    for key, mu, sd in (("npvi_v", lang.npvi_v_mean, lang.npvi_v_sd),
                        ("pct_v", lang.pct_v_mean, lang.pct_v_sd),
                        ("delta_c", lang.delta_c_mean, lang.delta_c_sd)):
        v = rhythm.get(key)
        if v is None or mu is None:
            continue
        z = (v - mu) / max(sd, 1e-6)
        s += -0.5 * min(z * z, 25.0)
    return s


def _vowel_system(rhythm: dict[str, float], lang: Language) -> float:
    """Vowel-space area is a proxy for inventory size: more contrasts, more
    dispersion. Crude, but it is the reason Spanish and English separate even
    when the phone string is a mess."""
    area = rhythm.get("vowel_area")
    if area is None or not lang.vowel_inventory:
        return 0.0
    expected = 0.35 + 0.055 * lang.vowel_inventory
    z = (area - expected) / 0.30
    return -0.5 * min(z * z, 16.0)


def identify(rec: Recognition, rhythm: dict[str, float],
             languages: list[Language], phones: list[Phone],
             weights: dict[str, float] | None = None) -> list[LangScore]:
    w = {"unigram": 6.0, "phonotactic": 4.0, "rhythm": 1.6,
         "vowels": 1.0, "prior": 0.25}
    if weights:
        w.update(weights)

    rows: list[LangScore] = []
    for lang in languages:
        parts = {
            "unigram": _soft_unigram(rec, lang),
            "phonotactic": _phonotactic(rec, lang, phones),
            "rhythm": _rhythm(rhythm, lang),
            "vowels": _vowel_system(rhythm, lang),
            "prior": math.log(max(lang.speakers_m or 1.0, 1.0)),
        }
        total = sum(w[k] * v for k, v in parts.items())
        rows.append(LangScore(lang.code, lang.name, lang.family, 0.0, total,
                              {k: round(v, 3) for k, v in parts.items()}))

    top = max(r.logscore for r in rows)
    # Temperature > 1: these scores are sums over many correlated frames, so raw
    # softmax is wildly overconfident. Flattening keeps the reported probability
    # closer to how often the answer is actually right.
    temp = 4.0
    exps = [math.exp((r.logscore - top) / temp) for r in rows]
    z = sum(exps)
    for r, e in zip(rows, exps):
        r.probability = e / z
    rows.sort(key=lambda r: -r.probability)
    return rows
