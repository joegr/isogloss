"""Loading the phonetic catalogue out of the database.

The database is the single source of truth for the phone inventory and the
language profiles, so adding a language is an INSERT rather than a code change.
Everything here is cached for the process lifetime and invalidated by
`reload()`.
"""

from __future__ import annotations

from functools import lru_cache

from . import db
from .langid import Language
from .phones import Phone


@lru_cache(maxsize=1)
def phones() -> list[Phone]:
    rows = db.query("SELECT * FROM phone ORDER BY sonority DESC, ipa")
    return [Phone(ipa=r["ipa"], arpa=r["arpa"], manner=r["manner"], place=r["place"],
                  voiced=r["voiced"], f1=r["f1_hz"], f2=r["f2_hz"], f3=r["f3_hz"],
                  centroid=r["centroid_hz"], flatness=r["flatness"],
                  typical_ms=r["typical_ms"], sonority=r["sonority"]) for r in rows]


@lru_cache(maxsize=1)
def languages() -> list[Language]:
    rows = db.query("SELECT * FROM language ORDER BY code")
    inv: dict[str, dict[str, float]] = {}
    for r in db.query("SELECT language, ipa, freq FROM language_phone"):
        inv.setdefault(r["language"], {})[r["ipa"]] = float(r["freq"])

    exc: dict[str, dict[tuple[str, str], float]] = {}
    for r in db.query("SELECT language, prev, next, logp FROM language_bigram"):
        exc.setdefault(r["language"], {})[(r["prev"], r["next"])] = float(r["logp"])

    out = []
    for r in rows:
        table = inv.get(r["code"], {})
        total = sum(table.values()) or 1.0
        out.append(Language(
            code=r["code"], name=r["name"], family=r["family"],
            rhythm_class=r["rhythm_class"],
            npvi_v_mean=r["npvi_v_mean"], npvi_v_sd=r["npvi_v_sd"],
            pct_v_mean=r["pct_v_mean"], pct_v_sd=r["pct_v_sd"],
            delta_c_mean=r["delta_c_mean"], delta_c_sd=r["delta_c_sd"],
            vowel_inventory=r["vowel_inventory"] or 0,
            cv_strictness=r["cv_strictness"], cluster_tol=r["cluster_tol"],
            speakers_m=r["speakers_m"] or 1.0,
            inventory={k: v / total for k, v in table.items()},
            exceptions=exc.get(r["code"], {}),
        ))
    return out


@lru_cache(maxsize=1)
def by_code() -> dict[str, Language]:
    return {l.code: l for l in languages()}


def reload() -> None:
    phones.cache_clear()
    languages.cache_clear()
    by_code.cache_clear()
