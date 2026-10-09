"""Named entities in a speaker record's free text.

Three sources, merged, every mention keeping its character offsets so the UI
can highlight it in place:

  spacy      spaCy's multilingual xx_ent_wiki_sm — the model Demogi's pipeline
             runs — for LOC / PER / ORG / MISC. The archive's text is all lower
             case, which costs it recall on names; it still finds most places.
  pattern    what a statistical NER model has no label for but the notes are
             full of: DATE ("10 july 2015"), DURATION ("2 years"), AGE_RANGE
             ("dallas,0-18"), COURSE (the collecting class, "LING523").
  list       english_residence is a comma-separated list of places by
             construction ("australia, uk, usa"), so it is split rather than
             guessed at.

Every LOC is then linked to the gazetteer (datasets/geocode.py), preferring
the speaker's own countries, so a place mentioned in the notes becomes a point
on the map next to the speaker's birthplace.

spaCy is optional at import: without it the pattern and list sources still
run, and `MODEL` says so in the stored records.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from .datasets.geocode import Gazetteer

SPACY_MODEL = "xx_ent_wiki_sm"
_nlp = None
_nlp_failed = False

MONTH = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
         r"aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
PATTERNS: list[tuple[str, re.Pattern]] = [
    ("DATE", re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{MONTH}\.?,?\s+\d{{4}}\b", re.I)),
    ("DATE", re.compile(rf"\b{MONTH}\.?\s+\d{{1,2}},?\s+\d{{4}}\b", re.I)),
    ("DATE", re.compile(r"\b\d{4}-\d{2}-\d{2}\b")),
    ("DATE", re.compile(rf"\b{MONTH}\s+\d{{4}}\b", re.I)),
    ("DURATION", re.compile(r"\b\d+(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?|weeks?|days?)\b", re.I)),
    ("AGE_RANGE", re.compile(r"(?<![\d-])\d{1,2}\s*-\s*\d{1,2}(?![\d-])")),
    ("COURSE", re.compile(r"\bling\s?\d{3}[a-z]{0,3}\b", re.I)),
]
# "residence: dallas,0-18; austin,18-40" — a place, then the ages lived there.
RESIDENCE = re.compile(r"([a-z][a-z .'-]{1,40}?)\s*,\s*\d{1,2}\s*-\s*\d{1,2}", re.I)
# "born in X", "moved to X": a cue, then up to three words before punctuation.
CUE = re.compile(r"\b(?:born in|raised in|grew up in|lived in|living in|moved to|from|in)\s+"
                 r"([a-z][\w'.-]*(?:\s+[a-z][\w'.-]*){0,2})", re.I)


@dataclass
class Entity:
    field: str
    start: int
    end: int
    text: str
    label: str
    source: str
    place: str | None = None
    match: str | None = None
    lon: float | None = None
    lat: float | None = None

    def public(self) -> dict:
        return asdict(self)


def nlp():
    """The spaCy pipeline, loaded once; None if spaCy or the model is missing."""
    global _nlp, _nlp_failed
    if _nlp is None and not _nlp_failed:
        try:
            import spacy
            _nlp = spacy.load(SPACY_MODEL)
        except Exception:                      # not installed: patterns still run
            _nlp_failed = True
    return _nlp


def model_name() -> str:
    return f"spacy:{SPACY_MODEL}+patterns" if nlp() is not None else "patterns"


def _overlaps(a: Entity, b: Entity) -> bool:
    return a.start < b.end and b.start < a.end


def _keep(found: list[Entity], e: Entity) -> None:
    """Add e unless it overlaps something more trustworthy already kept.
    Precedence: pattern > list > spacy > gazetteer cue."""
    rank = {"pattern": 0, "list": 1, "spacy": 2, "gazetteer": 3}
    clash = [f for f in found if _overlaps(f, e)]
    if any(rank[f.source.split(":")[0]] <= rank[e.source.split(":")[0]] for f in clash):
        return
    for f in clash:
        found.remove(f)
    found.append(e)


def _link(e: Entity, gaz: Gazetteer | None, hint: list[str], strict: bool) -> Entity:
    if gaz is None or e.label != "LOC":
        return e
    fx = gaz.link(e.text, hint, min_pop=100_000, spacy_loc=not strict)
    if fx.lon is not None:
        e.place, e.match, e.lon, e.lat = fx.matched_name, fx.match, fx.lon, fx.lat
    return e


def extract(field: str, text: str | None, gaz: Gazetteer | None = None,
            hint: list[str] = ()) -> list[Entity]:
    if not text:
        return []
    found: list[Entity] = []

    for label, pat in PATTERNS:
        for m in pat.finditer(text):
            _keep(found, Entity(field, m.start(), m.end(), m.group(0), label, "pattern"))

    if field == "english_residence":
        for m in re.finditer(r"[^,;/]+", text):
            raw = m.group(0)
            s = m.start() + len(raw) - len(raw.lstrip())
            item = raw.strip()
            if item and not re.fullmatch(r"[\d.]+", item):
                _keep(found, _link(Entity(field, s, s + len(item), item, "LOC", "list"),
                                   gaz, hint, strict=False))
        return sorted(found, key=lambda e: e.start)

    model = nlp()
    if model is not None:
        for ent in model(text).ents:
            label = ent.label_ if ent.label_ in ("LOC", "PER", "ORG", "MISC") else "MISC"
            e = Entity(field, ent.start_char, ent.end_char, ent.text, label,
                       f"spacy:{SPACY_MODEL}")
            _keep(found, _link(e, gaz, hint, strict=False))

    # Places spaCy missed in lower-case text, found by position rather than
    # capitalisation, kept only if the gazetteer agrees they are places.
    if gaz is not None:
        cands = [(m.start(1), m.group(1)) for m in RESIDENCE.finditer(text)]
        cands += [(m.start(1), m.group(1)) for m in CUE.finditer(text)]
        for start, phrase in cands:
            words = phrase.strip().rstrip(".").split()
            for k in range(len(words), 0, -1):              # longest place wins
                cand = " ".join(words[:k])
                fx = gaz.link(cand, hint, min_pop=50_000)
                if fx.lon is not None:
                    s = text.find(cand, start)
                    _keep(found, Entity(field, s, s + len(cand), cand, "LOC", "gazetteer",
                                        fx.matched_name, fx.match, fx.lon, fx.lat))
                    break
    return sorted(found, key=lambda e: e.start)


NER_FIELDS = ("notes", "english_residence")


def run(record: dict, gaz: Gazetteer | None = None) -> list[Entity]:
    """Entities for every free-text field of a speaker record.

    `hint` steers place linking to the countries the record already names —
    birthplace country first, then countries of residence — so 'austin' in a
    Texan's notes is Austin, Texas, not a village elsewhere."""
    hint: list[str] = []
    if gaz is not None:
        for c in [record.get("country")] + re.split(r"[,;/]", record.get("english_residence") or ""):
            iso, _ = gaz.country(c or "")
            if iso and iso not in hint:
                hint.append(iso)
        if "US" not in hint:
            hint.append("US")
    out: list[Entity] = []
    for f in NER_FIELDS:
        out += extract(f, record.get(f), gaz, hint)
    return out
