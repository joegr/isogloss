"""Speaker records: the server half of the map's speaker-dot module.

Dropping a dot on the globe and saving it runs one cascade, in one transaction:

  1. record    a saa_speaker row with every archive field, origin 'ui', an id
               from 100001 up, its per-language index and sample name;
  2. place     the dot's point stored as the speaker's `pin`; the typed
               birthplace geocoded too (datasets/geocode.py) if the archive has
               not seen it, so it joins every other speaker born there;
  3. entities  NER over the free-text fields (ner.py) — spaCy, patterns, the
               residence list — with every place linked to the gazetteer.

Audio follows as its own request, because the browser decodes it first (any
format → 16 kHz mono WAV, see frontend/src/speakers/audio.ts), and cascades
again: an audio node at the speaker's point, the recording, its features.

FIELDS is the single definition of a speaker record. The frontend renders its
form from GET /api/speakers/schema, so "all fields" means the same list on
both sides.
"""

from __future__ import annotations

import json
import re
import threading

from . import catalog, db, ner
from .datasets.geocode import Gazetteer, gazetteer
from .field.featurize import featurize
from .field.store import PgNodeStore

# name, label, kind, help. Kinds: text | number | select | textarea | auto.
FIELDS: list[dict] = [
    {"name": "native_language", "label": "Native language", "kind": "text", "required": True,
     "help": "As the archive writes it: lower case, e.g. english, mandarin, spanish."},
    {"name": "alternative_native_language", "label": "Other native language", "kind": "text"},
    {"name": "city", "label": "Birthplace — city", "kind": "text"},
    {"name": "state_or_province", "label": "Birthplace — state / province", "kind": "text"},
    {"name": "country", "label": "Birthplace — country", "kind": "text",
     "help": "Archive spelling: usa, uk, south korea…"},
    {"name": "age", "label": "Age", "kind": "number", "min": 0, "max": 120},
    {"name": "gender", "label": "Gender", "kind": "select", "options": ["female", "male"]},
    {"name": "onset_age", "label": "Age English began", "kind": "number", "min": 0, "max": 120,
     "help": "0 for a native speaker."},
    {"name": "english_residence", "label": "English-speaking countries lived in", "kind": "text",
     "help": "Comma-separated: usa, uk, australia."},
    {"name": "length_of_residence", "label": "Years there", "kind": "number", "min": 0, "max": 120},
    {"name": "learning_style", "label": "Learning style", "kind": "select",
     "options": ["academic", "naturalistic", "academic, naturalistic"]},
    {"name": "ethnologue_language_code", "label": "ISO 639-3 code", "kind": "text",
     "help": "Filled from other speakers of the language if left blank."},
    {"name": "notes", "label": "Notes", "kind": "textarea",
     "help": "Free text — residence history, recording date. NER runs over it."},
    {"name": "speech_sample", "label": "Sample file", "kind": "auto",
     "help": "Set from the attached audio's filename, or <language><n>."},
]
EDITABLE = [f["name"] for f in FIELDS if f["kind"] != "auto"]
NUMERIC = {f["name"] for f in FIELDS if f["kind"] == "number"}
COLUMNS = ["speakerid", "speaker", "native_language", "alternative_native_language", "city",
           "state_or_province", "country", "age", "gender", "onset_age", "english_residence",
           "length_of_residence", "learning_style", "speech_sample", "phonetic_transcription",
           "map", "ethnologue_language_code", "notes"]


class NotFound(LookupError):
    pass


class Invalid(ValueError):
    pass


# ---------------------------------------------------------------------------
# The gazetteer, warmed in the background: it takes ~10 s to load and the
# first map click should not pay for it.
# ---------------------------------------------------------------------------

_warm = threading.Event()


def warm() -> None:
    def go():
        try:
            gazetteer()
            ner.nlp()
        finally:
            _warm.set()
    threading.Thread(target=go, daemon=True, name="gazetteer-warm").start()


def gaz() -> Gazetteer:
    return gazetteer()


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def schema() -> dict:
    langs = db.query("""
        SELECT native_language AS value, count(*) AS n,
               mode() WITHIN GROUP (ORDER BY ethnologue_language_code) AS code
        FROM saa_speaker GROUP BY 1 ORDER BY 2 DESC, 1""")
    countries = db.query("""
        SELECT country AS value, count(*) AS n FROM saa_speaker
        WHERE country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1""")
    return {"fields": FIELDS, "languages": langs, "countries": countries,
            "ner_model": ner.model_name()}


def geojson(native_english: bool | None = None, language: str | None = None,
            origin: str | None = None, with_audio: bool | None = None) -> dict:
    return db.geojson("""
        SELECT ST_AsGeoJSON(geog::geometry, 5) AS geometry, speakerid AS id,
               native_language, gender, age, birthplace, geocode_match AS match,
               recordings, origin, speech_sample, native_english
        FROM saa_speaker_geo
        WHERE geog IS NOT NULL
          AND (%(ne)s::boolean IS NULL OR native_english = %(ne)s)
          AND (%(lang)s::text IS NULL OR native_language = %(lang)s)
          AND (%(origin)s::text IS NULL OR origin = %(origin)s)
          AND (%(audio)s::boolean IS NULL OR (recordings > 0) = %(audio)s)
        ORDER BY speakerid
    """, {"ne": native_english, "lang": language, "origin": origin, "audio": with_audio})


def get(speakerid: int) -> dict:
    row = db.one(f"""
        SELECT {", ".join("g." + c for c in COLUMNS)}, g.origin, g.native_english, g.birthplace,
               ST_X(g.geog::geometry) AS lon, ST_Y(g.geog::geometry) AS lat,
               g.geocode_match, g.geocode_source, g.matched_name, g.matched_admin1,
               g.country_code, g.recordings, g.ner_model, g.ner_at::text AS ner_at,
               g.created::text AS created
        FROM saa_speaker_geo g WHERE g.speakerid = %s
    """, (speakerid,))
    if not row:
        raise NotFound(f"no speaker {speakerid}")
    ents = db.query("""
        SELECT field, start_char AS start, end_char AS "end", text, label, source, place, match,
               ST_X(geog::geometry) AS lon, ST_Y(geog::geometry) AS lat
        FROM saa_entity WHERE speakerid = %s ORDER BY field, start_char
    """, (speakerid,))
    recs = db.query("""
        SELECT r.id, r.duration_s, r.source_file, r.phone_string, r.created::text AS created,
               r.feature_version, n.id AS node_id
        FROM audio_recording r JOIN audio_node n ON n.id = r.node_id
        WHERE n.speakerid = %s ORDER BY r.created
    """, (speakerid,))
    return {"record": {c: row[c] for c in COLUMNS},
            "origin": row["origin"], "native_english": row["native_english"],
            "geo": {"lon": row["lon"], "lat": row["lat"], "birthplace": row["birthplace"],
                    "match": row["geocode_match"], "source": row["geocode_source"],
                    "matched_name": row["matched_name"], "admin1": row["matched_admin1"],
                    "country_code": row["country_code"]},
            "entities": ents, "recordings": recs,
            "ner": {"model": row["ner_model"], "at": row["ner_at"]},
            "created": row["created"]}


# ---------------------------------------------------------------------------
# Writing — the cascade
# ---------------------------------------------------------------------------


def _clean(payload: dict) -> dict:
    out = {}
    for name in EDITABLE:
        if name not in payload:
            continue
        v = payload[name]
        if isinstance(v, str):
            v = " ".join(v.split()) if name != "notes" else v.strip()
            v = v.lower() if name not in ("notes", "ethnologue_language_code") else v
            v = v or None
        if name in NUMERIC and v is not None:
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise Invalid(f"{name} must be a number")
            spec = next(f for f in FIELDS if f["name"] == name)
            if not spec.get("min", -1e9) <= v <= spec.get("max", 1e9):
                raise Invalid(f"{name} must be between {spec['min']} and {spec['max']}")
        out[name] = v
    for f in FIELDS:
        if f.get("options") and out.get(f["name"]) not in (None, *f["options"]):
            raise Invalid(f"{f['name']} must be one of {f['options']}")
    return out


def _point(payload: dict) -> tuple[float, float] | None:
    if payload.get("lon") is None or payload.get("lat") is None:
        return None
    lon, lat = float(payload["lon"]), float(payload["lat"])
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise Invalid(f"({lon}, {lat}) is not a lon/lat position")
    return lon, lat


def _ensure_birthplace(c, rec: dict) -> dict | None:
    """Geocode a birthplace the archive has not seen, so it joins the others."""
    key = (rec.get("city") or "", rec.get("state_or_province") or "", rec.get("country") or "")
    if not any(key):
        return None
    hit = c.execute("""SELECT match FROM saa_birthplace
                       WHERE city = %s AND state_or_province = %s AND country = %s""",
                    key).fetchone()
    if hit:
        return {"query": ", ".join(p for p in key if p), "match": hit["match"], "new": False}
    fx = gaz().geocode(*key)
    c.execute("""
        INSERT INTO saa_birthplace (city, state_or_province, country, query, geog, source,
                                    match, matched_name, matched_admin1, country_code)
        VALUES (%s, %s, %s, %s,
                CASE WHEN %s::float8 IS NOT NULL THEN ST_MakePoint(%s, %s)::geography END,
                %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
    """, (*key, ", ".join(p for p in key if p), fx.lon, fx.lon, fx.lat,
          "geonames-cities500+dr5hn" if fx.match else None, fx.match or None,
          fx.matched_name or None, fx.matched_admin1 or None, fx.country_code or None))
    return {"query": ", ".join(p for p in key if p), "match": fx.match or None, "new": True}


def _run_ner(c, speakerid: int, rec: dict) -> list[ner.Entity]:
    ents = ner.run(rec, gaz())
    c.execute("DELETE FROM saa_entity WHERE speakerid = %s", (speakerid,))
    for e in ents:
        c.execute("""
            INSERT INTO saa_entity (speakerid, field, start_char, end_char, text, label,
                                    source, place, match, geog)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                    CASE WHEN %s::float8 IS NOT NULL THEN ST_MakePoint(%s, %s)::geography END)
        """, (speakerid, e.field, e.start, e.end, e.text, e.label, e.source, e.place, e.match,
              e.lon, e.lon, e.lat))
    c.execute("UPDATE saa_speaker SET ner_model = %s, ner_at = now() WHERE speakerid = %s",
              (ner.model_name(), speakerid))
    return ents


def _slug(lang: str) -> str:
    return re.sub(r"[^a-z0-9]", "", lang.lower()) or "speaker"


def create(payload: dict) -> dict:
    rec = _clean(payload)
    if not rec.get("native_language"):
        raise Invalid("native_language is required")
    pin = _point(payload)
    if pin is None and not (rec.get("city") or rec.get("country")):
        raise Invalid("place the speaker on the map, or give a birthplace")

    steps = []
    with db.conn() as c:
        sid = c.execute("SELECT nextval('saa_speaker_ui_id') AS id").fetchone()["id"]
        lang = rec["native_language"]
        idx = c.execute("SELECT COALESCE(max(speaker), 0) + 1 AS n FROM saa_speaker "
                        "WHERE native_language = %s", (lang,)).fetchone()["n"]
        sample = _unique_sample(c, payload.get("speech_sample") or f"{_slug(lang)}{idx}.wav")
        if not rec.get("ethnologue_language_code"):
            r = c.execute("""SELECT mode() WITHIN GROUP (ORDER BY ethnologue_language_code) AS code
                             FROM saa_speaker WHERE native_language = %s""", (lang,)).fetchone()
            rec["ethnologue_language_code"] = r["code"] if r else None

        cols = ["speakerid", "speaker", "speech_sample", "origin"] + list(rec)
        vals = [sid, idx, sample, "ui"] + list(rec.values())
        lon, lat = pin if pin else (None, None)
        c.execute(f"""
            INSERT INTO saa_speaker ({", ".join(cols)}, pin)
            VALUES ({", ".join(["%s"] * len(vals))},
                    CASE WHEN %s::float8 IS NOT NULL THEN ST_MakePoint(%s, %s)::geography END)
        """, (*vals, lon, lon, lat))
        steps.append({"step": "record", "speakerid": sid, "speech_sample": sample})
        steps.append({"step": "place", "pin": pin, "birthplace": _ensure_birthplace(c, rec)})
        ents = _run_ner(c, sid, rec)
        steps.append({"step": "entities", "model": ner.model_name(), "count": len(ents),
                      "places": sum(e.lon is not None for e in ents)})
    out = get(sid)
    out["cascade"] = steps
    return out


def update(speakerid: int, payload: dict) -> dict:
    """UI speakers: any field. Archive speakers: only the pin — their fields
    are owned by the archive export and would be overwritten by the next load."""
    cur = get(speakerid)
    pin = _point(payload)
    rec = _clean(payload)
    if cur["origin"] != "ui" and rec:
        raise Invalid("archive speakers' fields come from the archive export; only the "
                      "pin can be moved")
    with db.conn() as c:
        if rec:
            sets = ", ".join(f"{k} = %s" for k in rec)
            c.execute(f"UPDATE saa_speaker SET {sets} WHERE speakerid = %s",
                      (*rec.values(), speakerid))
        if pin is not None:
            c.execute("UPDATE saa_speaker SET pin = ST_MakePoint(%s, %s)::geography "
                      "WHERE speakerid = %s", (pin[0], pin[1], speakerid))
            c.execute("""UPDATE audio_node SET geog = ST_MakePoint(%s, %s)::geography
                         WHERE speakerid = %s""", (pin[0], pin[1], speakerid))
        merged = {**cur["record"], **rec}
        _ensure_birthplace(c, merged)
        if rec:
            _run_ner(c, speakerid, merged)
    return get(speakerid)


def delete(speakerid: int) -> None:
    cur = get(speakerid)
    if cur["origin"] != "ui":
        raise Invalid("archive speakers cannot be deleted here")
    with db.conn() as c:
        c.execute("DELETE FROM audio_node WHERE speakerid = %s", (speakerid,))  # recordings cascade
        c.execute("DELETE FROM saa_speaker WHERE speakerid = %s", (speakerid,))


def _unique_sample(c, name: str) -> str:
    base, dot, ext = name.rpartition(".")
    base, ext = (base, "." + ext) if dot else (name, "")
    cand, n = name, 1
    while c.execute("SELECT 1 FROM saa_speaker WHERE speech_sample = %s", (cand,)).fetchone():
        n += 1
        cand = f"{base}-{n}{ext}"
    return cand


def attach_audio(speakerid: int, wav: bytes, filename: str | None = None) -> dict:
    """The audio half of the cascade: node at the speaker's point → recording →
    features. Idempotent on content: the same file twice returns the first."""
    cur = get(speakerid)
    if cur["geo"]["lon"] is None:
        raise Invalid("this speaker has no point on the map yet; place them first")
    store = PgNodeStore()
    node = db.one("SELECT id FROM audio_node WHERE speakerid = %s", (speakerid,))
    if node is None:
        nid = f"spk-{speakerid}"
        db.execute("""
            INSERT INTO audio_node (id, label, language, settlement_id, speakerid, geog)
            VALUES (%s, %s, %s,
                    (SELECT s.id FROM settlement s
                      WHERE ST_DWithin(s.geog, ST_MakePoint(%s, %s)::geography, 30000)
                      ORDER BY s.geog <-> ST_MakePoint(%s, %s)::geography LIMIT 1),
                    %s, ST_MakePoint(%s, %s)::geography)
            ON CONFLICT (id) DO NOTHING
        """, (nid, cur["geo"]["birthplace"] or f"speaker {speakerid}",
              "en" if cur["native_english"] else None,
              *(cur["geo"]["lon"], cur["geo"]["lat"]) * 2, speakerid,
              cur["geo"]["lon"], cur["geo"]["lat"]))
        node_id = nid
    else:
        node_id = node["id"]

    dup = store.find_recording(node_id, wav)
    if dup:
        return {"recording": next(r for r in cur["recordings"] if r["id"] == dup),
                "duplicate": True, "node_id": node_id}
    feat = featurize(wav, catalog.phones())
    rec = store.add_recording(node_id, wav, feat, speaker=str(speakerid), source_file=filename)
    expected = cur["record"]["speech_sample"]
    warn = []
    if filename and expected and filename.rsplit(".", 1)[0] != expected.rsplit(".", 1)[0]:
        warn.append(f"file is {filename!r} but this speaker's archive sample is {expected!r}")
    return {"recording": rec.public(), "duplicate": False, "node_id": node_id,
            "phone_string": feat.phone_string, "notes": feat.notes + warn}


def delete_recording(rec_id: str) -> dict:
    """Remove one recording; a speaker's node goes with its last recording."""
    row = db.one("""SELECT r.node_id, n.speakerid FROM audio_recording r
                    JOIN audio_node n ON n.id = r.node_id WHERE r.id = %s""", (rec_id,))
    if row is None:
        raise NotFound(f"no recording {rec_id}")
    with db.conn() as c:
        c.execute("DELETE FROM audio_recording WHERE id = %s", (rec_id,))
        if row["speakerid"] is not None:
            c.execute("""DELETE FROM audio_node n WHERE n.id = %s AND NOT EXISTS
                         (SELECT 1 FROM audio_recording r WHERE r.node_id = n.id)""", (row["node_id"],))
    return {"deleted": rec_id, "speakerid": row["speakerid"]}


def match_samples(filenames: list[str]) -> dict:
    """Archive filenames → speaker ids, for attaching a whole folder at once."""
    stems = {f.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower(): f for f in filenames}
    rows = db.query("""SELECT speakerid, speech_sample FROM saa_speaker
                       WHERE lower(split_part(speech_sample, '.', 1)) = ANY(%s)""",
                    (list(stems),))
    found = {r["speech_sample"].rsplit(".", 1)[0].lower(): r["speakerid"] for r in rows}
    return {"matched": {stems[k]: v for k, v in found.items()},
            "unmatched": [f for k, f in stems.items() if k not in found]}


def ner_all(only_missing: bool = True) -> dict:
    """Run NER over every speaker (the archive's 3,031 take a few seconds)."""
    rows = db.query(f"""SELECT {", ".join(COLUMNS)} FROM saa_speaker
                        {"WHERE ner_at IS NULL" if only_missing else ""} ORDER BY speakerid""")
    n = 0
    with db.conn() as c:
        for r in rows:
            n += len(_run_ner(c, r["speakerid"], r))
    return {"speakers": len(rows), "entities": n, "model": ner.model_name()}


# ---------------------------------------------------------------------------
# Geography helpers for the form
# ---------------------------------------------------------------------------


def reverse(lon: float, lat: float) -> dict | None:
    """Nearest populated place to a map click, spelt the archive's way, so the
    form's birthplace fields can be prefilled and still join existing rows."""
    hit = gaz().reverse(lon, lat)
    if hit is None:
        return None
    spelling = db.one("""
        SELECT country FROM saa_birthplace WHERE country_code = %s AND country <> ''
        GROUP BY country ORDER BY count(*) DESC LIMIT 1""", (hit["country_code"],))
    hit["suggest"] = {
        "city": hit["name"].lower(),
        "state_or_province": (hit["admin1"] or "").lower() or None,
        "country": spelling["country"] if spelling else hit["country"].lower(),
    }
    return hit


def search(q: str) -> dict | None:
    return gaz().search(q)


def to_json(obj) -> str:
    return json.dumps(obj, default=str)
