"""The geocoding cascade, on a hand-made gazetteer, plus the committed results.

Each case below is a mistake an earlier version of geocode.py actually made on
the Speech Accent Archive, so these are regression tests, not illustrations.
No network and no database: the fixture gazetteer is written to a temp dir.

    python3 backend/tests/test_geocode.py
"""

from __future__ import annotations

import csv
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.datasets import geocode, saa  # noqa: E402

FAILURES: list[str] = []

COUNTRIES = [("United States", "USA", "US", 39.8, -98.6), ("India", "IND", "IN", 22.0, 79.0),
             ("China", "CHN", "CN", 35.0, 105.0), ("Hong Kong S.A.R.", "HKG", "HK", 22.3, 114.2),
             ("Germany", "DEU", "DE", 51.0, 9.0), ("Poland", "POL", "PL", 52.0, 20.0),
             ("South Africa", "ZAF", "ZA", -29.0, 24.0)]
STATES = [("Virginia", "US", "VA", 37.5, -78.8), ("North Dakota", "US", "ND", 47.5, -100.5),
          ("New York", "US", "NY", 43.0, -75.0), ("Andhra Pradesh", "IN", "AP", 15.9, 79.7),
          ("Telangana", "IN", "TG", 17.8, 79.1), ("Guangdong", "CN", "GD", 23.1, 113.2),
          ("Yunnan", "CN", "YN", 25.0, 102.0), ("Sichuan", "CN", "SC", 30.6, 102.7),
          ("Lower Saxony", "DE", "NI", 52.8, 9.1), ("Hesse", "DE", "HE", 50.6, 9.0),
          ("Free State", "ZA", "FS", -28.5, 26.8)]
CITIES = [("Alexandria", "US", "Virginia", -77.05, 38.80, 150000),
          ("Alexandria", "US", "Louisiana", -92.45, 31.31, 47000),
          ("Dickinson", "US", "North Dakota", -102.79, 46.88, 17000),
          ("New York City", "US", "New York", -74.01, 40.71, 8800000),
          ("Hyderabad", "IN", "Telangana", 78.46, 17.38, 6800000),
          ("Gangdong", "CN", "Hunan", 112.0, 27.0, 900),
          ("Jiachuan", "CN", "Sichuan", 105.0, 32.0, 900),
          ("Hong Kong", "HK", "", 114.17, 22.28, 7400000),
          ("Frankfurt am Main", "DE", "Hesse", 8.68, 50.12, 650000),
          ("Niedersachswerfen", "DE", "Thuringia", 10.77, 51.56, 900),
          ("Wrocław", "PL", "Lower Silesia", 17.03, 51.10, 640000),
          ("Mumbai", "IN", "Maharashtra", 72.88, 19.07, 12000000),
          ("Virginia", "ZA", "Free State", 26.87, -28.10, 66000),
          ("Wilmington", "US", "North Carolina", -77.95, 34.24, 120000)]


def fixture(root: Path) -> geocode.Gazetteer:
    with (root / "countries.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "iso3", "iso2", "native", "latitude", "longitude"])
        for name, iso3, iso2, lat, lon in COUNTRIES:
            w.writerow([name, iso3, iso2, "", lat, lon])
    with (root / "states.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "country_code", "iso2", "native", "latitude", "longitude"])
        for name, cc, code, lat, lon in STATES:
            w.writerow([name, cc, code, "", lat, lon])
    (root / "cities500.json").write_text(json.dumps([
        {"name": n, "country": cc, "admin1": a, "lon": str(x), "lat": str(y), "pop": str(p)}
        for n, cc, a, x, y, p in CITIES]), encoding="utf-8")
    return geocode.Gazetteer(root)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def expect(gaz, place: tuple[str, str, str], match: str, name: str, why: str) -> None:
    fx = gaz.geocode(*place)
    check(f"{', '.join(p for p in place if p)} → {match} {name}  ({why})",
          fx.match == match and fx.matched_name == name, f"got {fx.match} {fx.matched_name}")


def cascade() -> None:
    print("cascade")
    with tempfile.TemporaryDirectory() as d:
        g = fixture(Path(d))
        expect(g, ("alexandria", "va", "usa"), "city+state", "Alexandria",
               "a state alias still filters by the state's real name")
        expect(g, ("dickenson county", "virginia", "usa"), "state", "Virginia",
               "never leave a recognised state for a near-miss elsewhere")
        expect(g, ("jianchuan", "yunnan", "china"), "state", "Yunnan",
               "fuzzy matching stays inside the named province")
        expect(g, ("guangdong province", "", "china"), "state", "Guangdong",
               "a region beats a village with a similar name")
        expect(g, ("niedersachsen", "", "germany"), "state", "Lower Saxony",
               "regions by their local name")
        expect(g, ("new york", "new york", "usa"), "city~", "New York City",
               "the head of a longer official name beats the region")
        expect(g, ("frankfurt", "", "germany"), "city~", "Frankfurt am Main", "head match")
        expect(g, ("hyderabad", "andhra pradesh", "india"), "city+state", "Hyderabad",
               "boundaries move; a same-named city next to the state counts")
        expect(g, ("hong kong", "", "china"), "city", "Hong Kong",
               "territories GeoNames files under their own code")
        expect(g, ("wroclaw", "", "poland"), "city", "Wrocław", "ł has no Unicode decomposition")
        expect(g, ("bombay", "", "india"), "city", "Mumbai", "exonyms")
        expect(g, ("virginia", "", "south africa"), "city", "Virginia",
               "a city that shares a US state's name, in its own country")
        expect(g, ("wilmington nc", "", "usa"), "city", "Wilmington", "postal suffix")
        expect(g, ("somewhere", "", "india"), "country", "India", "country centroid last")
        fx = g.geocode("x", "", "atlantis")
        check("an unknown country is left unresolved", fx.match == "" and fx.lon is None)


def committed() -> None:
    print("committed geocodes")
    with geocode.OUT.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    places = {(s.city or "", s.state_or_province or "", s.country or "")
              for s in saa.load() if s.birthplace}
    have = {(r["city"], r["state_or_province"], r["country"]) for r in rows}
    check("one row per distinct birthplace", have == places and len(rows) == len(places),
          f"{len(rows)} rows, {len(places)} places")
    ok = {"city+state", "city", "city~", "state", "country"}
    check("every birthplace resolved", all(r["match"] in ok for r in rows),
          str({r["match"] for r in rows} - ok))
    check("coordinates in range", all(-180 <= float(r["lon"]) <= 180 and -90 <= float(r["lat"]) <= 90
                                      for r in rows))
    by = {(r["city"], r["state_or_province"], r["country"]): r["match"] for r in rows}
    eng = [s for s in saa.load() if s.native_english]
    city = sum(by[(s.city or "", s.state_or_province or "", s.country or "")].startswith("city")
               for s in eng)
    check("≥ 90% of native English speakers placed at a city", city / len(eng) >= 0.90,
          f"{city}/{len(eng)}")


if __name__ == "__main__":
    cascade()
    committed()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed")
        sys.exit(1)
    print("all checks passed")
