"""Where training nodes and their recordings live.

A node is a place. A recording is raw audio attached to a node, stored
byte-for-byte as uploaded, together with the vector featurize.py computed from
it. Keeping the audio is the point: the featuriser will change, and when it
does, `refeaturize` rebuilds every vector from the original sound rather than
from a lossy summary of it.

Two backends with one interface:

  FileNodeStore  a directory: nodes.json, recordings.json, audio/<id>.wav.
                 What the CLI and the offline tests use.
  PgNodeStore    PostGIS tables audio_node / audio_recording (db/07_audio_nodes.sql).
                 What the API uses, so nodes join against settlements and study
                 areas in SQL like everything else in the field.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import numpy as np

from .featurize import Featurized


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id(prefix: str, label: str = "") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:24]
    return f"{prefix}-{slug + '-' if slug else ''}{uuid.uuid4().hex[:8]}"


@dataclass
class Node:
    id: str
    label: str
    lon: float
    lat: float
    language: str | None = None
    population: float | None = None
    settlement_id: str | None = None
    created: str = field(default_factory=_now)


@dataclass
class Recording:
    id: str
    node_id: str
    features: np.ndarray
    phone_rates: np.ndarray
    duration_s: float
    feature_version: str
    speaker: str | None = None
    phone_string: str = ""
    created: str = field(default_factory=_now)

    def public(self) -> dict:
        return {"id": self.id, "node_id": self.node_id, "duration_s": self.duration_s,
                "speaker": self.speaker, "feature_version": self.feature_version,
                "phone_string": self.phone_string, "created": self.created}


def validate_point(lon: float, lat: float) -> None:
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise ValueError(f"({lon}, {lat}) is not a lon/lat position")


class NodeStore(Protocol):
    def add_node(self, label: str, lon: float, lat: float, language: str | None = None,
                 population: float | None = None, settlement_id: str | None = None) -> Node: ...
    def nodes(self) -> list[Node]: ...
    def get_node(self, node_id: str) -> Node | None: ...
    def delete_node(self, node_id: str) -> bool: ...
    def add_recording(self, node_id: str, wav: bytes, feat: Featurized,
                      speaker: str | None = None) -> Recording: ...
    def recordings(self) -> list[Recording]: ...
    def audio(self, rec_id: str) -> bytes | None: ...
    def update_features(self, rec_id: str, feat: Featurized) -> None: ...


# ---------------------------------------------------------------------------
# Directory
# ---------------------------------------------------------------------------


class FileNodeStore:
    def __init__(self, root: str | os.PathLike):
        self.root = Path(root)
        (self.root / "audio").mkdir(parents=True, exist_ok=True)
        self._nodes = self._load("nodes.json")
        self._recs = self._load("recordings.json")

    def _load(self, name: str) -> dict:
        p = self.root / name
        return json.loads(p.read_text()) if p.exists() else {}

    def _save(self) -> None:
        for name, data in (("nodes.json", self._nodes), ("recordings.json", self._recs)):
            tmp = self.root / f".{name}.tmp"
            tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
            tmp.replace(self.root / name)

    def add_node(self, label, lon, lat, language=None, population=None,
                 settlement_id=None, node_id: str | None = None) -> Node:
        validate_point(lon, lat)
        node = Node(id=node_id or _new_id("node", label), label=label, lon=float(lon),
                    lat=float(lat), language=language, population=population,
                    settlement_id=settlement_id)
        self._nodes[node.id] = asdict(node)
        self._save()
        return node

    def nodes(self) -> list[Node]:
        return [Node(**v) for v in self._nodes.values()]

    def get_node(self, node_id):
        v = self._nodes.get(node_id)
        return Node(**v) if v else None

    def delete_node(self, node_id) -> bool:
        if node_id not in self._nodes:
            return False
        del self._nodes[node_id]
        for rid in [k for k, v in self._recs.items() if v["node_id"] == node_id]:
            (self.root / "audio" / f"{rid}.wav").unlink(missing_ok=True)
            del self._recs[rid]
        self._save()
        return True

    def add_recording(self, node_id, wav, feat, speaker=None) -> Recording:
        if node_id not in self._nodes:
            raise KeyError(f"no node {node_id!r}")
        rec = Recording(id=_new_id("rec"), node_id=node_id, features=feat.vector,
                        phone_rates=feat.phone_rates, duration_s=feat.duration_s,
                        feature_version=feat.version, speaker=speaker,
                        phone_string=feat.phone_string)
        (self.root / "audio" / f"{rec.id}.wav").write_bytes(wav)
        self._recs[rec.id] = _rec_json(rec)
        self._save()
        return rec

    def recordings(self) -> list[Recording]:
        return [_rec_from_json(v) for v in self._recs.values()]

    def audio(self, rec_id):
        p = self.root / "audio" / f"{rec_id}.wav"
        return p.read_bytes() if p.exists() else None

    def update_features(self, rec_id, feat) -> None:
        v = self._recs[rec_id]
        v.update(features=_nan_list(feat.vector), phone_rates=_nan_list(feat.phone_rates),
                 feature_version=feat.version, phone_string=feat.phone_string)
        self._save()


def _nan_list(a: np.ndarray) -> list:
    return [None if not np.isfinite(x) else float(x) for x in np.asarray(a, float)]


def _rec_json(r: Recording) -> dict:
    d = asdict(r)
    d["features"] = _nan_list(r.features)
    d["phone_rates"] = _nan_list(r.phone_rates)
    return d


def _rec_from_json(v: dict) -> Recording:
    v = dict(v)
    v["features"] = np.array([np.nan if x is None else x for x in v["features"]], float)
    v["phone_rates"] = np.array([0.0 if x is None else x for x in v["phone_rates"]], float)
    return Recording(**v)


# ---------------------------------------------------------------------------
# PostGIS
# ---------------------------------------------------------------------------


class PgNodeStore:
    """Nodes as geography points; audio as bytea; vectors as float8[]."""

    def __init__(self):
        from .. import db
        self.db = db

    def add_node(self, label, lon, lat, language=None, population=None,
                 settlement_id=None, node_id: str | None = None) -> Node:
        validate_point(lon, lat)
        row = self.db.one("""
            INSERT INTO audio_node (id, label, language, population, settlement_id, geog)
            VALUES (%s, %s, %s, %s,
                    COALESCE(%s, (SELECT s.id FROM settlement s
                                  WHERE ST_DWithin(s.geog, ST_MakePoint(%s, %s)::geography, 30000)
                                  ORDER BY s.geog <-> ST_MakePoint(%s, %s)::geography LIMIT 1)),
                    ST_MakePoint(%s, %s)::geography)
            RETURNING id
        """, (node_id or _new_id("node", label), label, language, population, settlement_id,
              lon, lat, lon, lat, lon, lat))
        return self.get_node(row["id"])

    def nodes(self) -> list[Node]:
        return [_node_row(r) for r in self.db.query(_NODE_SQL + " ORDER BY n.created, n.id")]

    def get_node(self, node_id):
        r = self.db.one(_NODE_SQL + " WHERE n.id = %s", (node_id,))
        return _node_row(r) if r else None

    def delete_node(self, node_id) -> bool:
        return bool(self.db.one("DELETE FROM audio_node WHERE id = %s RETURNING id", (node_id,)))

    def add_recording(self, node_id, wav, feat, speaker=None) -> Recording:
        rec = Recording(id=_new_id("rec"), node_id=node_id, features=feat.vector,
                        phone_rates=feat.phone_rates, duration_s=feat.duration_s,
                        feature_version=feat.version, speaker=speaker,
                        phone_string=feat.phone_string)
        self.db.execute("""
            INSERT INTO audio_recording (id, node_id, speaker, duration_s, wav, features,
                                         phone_rates, feature_version, phone_string)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (rec.id, node_id, speaker, rec.duration_s, wav, _nan_list(rec.features),
              _nan_list(rec.phone_rates), rec.feature_version, rec.phone_string))
        return rec

    def recordings(self) -> list[Recording]:
        rows = self.db.query("""
            SELECT id, node_id, speaker, duration_s, features, phone_rates, feature_version,
                   phone_string, created::text AS created
            FROM audio_recording ORDER BY created, id
        """)
        return [_rec_from_json(dict(r)) for r in rows]

    def audio(self, rec_id):
        r = self.db.one("SELECT wav FROM audio_recording WHERE id = %s", (rec_id,))
        return bytes(r["wav"]) if r else None

    def update_features(self, rec_id, feat) -> None:
        self.db.execute("""
            UPDATE audio_recording SET features = %s, phone_rates = %s,
                   feature_version = %s, phone_string = %s WHERE id = %s
        """, (_nan_list(feat.vector), _nan_list(feat.phone_rates), feat.version,
              feat.phone_string, rec_id))


_NODE_SQL = """
    SELECT n.id, n.label, ST_X(n.geog::geometry) AS lon, ST_Y(n.geog::geometry) AS lat,
           n.language, COALESCE(n.population, s.population) AS population,
           n.settlement_id, n.created::text AS created
    FROM audio_node n LEFT JOIN settlement s ON s.id = n.settlement_id
"""


def _node_row(r: dict) -> Node:
    return Node(id=r["id"], label=r["label"], lon=float(r["lon"]), lat=float(r["lat"]),
                language=r["language"],
                population=None if r["population"] is None else float(r["population"]),
                settlement_id=r["settlement_id"], created=r["created"])
