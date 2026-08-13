"""The analysis pipeline: audio in, language + accent + a posterior on the map out.

Two decoding passes, which is what the extra P in PPRLM buys you:

  1. decode with a language-neutral phonotactic model,
  2. identify the language from that string plus rhythm,
  3. re-decode under the winning language's phonotactics and re-measure.

The second pass matters more than it looks. Phone identity and accent
measurement are coupled — you cannot measure VOT without knowing which segments
are voiceless stops — so a better segmentation gives better sociophonetics,
which is what actually gets geolocated.
"""

from __future__ import annotations

import time

import numpy as np

from . import accent, audio, catalog, config, db, dsp, geo, langid, phones as ph


def _recognizer():
    if config.RECOGNIZER != "template":
        raise RuntimeError(
            f"recogniser {config.RECOGNIZER!r} is not installed in this build; "
            "register an adapter satisfying phones.Recognizer to use it")
    return ph.TemplateRecognizer()


def analyse(data: bytes, model: geo.SpatialModel,
            language_hint: str | None = None) -> dict:
    t0 = time.time()
    x, sr = audio.prepare(data)
    frames = dsp.analyse(x, sr)

    inventory = catalog.phones()
    languages = catalog.languages()
    rec_engine = _recognizer()

    # -- pass 1: language-neutral -----------------------------------------
    rec = rec_engine.recognise(frames, inventory, bigram=None)
    meas = accent.measure(frames, rec)
    rhythm = accent.summarise_rhythm(meas)

    scores = langid.identify(rec, rhythm, languages, inventory)
    chosen = language_hint or scores[0].code
    lang = catalog.by_code().get(chosen)

    # -- pass 2: conditioned on the chosen language ------------------------
    if lang is not None:
        bigram = langid.bigram_matrix(lang, inventory)
        rec = rec_engine.recognise(frames, inventory, bigram=bigram)
        meas = accent.measure(frames, rec)
        rhythm = accent.summarise_rhythm(meas)
        if language_hint is None:
            scores = langid.identify(rec, rhythm, languages, inventory)
            chosen = scores[0].code

    measured = {k: (m.value, m.reliability) for k, m in meas.items()
                if np.isfinite(m.value)}

    result: dict = {
        "duration_s": round(len(x) / sr, 2),
        "bandwidth_hz": round(frames.bandwidth_hz),
        "speech_ratio": round(float(frames.speech.mean()), 3),
        "vtln_warp": round(rec.warp, 3),
        "recognizer": rec_engine.name,
        "language": {
            "code": chosen,
            "confidence": next((s.probability for s in scores if s.code == chosen), None),
            "hinted": language_hint is not None,
            "ranking": [{"code": s.code, "name": s.name, "family": s.family,
                         "probability": round(s.probability, 4), "parts": s.parts}
                        for s in scores[:6]],
        },
        "phones": _phone_payload(rec),
        "accent": [{
            "key": m.key, "label": _feature_label(model, m.key), "value": _round(m.value),
            "unit": _feature_unit(model, m.key), "reliability": round(m.reliability, 3),
            "tokens": m.tokens, "note": m.note,
        } for m in meas.values()],
        "caveats": _caveats(frames, meas, scores),
    }

    # -- geolocation -------------------------------------------------------
    try:
        loc = model.locate(chosen, measured)
    except ValueError as exc:
        result["location"] = {"available": False, "reason": str(exc)}
        result["elapsed_s"] = round(time.time() - t0, 2)
        return result

    regions = {}
    for level, (lons, lats) in loc["regions"].items():
        regions[f"p{int(level * 100)}"] = geo.region_geometry(lons, lats, loc["cell_deg"])

    nearest = model.nearest_varieties(chosen, measured)
    named = _name_place(loc["map"]["lon"], loc["map"]["lat"])

    result["location"] = {
        "available": True,
        "map": loc["map"],
        "mean": loc["mean"],
        "spread_km": round(loc["entropy_km2"], 1),
        "areas": loc["areas"],
        "cell_deg": round(loc["cell_deg"], 4),
        "regions": regions,
        "nearest": nearest,
        "features_used": loc["features_used"],
        "region_name": named.get("region"),
        "nearest_settlement": named.get("settlement"),
    }
    result["elapsed_s"] = round(time.time() - t0, 2)

    if config.LOG_INFERENCES:
        _persist(result, loc, regions, nearest)
    return result


# ---------------------------------------------------------------------------


def _phone_payload(rec: ph.Recognition) -> dict:
    segs = [{
        "ipa": s.ipa, "manner": s.manner,
        "start": round(s.start_s, 3), "end": round(s.end_s, 3),
        "confidence": round(s.confidence, 3),
        "f1": _round(s.f1), "f2": _round(s.f2), "f3": _round(s.f3),
    } for s in rec.segments]

    counts: dict[str, int] = {}
    for s in rec.segments:
        if s.manner != "silence":
            counts[s.ipa] = counts.get(s.ipa, 0) + 1

    return {
        "string": " ".join(rec.phone_string),
        "segments": segs,
        "inventory": sorted(({"ipa": k, "count": v} for k, v in counts.items()),
                            key=lambda d: -d["count"]),
    }


def _caveats(frames: dsp.Frames, meas: dict[str, accent.Measurement],
             scores: list[langid.LangScore]) -> list[str]:
    out = []
    if frames.bandwidth_hz < 3800:
        out.append(
            f"Effective bandwidth is only {frames.bandwidth_hz:.0f} Hz. F3 is not "
            "measurable, so rhoticity — the most informative English feature — has "
            "been down-weighted to near zero.")
    dur = frames.n * frames.hop_s
    if dur < 4.0:
        out.append(f"Only {dur:.1f} s of audio. Most measurements need 10–20 s of "
                   "connected speech before they stabilise.")
    if frames.speech.mean() < 0.35:
        out.append("Most of the recording is silence or noise; measurements are "
                   "based on a short effective sample.")
    weak = [m.key for m in meas.values() if m.reliability < 0.25]
    if len(weak) > 6:
        out.append(f"{len(weak)} of {len(meas)} features could not be measured "
                   "reliably; the posterior will be very broad.")
    if len(scores) > 1 and scores[0].probability - scores[1].probability < 0.06:
        out.append(f"Language identification is nearly tied between "
                   f"{scores[0].name} and {scores[1].name}.")
    if scores and scores[0].family and len(scores) > 1:
        other = next((s for s in scores[1:] if s.family != scores[0].family), None)
        if other and other.probability > 0.20:
            out.append(
                f"Rhythm is also consistent with {other.name}, a different family. "
                "If this is a second-language speaker, the geolocation describes "
                "the target variety, not the speaker's origin.")
    return out


def _name_place(lon: float, lat: float) -> dict:
    row = db.one("""
        SELECT (SELECT label FROM dialect_region
                 WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                 LIMIT 1) AS region,
               (SELECT name FROM settlement
                 ORDER BY geog <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                 LIMIT 1) AS settlement
    """, (lon, lat, lon, lat))
    return row or {}


def _persist(result: dict, loc: dict, regions: dict, nearest: list) -> None:
    db.execute("""
        INSERT INTO inference (language, lang_conf, features, map_point, mean_point,
                               region50, region80, region95, nearest, duration_s)
        VALUES (%s, %s, %s::jsonb,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                ST_GeomFromGeoJSON(%s), ST_GeomFromGeoJSON(%s), ST_GeomFromGeoJSON(%s),
                %s::jsonb, %s)
    """, (
        result["language"]["code"], result["language"]["confidence"],
        __import__("json").dumps({f["key"]: {"value": f["value"],
                                             "reliability": f["reliability"]}
                                  for f in result["accent"]}),
        loc["map"]["lon"], loc["map"]["lat"], loc["mean"]["lon"], loc["mean"]["lat"],
        regions.get("p50"), regions.get("p80"), regions.get("p95"),
        __import__("json").dumps(nearest), result["duration_s"],
    ))


def _feature_label(model: geo.SpatialModel, key: str) -> str:
    return next((f.label for f in model.features if f.key == key), key)


def _feature_unit(model: geo.SpatialModel, key: str) -> str | None:
    return next((f.unit for f in model.features if f.key == key), None)


def _round(v: float, nd: int = 3):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)
