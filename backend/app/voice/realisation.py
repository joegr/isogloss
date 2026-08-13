"""Accent vector → realisation table.

This is `accent.py` run backwards. Every rule here is the generative statement
of a measurement there, and the symmetry is deliberate: if the two ever disagree
about what `trap_bath = 0.9` means, `voice/evaluate.py` catches it, because a
synthesised Brighton will not measure as Brighton.

Base formant values are adult-male references in the Peterson–Barney /
Hillenbrand tradition. The speaker's vocal tract length scales all of them
uniformly at the end, which is precisely the transform `phones.estimate_warp`
undoes on the way back in.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, replace

from .lexicon import RHOTIC_SETS


@dataclass
class Vowel:
    f1: float
    f2: float
    f3: float
    dur_ms: float
    off: tuple[float, float, float] | None = None   # diphthong offglide target
    rhotic: bool = False
    nasal: float = 0.0


@dataclass
class Consonant:
    kind: str                       # stop | nasal | fricative | approximant | affricate
    voiced: bool
    locus: tuple[float, float, float]
    dur_ms: float = 70.0
    fric_cf: float = 4000.0
    fric_bw: float = 1800.0
    burst_cf: float = 2000.0
    aspirated: bool = False


# ---------------------------------------------------------------------------
# Bases
# ---------------------------------------------------------------------------

BASE_VOWELS: dict[str, Vowel] = {
    "KIT":     Vowel(400, 1900, 2550, 95),
    "DRESS":   Vowel(550, 1770, 2490, 105),
    "TRAP":    Vowel(690, 1660, 2450, 135),
    "LOT":     Vowel(620, 1000, 2500, 115),
    "STRUT":   Vowel(620, 1200, 2550, 100),
    "FOOT":    Vowel(450, 1100, 2400, 95),
    "CLOTH":   Vowel(600, 900, 2450, 130),
    "BATH":    Vowel(690, 1660, 2450, 165),          # rewritten below
    "NURSE":   Vowel(500, 1450, 2350, 185, rhotic=True),
    "FLEECE":  Vowel(300, 2250, 2900, 175, off=(280, 2320, 2900)),
    "FACE":    Vowel(450, 2000, 2600, 195, off=(350, 2350, 2800)),
    "PALM":    Vowel(730, 1100, 2500, 195),
    "THOUGHT": Vowel(570, 840, 2400, 195),
    "GOAT":    Vowel(500, 1250, 2400, 195, off=(400, 900, 2350)),
    "GOOSE":   Vowel(310, 900, 2200, 180, off=(300, 1000, 2250)),
    "PRICE":   Vowel(720, 1300, 2500, 215, off=(350, 2100, 2700)),
    "CHOICE":  Vowel(500, 800, 2400, 225, off=(350, 2050, 2700)),
    "MOUTH":   Vowel(700, 1400, 2500, 220, off=(400, 900, 2300)),
    "NEAR":    Vowel(400, 2050, 2700, 210, off=(500, 1500, 2400), rhotic=True),
    "SQUARE":  Vowel(550, 1850, 2500, 200, off=(520, 1500, 2400), rhotic=True),
    "START":   Vowel(730, 1150, 2450, 205, rhotic=True),
    "NORTH":   Vowel(570, 850, 2400, 195, rhotic=True),
    "FORCE":   Vowel(450, 900, 2350, 195, rhotic=True),
    "CURE":    Vowel(400, 1050, 2300, 200, off=(500, 1500, 2400), rhotic=True),
    "happY":   Vowel(350, 2150, 2800, 95),
    "lettER":  Vowel(500, 1450, 2350, 80, rhotic=True),
    "commA":   Vowel(500, 1500, 2450, 60),
}

BASE_CONSONANTS: dict[str, Consonant] = {
    "p":  Consonant("stop", False, (300, 800, 2100), 85, burst_cf=1100, aspirated=True),
    "b":  Consonant("stop", True, (300, 800, 2100), 70, burst_cf=900),
    "t":  Consonant("stop", False, (350, 1750, 2600), 85, burst_cf=4200, aspirated=True),
    "d":  Consonant("stop", True, (350, 1750, 2600), 68, burst_cf=3400),
    "k":  Consonant("stop", False, (300, 1900, 2400), 90, burst_cf=2100, aspirated=True),
    "g":  Consonant("stop", True, (300, 1900, 2400), 72, burst_cf=1800),
    "ʔ":  Consonant("stop", False, (400, 1500, 2400), 55, burst_cf=700),
    "m":  Consonant("nasal", True, (300, 900, 2200), 72),
    "n":  Consonant("nasal", True, (300, 1600, 2600), 68),
    "ŋ":  Consonant("nasal", True, (300, 2000, 2600), 78),
    "f":  Consonant("fricative", False, (300, 900, 2200), 95, fric_cf=5400, fric_bw=2600),
    "v":  Consonant("fricative", True, (300, 900, 2200), 70, fric_cf=4600, fric_bw=2400),
    "θ":  Consonant("fricative", False, (350, 1500, 2500), 95, fric_cf=5800, fric_bw=3000),
    "ð":  Consonant("fricative", True, (350, 1500, 2500), 55, fric_cf=4200, fric_bw=2600),
    "s":  Consonant("fricative", False, (350, 1700, 2600), 105, fric_cf=6600, fric_bw=1200),
    "z":  Consonant("fricative", True, (350, 1700, 2600), 80, fric_cf=5900, fric_bw=1300),
    "ʃ":  Consonant("fricative", False, (350, 1900, 2500), 110, fric_cf=3700, fric_bw=1200),
    "ʒ":  Consonant("fricative", True, (350, 1900, 2500), 85, fric_cf=3400, fric_bw=1300),
    "h":  Consonant("fricative", False, (500, 1500, 2500), 62, fric_cf=1600, fric_bw=3500),
    "tʃ": Consonant("affricate", False, (350, 1900, 2500), 120, fric_cf=3900, fric_bw=1300,
                    burst_cf=3900),
    "dʒ": Consonant("affricate", True, (350, 1900, 2500), 100, fric_cf=3300, fric_bw=1400,
                    burst_cf=3300),
    "l":  Consonant("approximant", True, (400, 1400, 2700), 70),
    "ɫ":  Consonant("approximant", True, (450, 800, 2600), 80),
    "ɹ":  Consonant("approximant", True, (350, 1100, 1600), 70),
    "w":  Consonant("approximant", True, (300, 700, 2200), 62),
    "j":  Consonant("approximant", True, (280, 2100, 3000), 58),
}

DEFAULTS = {
    "rhoticity": 0.5, "npvi_v": 60, "pct_v": 40, "delta_c": 50, "vowel_area": 1.0,
    "goose_f2": 0.5, "trap_bath": 0.5, "low_back_merge": 0.5, "diph_index": 0.6,
    "vot_ms": 60, "f0_span": 7.0, "final_rise": 0.25, "t_glottal": 0.3, "th_shift": 0.3,
}


@dataclass
class Voice:
    """The speaker, as distinct from the accent."""
    name: str = "default"
    tract: float = 1.0        # <1 longer tract (lower formants), >1 shorter
    f0_base: float = 118.0    # Hz
    rate: float = 1.0         # speaking rate multiplier

VOICES = {
    "male":   Voice("male", tract=1.00, f0_base=112.0),
    "female": Voice("female", tract=1.17, f0_base=196.0),
    "child":  Voice("child", tract=1.35, f0_base=250.0),
}


# ---------------------------------------------------------------------------


@dataclass
class Realisation:
    features: dict[str, float]
    voice: Voice
    vowels: dict[str, Vowel]
    consonants: dict[str, Consonant]
    th_strategy: str = "fronting"
    notes: list[str] = field(default_factory=list)

    def vowel(self, name: str) -> Vowel:
        return self.vowels[name]

    def consonant(self, ipa: str) -> Consonant:
        if ipa not in self.consonants:
            raise KeyError(f"no realisation for {ipa!r}; the inventory in "
                           f"voice/lexicon.py may have drifted from this table")
        return self.consonants[ipa]


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _lerp3(a: tuple[float, float, float], b: tuple[float, float, float],
           t: float) -> tuple[float, float, float]:
    return tuple(_lerp(x, y, t) for x, y in zip(a, b))


def _fmt(v: Vowel) -> tuple[float, float, float]:
    return (v.f1, v.f2, v.f3)


def realise(features: dict[str, float], voice: Voice | str = "male") -> Realisation:
    f = dict(DEFAULTS)
    f.update({k: v for k, v in features.items() if v is not None})
    if isinstance(voice, str):
        voice = VOICES.get(voice, VOICES["male"])

    V = {k: replace(v) for k, v in BASE_VOWELS.items()}
    notes: list[str] = []

    # -- LOT / THOUGHT merger ----------------------------------------------
    m = f["low_back_merge"]
    lot, tho = _fmt(V["LOT"]), _fmt(V["THOUGHT"])
    mid = tuple((a + b) / 2 for a, b in zip(lot, tho))
    V["LOT"].f1, V["LOT"].f2, V["LOT"].f3 = _lerp3(lot, mid, m)
    V["THOUGHT"].f1, V["THOUGHT"].f2, V["THOUGHT"].f3 = _lerp3(tho, mid, m)
    V["THOUGHT"].dur_ms = _lerp(195, 140, m)          # merged reflex is shorter
    V["CLOTH"] = replace(V["THOUGHT"], dur_ms=130)
    if m > 0.7:
        notes.append("LOT and THOUGHT merged")

    # -- TRAP / BATH split --------------------------------------------------
    t = f["trap_bath"]
    V["BATH"].f1, V["BATH"].f2, V["BATH"].f3 = _lerp3(_fmt(V["TRAP"]), _fmt(V["PALM"]), t)
    V["BATH"].dur_ms = _lerp(140, 200, t)
    notes.append(f"BATH is {'PALM-like' if t > 0.6 else 'TRAP-like' if t < 0.4 else 'intermediate'}")

    # -- GOOSE fronting (drags FOOT with it) --------------------------------
    g = f["goose_f2"]
    V["GOOSE"].f2 = _lerp(900, 1900, g)
    V["GOOSE"].off = (V["GOOSE"].off[0], V["GOOSE"].f2 + 90, V["GOOSE"].off[2])
    V["FOOT"].f2 = _lerp(1050, 1500, g)
    V["GOAT"].off = (V["GOAT"].off[0], _lerp(850, 1350, g), V["GOAT"].off[2])

    # -- diphthong excursion ------------------------------------------------
    # `diph_index` is measured as trajectory length, so here it *is* the
    # trajectory length: the offglide target moves toward or away from the onset.
    scale = 0.25 + 1.35 * f["diph_index"]
    for name, v in V.items():
        if v.off is not None:
            v.off = tuple(_lerp(on, off, scale) for on, off in zip(_fmt(v), v.off))

    # -- rhoticity ----------------------------------------------------------
    r = f["rhoticity"]
    for name in RHOTIC_SETS:
        v = V[name]
        # r-colouring is F3 lowering, which is exactly what accent.py measures.
        v.f3 = _lerp(v.f3, 1700, r)
        v.f2 = _lerp(v.f2, v.f2 * 0.93, r)
        if name in {"NEAR", "SQUARE", "CURE"} and v.off is not None:
            # The centring offglide belongs to non-rhotic varieties; a rhotic
            # speaker goes to an r-coloured steady state instead.
            v.off = tuple(_lerp(o, n, r) for o, n in zip(v.off, (v.f1, v.f2, 1700)))
        if name in {"START", "NORTH", "FORCE", "NURSE"}:
            v.dur_ms = _lerp(v.dur_ms * 1.12, v.dur_ms, r)   # compensatory length
    notes.append("rhotic" if r > 0.55 else "non-rhotic" if r < 0.3 else "variably rhotic")

    # -- vowel space dispersion --------------------------------------------
    area = f["vowel_area"]
    cx = sum(v.f1 for v in V.values()) / len(V)
    cy = sum(v.f2 for v in V.values()) / len(V)
    disp = max(0.35, area) ** 0.5          # area scales as the square of length
    for v in V.values():
        v.f1 = cx + (v.f1 - cx) * disp
        v.f2 = cy + (v.f2 - cy) * disp
        if v.off is not None:
            v.off = (cx + (v.off[0] - cx) * disp, cy + (v.off[1] - cy) * disp, v.off[2])

    # -- consonants ---------------------------------------------------------
    C = {k: replace(v) for k, v in BASE_CONSONANTS.items()}
    vot = f["vot_ms"]
    for ipa in ("p", "t", "k"):
        C[ipa].dur_ms = 55 + 0.45 * vot
    notes.append(f"VOT {vot:.0f} ms")

    # TH: fronting ([f v]) versus stopping ([t d]) are different changes with
    # different geographies, and the acoustics separate them poorly — accent.py
    # measures them as one number and says so. The tie is broken the same way a
    # dialectologist would: stopping is the Irish/New York pattern, which
    # co-occurs with rhoticity and a wide pitch span.
    th_strategy = "stopping" if (r > 0.5 and f["f0_span"] > 9.0) else "fronting"

    # -- speaker ------------------------------------------------------------
    for v in V.values():
        v.f1 *= voice.tract
        v.f2 *= voice.tract
        v.f3 *= voice.tract
        if v.off is not None:
            v.off = tuple(x * voice.tract for x in v.off)
    for c in C.values():
        c.locus = tuple(x * voice.tract for x in c.locus)
        c.fric_cf *= (1 + (voice.tract - 1) * 0.5)
        c.burst_cf *= (1 + (voice.tract - 1) * 0.5)

    return Realisation(features=f, voice=voice, vowels=V, consonants=C,
                       th_strategy=th_strategy, notes=notes)


# ---------------------------------------------------------------------------
# Variable rules
# ---------------------------------------------------------------------------
# Sociolinguistic variables are *variable*: t-glottalling at 0.6 means most
# tokens, not all. Deterministic hashing rather than an RNG so that the same
# phrase in the same accent renders identically every time — which the
# round-trip harness relies on.


def _token_roll(salt: str, word_i: int, tok_i: int) -> float:
    h = hashlib.sha256(f"{salt}:{word_i}:{tok_i}".encode()).digest()
    return int.from_bytes(h[:4], "big") / 0xFFFFFFFF


def apply_variables(tokens: list[str], real: Realisation, word_i: int,
                    is_final_word: bool) -> list[str]:
    """Rewrite a word's consonants according to the variable rules."""
    out = list(tokens)
    f = real.features

    for i, tok in enumerate(out):
        if tok in ("θ", "ð"):
            if _token_roll("th", word_i, i) < f["th_shift"]:
                if real.th_strategy == "stopping":
                    out[i] = "t" if tok == "θ" else "d"
                else:
                    out[i] = "f" if tok == "θ" else "v"

        elif tok == "t":
            # Glottalling applies syllable-finally and intervocalically, not
            # in a stressed onset — "better" yes, "tune" no.
            onset = i == 0
            if not onset and _token_roll("tg", word_i, i) < f["t_glottal"]:
                out[i] = "ʔ"

        elif tok == "l":
            # Coda /l/ is velarised in most varieties.
            rest = out[i + 1:]
            if not any(t in real.vowels for t in rest):
                out[i] = "ɫ"

        elif tok == "j":
            # Yod-dropping after coronals: American, and East Anglian.
            prev = out[i - 1] if i > 0 else ""
            if prev in ("t", "d", "n", "s", "z") and f["rhoticity"] > 0.7 \
                    and f["trap_bath"] < 0.7:
                out[i] = ""

    return [t for t in out if t]


def drop_final_r(token: str, real: Realisation) -> bool:
    """Whether a written postvocalic /r/ surfaces at all."""
    return token == "ɹ" and real.features["rhoticity"] < 0.35
