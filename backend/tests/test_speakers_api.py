"""The speaker-dot cascade, end to end, against a real PostGIS.

Needs a database built from db/*.sql (ISOGLOSS_DSN) and the gazetteer
(fetched on first use, or ISOGLOSS_GAZETTEER). CI's database job runs it
against the postgis/postgis image; locally:

    ISOGLOSS_DSN=postgresql://isogloss@localhost:5432/isogloss \\
        python3 backend/tests/test_speakers_api.py

Everything it creates is a UI speaker, and it deletes them all at the end, so
it can run against a database you care about.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import db, main, ner  # noqa: E402
from app.voice import synth  # noqa: E402

FAILURES: list[str] = []
CREATED: list[int] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def run(c: TestClient) -> None:
    print("reading")
    dots = c.get("/api/speakers").json()
    check("every placed archive speaker is a dot", len(dots["features"]) >= 3027,
          str(len(dots["features"])))
    eng = c.get("/api/speakers", params={"native_english": True}).json()["features"]
    check("filter: native English", len(eng) == 658 and all(f["properties"]["native_english"]
                                                             for f in eng), str(len(eng)))
    schema = c.get("/api/speakers/schema").json()
    names = [f["name"] for f in schema["fields"]]
    check("schema lists every archive field the form needs",
          {"native_language", "city", "country", "age", "gender", "onset_age", "notes",
           "english_residence", "learning_style"} <= set(names))
    check("schema carries the archive's languages", schema["languages"][0]["value"] == "english")
    one = c.get("/api/speakers/3036").json()
    check("an archive record reads back with its geocode",
          one["record"]["speech_sample"] == "english658.mp3" and one["geo"]["match"] == "city+state")

    print("reverse geocoding a click")
    rv = c.get("/api/geo/reverse", params={"lon": -96.79, "lat": 32.78}).json()
    check("prefill spelt the archive's way", rv["suggest"] == {
        "city": "dallas", "state_or_province": "texas", "country": "usa"}, str(rv["suggest"]))
    sr = c.get("/api/geo/search", params={"q": "lansing, michigan, usa"}).json()
    check("typed birthplace → point", sr["match"] == "city+state" and abs(sr["lat"] - 42.73) < 0.1)

    print("create: record → place → entities")
    bad = c.post("/api/speakers", json={"lon": 0, "lat": 0})
    check("native_language required", bad.status_code == 422)
    bad = c.post("/api/speakers", json={"native_language": "english", "gender": "x", "lon": 0, "lat": 0})
    check("select fields validated", bad.status_code == 422)
    bad = c.post("/api/speakers", json={"native_language": "english", "age": 500, "lon": 0, "lat": 0})
    check("numeric ranges validated", bad.status_code == 422)

    body = {"native_language": "English", "city": "Dallas", "state_or_province": "Texas",
            "country": "usa", "age": "34", "gender": "female", "onset_age": 0,
            "english_residence": "usa, uk", "learning_style": "naturalistic",
            "notes": "10 july 2015. LING523. residence: dallas,0-18; austin,18-40",
            "lon": -96.79, "lat": 32.78}
    r = c.post("/api/speakers", json=body)
    check("create succeeds", r.status_code == 200, r.text[:200])
    sp = r.json()
    sid = sp["record"]["speakerid"]
    CREATED.append(sid)
    check("UI ids start above the archive's", sid >= 100001, str(sid))
    check("fields normalised the archive's way",
          sp["record"]["native_language"] == "english" and sp["record"]["age"] == 34)
    check("per-language index and sample name",
          sp["record"]["speaker"] == 659 and sp["record"]["speech_sample"] == "english659.wav",
          f"{sp['record']['speaker']} {sp['record']['speech_sample']}")
    check("iso code inferred from the language", sp["record"]["ethnologue_language_code"] == "eng")
    check("the pin is the point", sp["geo"]["match"] == "pin" and abs(sp["geo"]["lon"] + 96.79) < 1e-6)
    check("cascade reports its three steps",
          [s["step"] for s in sp["cascade"]] == ["record", "place", "entities"])
    ents = {(e["label"], e["text"]): e for e in sp["entities"]}
    check("NER: date", ("DATE", "10 july 2015") in ents)
    check("NER: collecting course", ("COURSE", "LING523") in ents)
    check("NER: residence places linked", ents.get(("LOC", "austin"), {}).get("place") == "Austin"
          and ents[("LOC", "austin")]["lat"] is not None, str(ents.get(("LOC", "austin"))))
    check("NER: residence list", ents.get(("LOC", "uk"), {}).get("place") == "United Kingdom")
    check("NER model recorded", sp["ner"]["model"] == ner.model_name())
    check("the dot is on the map", any(f["properties"]["id"] == sid for f in
                                       c.get("/api/speakers", params={"origin": "ui"}).json()["features"]))

    print("audio: node → recording → features")
    wav = synth.synthesise("northwind", {"rhoticity": 0.9}, voice="female", seed=3).wav
    a = c.post(f"/api/speakers/{sid}/audio", params={"filename": "mine.wav"}, content=wav)
    check("attach succeeds", a.status_code == 200, a.text[:200])
    aj = a.json()
    check("node created at the speaker", aj["node_id"] == f"spk-{sid}" and not aj["duplicate"])
    check("phones recognised", len(aj["phone_string"]) > 20)
    check("a filename that is not the sample is flagged", any("archive sample" in n for n in aj["notes"]))
    again = c.post(f"/api/speakers/{sid}/audio", params={"filename": "mine.wav"}, content=wav).json()
    check("same file twice is a no-op", again["duplicate"] and again["recording"]["id"] == aj["recording"]["id"])
    back = c.get(f"/api/recordings/{aj['recording']['id']}/audio")
    check("the stored audio is byte-for-byte what was sent", back.content == wav)
    check("record counts one recording", c.get(f"/api/speakers/{sid}").json()["geo"] is not None
          and len(c.get(f"/api/speakers/{sid}").json()["recordings"]) == 1)
    bad = c.post(f"/api/speakers/{sid}/audio", content=b"not audio")
    check("non-audio rejected", bad.status_code == 400)
    second = c.post(f"/api/speakers/{sid}/audio", params={"filename": "b.wav"},
                    content=synth.synthesise("northwind", {}, voice="male", seed=4).wav).json()
    gone = c.delete(f"/api/recordings/{second['recording']['id']}")
    check("a recording can be removed", gone.status_code == 200 and
          len(c.get(f"/api/speakers/{sid}").json()["recordings"]) == 1)

    print("folders of archive files")
    m = c.post("/api/speakers/match-samples",
               json={"filenames": ["recordings/english656.mp3", "ENGLISH1.MP3", "nope.mp3"]}).json()
    check("archive filenames matched to speakers",
          m["matched"].get("recordings/english656.mp3") == 3034 and "ENGLISH1.MP3" in m["matched"]
          and m["unmatched"] == ["nope.mp3"], str(m))

    print("edits")
    r = c.patch("/api/speakers/3036", json={"notes": "edited"})
    check("archive fields are read-only", r.status_code == 422)
    r = c.patch(f"/api/speakers/{sid}", json={"notes": "grew up in miami", "lon": -80.19, "lat": 25.76})
    j = r.json()
    check("UI speakers editable; NER re-runs", r.status_code == 200 and
          any(e["place"] == "Miami" for e in j["entities"]) and
          not any(e["label"] == "COURSE" for e in j["entities"]), str([e["text"] for e in j["entities"]]))
    check("moving the pin moves the point", abs(j["geo"]["lat"] - 25.76) < 1e-6)

    print("delete")
    check("archive speakers cannot be deleted", c.delete("/api/speakers/3036").status_code == 422)
    check("UI speaker deleted", c.delete(f"/api/speakers/{sid}").status_code == 200)
    CREATED.remove(sid)
    check("…with its entities and audio", c.get(f"/api/speakers/{sid}").status_code == 404
          and c.get(f"/api/recordings/{aj['recording']['id']}/audio").status_code == 404)


if __name__ == "__main__":
    with TestClient(main.app) as client:
        try:
            run(client)
        finally:
            for s in CREATED:
                client.delete(f"/api/speakers/{s}")
    db.pool().close()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failed: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all checks passed")
