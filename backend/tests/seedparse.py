"""Read the phone inventory straight out of db/03_seed_phonetics.sql.

The database is the single source of truth for the phone table, but the offline
tests must not need a database. Parsing the seed keeps one source of truth
rather than maintaining a second copy in Python that would silently drift out of
step — which is exactly the failure the flatness recalibration would have hidden.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.phones import Phone

SEED = Path(__file__).resolve().parents[2] / "db" / "03_seed_phonetics.sql"
ROW = re.compile(r"^\((.*)\),?\s*$")


def _value(tok: str):
    tok = tok.strip()
    if tok.upper() == "NULL":
        return None
    if tok.lower() in ("true", "false"):
        return tok.lower() == "true"
    if tok.startswith("'"):
        return tok.strip("'")
    return float(tok)


def _split(row: str) -> list[str]:
    out, cur, quoted = [], "", False
    for ch in row:
        if ch == "'":
            quoted = not quoted
            cur += ch
        elif ch == "," and not quoted:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def phones() -> list[Phone]:
    text = SEED.read_text(encoding="utf-8")
    start = text.index("INSERT INTO phone")
    body = text[start:text.index(";", start)]

    out: list[Phone] = []
    for line in body.split("\n"):
        line = line.strip()
        m = ROW.match(line)
        if not m:
            continue
        v = [_value(t) for t in _split(m.group(1))]
        if len(v) != 12:
            continue
        out.append(Phone(ipa=v[0], arpa=v[1], manner=v[2], place=v[3], voiced=v[4],
                         f1=v[5], f2=v[6], f3=v[7], centroid=v[8], flatness=v[9],
                         typical_ms=v[10], sonority=int(v[11])))
    if not out:
        raise RuntimeError(f"parsed no phones from {SEED}")
    return out
