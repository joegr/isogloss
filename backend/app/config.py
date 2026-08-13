"""Runtime configuration."""

from __future__ import annotations

import os

# Which phone recogniser to use. "template" is the built-in, dependency-free
# one in phones.py. The Protocol in that module is the extension point: an
# adapter wrapping Allosaurus or a wav2vec2 CTC phone model registers here and
# nothing downstream changes, because everything after recognition consumes
# segments and frame posteriors rather than audio.
RECOGNIZER = os.environ.get("ISOGLOSS_RECOGNIZER", "template")

# Cap on request body size for uploads (bytes). 60 s of 16-bit 16 kHz mono is
# about 1.9 MB; the margin is for headers and longer uploaded files.
MAX_UPLOAD = int(os.environ.get("ISOGLOSS_MAX_UPLOAD", 8 * 1024 * 1024))

# Persist every inference (with its posterior polygons) to the `inference`
# table. Off by default: the recordings are not stored, but the derived
# measurements still describe a person's voice.
LOG_INFERENCES = os.environ.get("ISOGLOSS_LOG_INFERENCES", "0") == "1"

VERSION = "0.1.0"
