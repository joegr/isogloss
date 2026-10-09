"""Geocoding birthplaces against an open gazetteer, with the match recorded.

A birthplace is three lower-case strings typed by volunteers ("st. louis",
"missouri", "usa"; "prishtina", "", "kosovo"; "guangdong province", "",
"china"). Turning them into a point is a cascade, most specific first, and the
`match` column says which rung answered — because a city fix and a country
centroid are not the same evidence, and the audio field should be able to
weight them differently (or drop the coarse ones):

  city+state   the city, inside the named state/province
  city         the city, by exact name within the country (largest if several)
  city~        the city, by close spelling within the country ("prishtina" → Pristina)
  state        the state/province centroid (city missing, or itself a region)
  country      the country centroid
  (empty)      nothing usable — left without coordinates

Gazetteer (fetched once into a cache, not committed):
  * GeoNames cities500 via github.com/lmfmaier/cities-json — every populated
    place over 500 people, with first-level admin names and population.
    GeoNames, CC BY 4.0.
  * countries.csv and states.csv from github.com/dr5hn/countries-states-cities-database
    — country names, ISO codes and centroids; state names and centroids. ODbL 1.0.

The results are committed (db/data/saa_birthplaces.csv), so building the
database never needs the gazetteer. Re-run after a new speaker export:

    python -m app.datasets.geocode            # writes db/data/saa_birthplaces.csv
"""

from __future__ import annotations

import csv
import difflib
import json
import os
import re
import sys
import unicodedata
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from ..geomath import haversine_km
from . import saa

OUT = Path(__file__).resolve().parents[3] / "db" / "data" / "saa_birthplaces.csv"
CACHE = Path(os.environ.get("ISOGLOSS_GAZETTEER", Path.home() / ".cache" / "isogloss" / "gazetteer"))
SOURCES = {
    "cities500.json": "https://raw.githubusercontent.com/lmfmaier/cities-json/master/cities500.json",
    "countries.csv": "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/csv/countries.csv",
    "states.csv": "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/csv/states.csv",
}
SOURCE_TAG = "geonames-cities500+dr5hn"
NEAR_STATE_KM = 250.0
FUZZY = 0.86                      # difflib ratio for city~; checked by eye on the SAA set

# Country spellings in the archive that no gazetteer name matches, mapped by
# hand. Misspellings stay misspelt in saa_speakers.csv; they are only read here.
COUNTRY_ALIASES = {
    "usa": "US", "us virgin islands": "VI", "uk": "GB", "south korea": "KR",
    "north korea": "KP", "russia": "RU", "ivory coast": "CI", "laos": "LA", "syria": "SY",
    "iran": "IR", "vietnam": "VN", "vietnamese": "VN", "taiwan": "TW", "tanzania": "TZ",
    "moldova": "MD", "bolivia": "BO", "venezuela": "VE", "czech republic": "CZ",
    "slovak republic": "SK", "macedonia": "MK", "kosovo": "XK", "palestine": "PS",
    "the bahamas": "BS", "bosnia": "BA", "republic of georgia": "GE",
    "democratic republic of congo": "CD", "democratic republic of the congo": "CD",
    "israel (occupied territory)": "IL", "el salvadore": "SV", "kyrgystan": "KG",
    "indonesian": "ID", "indonesisa": "ID", "romanian": "RO", "philippiness": "PH",
    "trinidad": "TT", "federated states of micronesia": "FM", "timor-leste": "TL",
    "curacao": "CW", "faroe islands": "FO", "isle of man": "IM", "brunei": "BN",
    "cape verde": "CV", "swaziland": "SZ", "burma": "MM", "holland": "NL",
    "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
}
# Regions typed into the country column: (country, state to search within).
COUNTRY_AS_REGION = {"sicily": ("IT", "sicily"), "tibet": ("CN", "tibet")}
STATE_ALIASES = {"dc": "district of columbia", "washington dc": "district of columbia",
                 "hawai'i": "hawaii", "tibet": "xizang", "inner mongolia": "inner mongolia",
                 "bavaria": "bayern", "catalonia": "catalunya", "flanders": "flemish region",
                 "orissa": "odisha", "niedersachsen": "lower saxony",
                 # Vietnam's 2025 provincial merger: the archive predates it,
                 # the gazetteers follow it.
                 "binh dinh": "gia lai", "quang nam": "da nang"}
# Exonyms and former names the archive uses where GeoNames' primary name has
# moved on. cities500 carries no alternate names, so these are listed.
CITY_ALIASES = {"bombay": "mumbai", "bangalore": "bengaluru", "calcutta": "kolkata",
                "madras": "chennai", "allahabad": "prayagraj", "poona": "pune",
                "jiddah": "jeddah", "esfahan": "isfahan", "peking": "beijing",
                "canton": "guangzhou", "saigon": "ho chi minh city", "rangoon": "yangon",
                "arbil": "erbil", "hawler": "erbil", "huhot": "hohhot", "clug": "cluj napoca",
                "kiev": "kyiv", "frunze": "bishkek", "leningrad": "saint petersburg",
                "ad dammam": "dammam", "al ayn": "al ain", "cheju do": "jeju city",
                "cheju": "jeju city", "an yang": "anyang", "pusan": "busan", "taegu": "daegu",
                "taejon": "daejeon", "kimpo": "gimpo si", "sunchun": "suncheon",
                "ui jong bu": "uijeongbu si", "mantua": "mantova", "seville": "sevilla",
                "mecca": "makkah", "medina": "madinah", "mysore": "mysuru",
                "pondicherry": "puducherry", "urmia": "orumiyeh", "pizen": "pilsen",
                "louangphabang": "luang prabang", "pakxe": "pakse", "qayrawan": "kairouan",
                "zhezkazgan": "zhezqazghan", "rishon": "rishon letsiyyon"}
# Territories GeoNames files under their own code but speakers file under a parent.
SIBLINGS = {"CN": ("HK", "MO", "TW"), "GB": ("IM", "JE", "GG"), "US": ("PR", "VI", "GU", "MP"),
            "FR": ("MQ", "GP", "RE", "GF")}
REGION_WORDS = r"\b(province|prefecture|state|region|oblast|governorate|district|county|department|municipality)\b"
ABBREV = [(r"^st\.? ", "saint "), (r"^ste\.? ", "sainte "), (r"^ft\.? ", "fort "),
          (r"^mt\.? ", "mount "), (r" city$", "")]


# Letters with no Unicode decomposition, so NFKD leaves them alone: Wrocław
# would never match "wroclaw" without this.
_LETTERS = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE",
                          "ß": "ss", "đ": "d", "Đ": "D", "ı": "i", "œ": "oe", "þ": "th",
                          "ð": "d", "ħ": "h", "ẖ": "h"})


def norm(s: str | None) -> str:
    """Lower-case, accent-free, punctuation-free, single-spaced."""
    if not s:
        return ""
    s = s.translate(_LETTERS)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("'", "").replace("’", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def variants(s: str) -> list[str]:
    """Spellings to try for one place string, most literal first."""
    base = norm(s)
    out = [base]
    for pat, rep in ABBREV:
        v = norm(re.sub(pat, rep, s.lower().strip()))
        if v and v not in out:
            out.append(v)
    stripped = norm(re.sub(REGION_WORDS, " ", s.lower()))
    if stripped and stripped not in out:
        out.append(stripped)
    # "near X", "X (Y)", "X/Y", "X, Y": try each piece.
    for piece in re.split(r"[/(),]|\bnear\b|\bor\b", s.lower()):
        v = norm(piece)
        if v and v not in out:
            out.append(v)
    # "wilmington nc", "san jose ca": a postal code appended to the city.
    toks = base.split()
    if len(toks) > 1 and len(toks[-1]) == 2:
        out.append(" ".join(toks[:-1]))
    out += [CITY_ALIASES[v] for v in list(out) if v in CITY_ALIASES]
    return list(dict.fromkeys(v for v in out if v))


@dataclass
class Fix:
    lon: float | None
    lat: float | None
    match: str
    matched_name: str = ""
    matched_admin1: str = ""
    country_code: str = ""


class Gazetteer:
    def __init__(self, root: Path = CACHE):
        root = Path(root)
        self.country_code: dict[str, str] = {}
        self.country_point: dict[str, tuple[float, float, str]] = {}
        with (root / "countries.csv").open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                iso = r["iso2"]
                for name in (r["name"], r["native"], r["iso3"]):
                    if name:
                        self.country_code.setdefault(norm(name), iso)
                if r["latitude"] and r["longitude"]:
                    self.country_point[iso] = (float(r["longitude"]), float(r["latitude"]), r["name"])
        self.country_code.update({norm(k): v for k, v in COUNTRY_ALIASES.items()})

        self.states: dict[str, dict[str, tuple[float, float, str]]] = defaultdict(dict)
        with (root / "states.csv").open(encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if not (r["latitude"] and r["longitude"]):
                    continue
                pt = (float(r["longitude"]), float(r["latitude"]), r["name"])
                for name in (r["name"], r["native"], r["iso2"]):
                    for v in variants(name or ""):
                        self.states[r["country_code"]].setdefault(v, pt)

        self.cities: dict[str, dict[str, list[tuple]]] = defaultdict(lambda: defaultdict(list))
        for c in json.loads((root / "cities500.json").read_text(encoding="utf-8")):
            row = (c["name"], c["admin1"], float(c["lon"]), float(c["lat"]), int(c["pop"] or 0))
            self.cities[c["country"]][norm(c["name"])].append(row)
            # GeoNames admin1 names fill gaps in the state table ("Guangdong").
            for v in variants(c["admin1"] or ""):
                self.states[c["country"]].setdefault(v, None)

    # -- the cascade -----------------------------------------------------------------

    def country(self, s: str | None) -> tuple[str, str]:
        """(ISO2, state implied by the country column) or ('', '')."""
        n = norm(s)
        if not n:
            return "", ""
        if n in COUNTRY_AS_REGION:
            return COUNTRY_AS_REGION[n]
        if n in self.country_code:
            return self.country_code[n], ""
        if n in self.states["US"]:                     # 'virginia', 'new york' typed as a country
            return "US", n
        close = difflib.get_close_matches(n, list(self.country_code), n=1, cutoff=0.88)
        return (self.country_code[close[0]], "") if close else ("", "")

    def state(self, iso: str, s: str | None) -> tuple[str, tuple[float, float, str] | None]:
        """(normalised state name, centroid or None) for a state string."""
        for v in variants(s or ""):
            v = STATE_ALIASES.get(v, v)
            if v in self.states[iso]:
                pt = self.states[iso][v]
                # Return the state's own name, not the alias that matched ('va'),
                # because that is what GeoNames' admin1 is compared with.
                return (norm(pt[2]) if pt else v), pt
        return "", None

    def _admin_ok(self, admin1: str, state_key: str) -> bool:
        a = norm(admin1)
        return bool(state_key) and (a == state_key or state_key in a or a in state_key
                                    or difflib.SequenceMatcher(None, a, state_key).ratio() > 0.85)

    def city(self, iso: str, s: str | None, state_key: str, loose: bool = False,
             state_pt: tuple | None = None) -> tuple[tuple | None, str]:
        """Exact name (inside the state if one is given); with `loose`, also the
        head of a longer official name ('city~head'), then a close spelling."""
        table = self.cities.get(iso, {})
        for v in variants(s or ""):
            cands = table.get(v, [])
            if cands:
                inside = [c for c in cands if self._admin_ok(c[1], state_key)]
                if not inside and state_pt is not None:
                    # Boundaries move (Hyderabad: Andhra Pradesh → Telangana in
                    # 2014); a same-named city next to the named state is it.
                    inside = [c for c in cands
                              if haversine_km(c[2], c[3], state_pt[0], state_pt[1]) <= NEAR_STATE_KM]
                if inside:
                    return max(inside, key=lambda c: c[4]), "city+state"
                if not state_key:
                    return max(cands, key=lambda c: c[4]), "city"
        if not loose:
            return None, ""

        def ok(c):
            return not state_key or self._admin_ok(c[1], state_key)

        for v in variants(s or ""):
            if len(v) < 5:                              # short names fuzz onto anything
                continue
            # "frankfurt" → "frankfurt am main": the typed name is the head of a
            # longer official one. Largest such place wins.
            longer = [c for k, cs in table.items() if k.startswith(v + " ") for c in cs if ok(c)]
            if longer:
                return max(longer, key=lambda c: c[4]), "city~head"
            for k in difflib.get_close_matches(v, list(table), n=3, cutoff=FUZZY):
                inside = [c for c in table[k] if ok(c)]
                if inside:
                    return max(inside, key=lambda c: c[4]), "city~"
        return None, ""

    def geocode(self, city: str | None, state: str | None, country: str | None) -> Fix:
        iso, implied = self.country(country)
        if not iso:
            return Fix(None, None, "")
        state_key, state_pt = self.state(iso, state or implied)
        if (state or implied) and not state_key:
            state_key = norm(state or implied)          # unknown to the state table; still filter by it

        hit, how = self.city(iso, city, state_key, state_pt=state_pt)
        if hit is None and state_key and state_pt is None:
            hit, how = self.city(iso, city, "")         # state not recognised: name alone
            how = "city" if hit is not None else how
        if hit is not None:
            return Fix(hit[2], hit[3], how, hit[0], hit[1], iso)

        # Loose matching stays inside a recognised state: a near-miss in the
        # wrong province is worse than that province's centroid.
        hit, how = self.city(iso, city, state_key if state_pt is not None else "", loose=True)
        # The city column sometimes holds a region ("guangdong province",
        # "niedersachsen"). A region beats a close *spelling* — which would
        # find a village called Gangdong — but not a longer official name of
        # the same city ("new york" → New York City).
        _, region = self.state(iso, city)
        if region is not None and how != "city~head":
            return Fix(region[0], region[1], "state", region[2], "", iso)
        if hit is not None:
            return Fix(hit[2], hit[3], "city~", hit[0], hit[1], iso)
        for sib in SIBLINGS.get(iso, ()):               # "hong kong, china"
            for v in variants(city or ""):
                if v in self.cities.get(sib, {}):
                    c = max(self.cities[sib][v], key=lambda c: c[4])
                    return Fix(c[2], c[3], "city", c[0], c[1], sib)

        if state_pt is not None:
            return Fix(state_pt[0], state_pt[1], "state", state_pt[2], "", iso)
        if iso in self.country_point:
            p = self.country_point[iso]
            return Fix(p[0], p[1], "country", p[2], "", iso)
        return Fix(None, None, "", "", "", iso)


def fetch(root: Path = CACHE) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        p = root / name
        if not p.exists():
            print(f"fetching {url}", file=sys.stderr)
            with urllib.request.urlopen(url, timeout=300) as r:
                p.write_bytes(r.read())
    return root


COLUMNS = ["city", "state_or_province", "country", "query", "lon", "lat", "source",
           "match", "matched_name", "matched_admin1", "country_code"]


def run(gaz: Gazetteer, out: Path = OUT) -> dict[str, int]:
    places = sorted({(s.city or "", s.state_or_province or "", s.country or "")
                     for s in saa.load() if s.birthplace})
    tally: dict[str, int] = defaultdict(int)
    rows = []
    for city, state, country in places:
        fx = gaz.geocode(city, state, country)
        tally[fx.match or "unresolved"] += 1
        rows.append([city, state, country, ", ".join(p for p in (city, state, country) if p),
                     "" if fx.lon is None else round(fx.lon, 5),
                     "" if fx.lat is None else round(fx.lat, 5),
                     SOURCE_TAG if fx.match else "", fx.match, fx.matched_name,
                     fx.matched_admin1, fx.country_code])
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows(rows)
    return dict(tally)


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else fetch()
    print(run(Gazetteer(root)))
