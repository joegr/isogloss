"""Checks on the stored Speech Accent Archive speaker table. No database.

The CSV is data, not code, so what can go wrong is a bad re-export or a hand
edit. These pin the properties everything downstream relies on: one row per
speaker, the sample filename as a join key to the audio, the normalisation
actually applied, and the SQL table agreeing with the CSV's columns.

    python3 backend/tests/test_saa.py
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.datasets import saa  # noqa: E402

FAILURES: list[str] = []
SQL = Path(__file__).resolve().parents[2] / "db" / "08_speech_accent_archive.sql"


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def main() -> None:
    speakers = saa.load()
    print("speakers")
    check("3,031 speakers", len(speakers) == 3031, str(len(speakers)))
    ids = [s.speakerid for s in speakers]
    check("speakerid unique and sorted", len(set(ids)) == len(ids) and ids == sorted(ids))
    samples = [s.speech_sample for s in speakers]
    check("speech_sample unique", len(set(samples)) == len(samples))
    check("speech_sample ends in the per-language index",
          all(re.fullmatch(r".+?%d\.mp3" % s.speaker, s.speech_sample) for s in speakers))
    english = [s for s in speakers if s.native_english]
    check("658 native English speakers", len(english) == 658, str(len(english)))
    check("every native English speaker has a birthplace",
          all(s.birthplace for s in english))
    no_place = [s for s in speakers if s.birthplace is None]
    check("only the synthesized samples lack a birthplace",
          all(s.synthesized for s in no_place) and len(no_place) == 4)

    print("normalisation")
    with saa.CSV_PATH.open(newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    check("header is the archive's column order", rows[0] == saa.COLUMNS)
    cells = [c for r in rows[1:] for c in r]
    check("no literal NULL left", not any(c.upper() == "NULL" for c in cells))
    check("no carriage returns left", not any("\r" in c for c in cells))
    styles = {s.learning_style for s in speakers}
    check("learning_style typos folded",
          styles <= {None, "academic", "naturalistic", "academic, naturalistic"}, str(styles))
    check("no float noise", not any(re.search(r"\.\d{5,}", c) for r in rows[1:] for c in r[7:12]))

    print("schema")
    body = SQL.read_text(encoding="utf-8")
    table = body[body.index("CREATE TABLE IF NOT EXISTS saa_speaker"):]
    table = table[:table.index(");")]
    cols = re.findall(r"^\s+([a-z_]+)\s+(?:int|text|real)", table, flags=re.M)
    check("saa_speaker columns match the CSV", cols == saa.COLUMNS, str(cols))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
