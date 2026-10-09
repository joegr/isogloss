"""
Phonemescape: International Phonetic Alphabet (IPA) Library
IPA segment tokenization, distinctive features, articulatory similarity
and chart visualization.
"""

from .core import Phonemescape
from .data import (
    ALL_CONSONANTS, IPA_CONSONANTS, IPA_NON_PULMONIC, IPA_OTHER_CONSONANTS, IPA_VOWELS,
)
from .features import FEATURE_NAMES
from .segments import Segment, Token, get_segment, segments, tokenize
from .similarity import MouthShapeSimilarity



def __getattr__(name: str):
    # Plotting pulls in matplotlib; keep it out of `import phonemescape` so
    # servers that only need segments and features stay light.
    if name == "IPAPlotter":
        from .plotting import IPAPlotter
        return IPAPlotter
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__version__ = "0.2.0"
__author__ = "Phonemescape Team"

__all__ = [
    "Phonemescape",
    "IPA_VOWELS",
    "IPA_CONSONANTS",
    "IPA_OTHER_CONSONANTS",
    "IPA_NON_PULMONIC",
    "ALL_CONSONANTS",
    "FEATURE_NAMES",
    "IPAPlotter",
    "MouthShapeSimilarity",
    "Segment",
    "Token",
    "get_segment",
    "segments",
    "tokenize",
]
