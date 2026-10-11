"""The Speech Accent Archive speaker table.

The archive (Weinberger, George Mason University, accent.gmu.edu) has thousands
of speakers reading the same paragraph — "Please call Stella…" — which is
exactly the elicitation design the audio field needs: what is said is held
fixed, so differences are accent rather than content. Each speaker also
records a birthplace, which is what puts them on the map.

This module owns the speaker table's one canonical form, `db/data/saa_speakers.csv`:

  * `convert()` builds it from the archive's spreadsheet export (an Apple
    Numbers file; needs `pip install numbers-parser`), normalising as it goes;
  * `load()` reads it back as typed records, with no dependencies beyond the
    standard library;
  * db/08_speech_accent_archive.sql loads the same file into PostGIS.

Normalisation is deliberately small and listed in full in db/data/README.md, so
anything in the CSV can be traced back to the source cell.
"""

from __future__ import annotations

import csv
import datetime as dt
import sys
from dataclasses import dataclass, fields
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parents[3] / "db" / "data" / "saa_speakers.csv"

# Column order of the source spreadsheet, kept verbatim so the CSV and the
# archive's own documentation use the same names.
COLUMNS = ["speakerid", "speaker", "native_language", "alternative_native_language",
           "city", "state_or_province", "country", "age", "gender", "onset_age",
           "english_residence", "length_of_residence", "learning_style", "speech_sample",
           "phonetic_transcription", "map", "ethnologue_language_code", "notes"]

INT_COLUMNS = {"speakerid", "speaker"}
NUM_COLUMNS = {"age", "onset_age", "length_of_residence"}
LEARNING_STYLE_FIXES = {"naturalisic": "naturalistic", "naturalisstic": "naturalistic"}


@dataclass(frozen=True)
class Speaker:
    speakerid: int
    speaker: int                         # index within the native language: english656
    native_language: str
    alternative_native_language: str | None
    city: str | None                     # birthplace
    state_or_province: str | None
    country: str | None
    age: float | None
    gender: str | None
    onset_age: float | None              # age English was first learned; 0 for native speakers
    english_residence: str | None        # English-speaking countries lived in, comma-separated
    length_of_residence: float | None    # years
    learning_style: str | None           # academic | naturalistic | both
    speech_sample: str                   # <language><n>.mp3 — the recording's filename
    phonetic_transcription: str | None   # .gif of the narrow transcription; notyet.gif = none yet
    map: str | None                      # .gif of the birthplace map on the archive site
    ethnologue_language_code: str | None
    notes: str | None

    @property
    def native_english(self) -> bool:
        return self.native_language == "english"

    @property
    def synthesized(self) -> bool:
        return self.native_language == "synthesized"

    @property
    def birthplace(self) -> str | None:
        """'city, state, country' with the blanks left out — a geocoder query."""
        parts = [p for p in (self.city, self.state_or_province, self.country) if p]
        return ", ".join(parts) or None


# ---------------------------------------------------------------------------
# Spreadsheet → canonical CSV
# ---------------------------------------------------------------------------


def _clean(col: str, v):
    """One source cell → its canonical CSV text ('' = NULL)."""
    if v is None:
        return ""
    if isinstance(v, (dt.datetime, dt.date)):
        # Numbers reads a note like "12 october, 2005" as a date. It is the
        # date the sample was added; keep it, in ISO form, as the note it was.
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float):
        if col in INT_COLUMNS or v == int(v):
            return str(int(v))
        return repr(round(v, 4))        # 0.6000000000000001 → 0.6
    s = str(v).replace("\r\n", "\n").replace("\r", "\n").strip()
    if s.upper() == "NULL":
        return ""
    if col == "learning_style":
        s = ", ".join(LEARNING_STYLE_FIXES.get(p.strip(), p.strip())
                      for p in s.split("\n") if p.strip())
    elif col != "notes":
        s = " ".join(s.split())         # stray CR / doubled spaces inside place names
    return s


def convert(numbers_path: str | Path, out: str | Path = CSV_PATH) -> int:
    """Write the canonical CSV from the archive's .numbers export. Returns rows."""
    from numbers_parser import Document

    table = Document(str(numbers_path)).sheets[0].tables[0]
    rows = table.rows(values_only=True)
    header = [str(h).strip() for h in rows[0]]
    if header != COLUMNS:
        raise ValueError(f"unexpected columns: {header}")

    body = [[_clean(c, v) for c, v in zip(COLUMNS, r)] for r in rows[1:]]
    body = [r for r in body if any(r)]
    body.sort(key=lambda r: int(r[0]))

    ids = [r[0] for r in body]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate speakerid in source")

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows(body)
    return len(body)


# ---------------------------------------------------------------------------
# Canonical CSV → records
# ---------------------------------------------------------------------------


def load(path: str | Path = CSV_PATH) -> list[Speaker]:
    out = []
    with Path(path).open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            kw = {}
            for fdef in fields(Speaker):
                v = row[fdef.name]
                if v == "":
                    kw[fdef.name] = None
                elif fdef.name in INT_COLUMNS:
                    kw[fdef.name] = int(v)
                elif fdef.name in NUM_COLUMNS:
                    kw[fdef.name] = float(v)
                else:
                    kw[fdef.name] = v
            out.append(Speaker(**kw))
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.datasets.saa SPEAKERS.numbers")
    n = convert(sys.argv[1])
    print(f"wrote {CSV_PATH} with {n} speakers")
