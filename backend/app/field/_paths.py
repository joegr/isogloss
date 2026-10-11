"""Find phonemescape whether or not it has been pip-installed.

In the container it is installed from libs/phonemescape. In a checkout it is
simply next door, and the offline tests should not need an install step.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

LIB = Path(__file__).resolve().parents[3] / "libs" / "phonemescape"


def ensure_phonemescape() -> None:
    if importlib.util.find_spec("phonemescape") is None and LIB.is_dir():
        sys.path.insert(0, str(LIB))
