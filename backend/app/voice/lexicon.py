"""Phrase inventory, transcribed in Wells' lexical sets.

Vowels are never written as sounds. `park` is transcribed `p START k`, where
START is not a vowel but a *class* — "the vowel of park, car, hard, farm". Every
accent realises that class differently, and crucially some accents merge classes
that others keep apart. That is exactly the abstraction Wells (1982) invented the
sets for, and it means one transcription renders in any accent without being
re-transcribed.

It also makes the accent parameters fall out as interpolations *between* sets:
BATH is TRAP in Leeds and PALM in Brighton, so `trap_bath` is literally a lerp.
See voice/realisation.py.

The inventory is hand-written. There is no grapheme-to-phoneme fallback on
purpose: a rule-based G2P would silently mistranscribe, and a wrong vowel class
is indistinguishable from a wrong accent in the output.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Wells' standard sets, plus the three weak-vowel sets.
LEXICAL_SETS = {
    # checked
    "KIT", "DRESS", "TRAP", "LOT", "STRUT", "FOOT",
    # free
    "BATH", "CLOTH", "NURSE", "FLEECE", "FACE", "PALM", "THOUGHT", "GOAT",
    "GOOSE", "PRICE", "CHOICE", "MOUTH",
    # rhotic / centring
    "NEAR", "SQUARE", "START", "NORTH", "FORCE", "CURE",
    # weak
    "happY", "lettER", "commA",
}

# Sets whose historical vowel was followed by /r/. Whether that /r/ surfaces —
# and what it does to the vowel — is the `rhoticity` parameter's whole job.
RHOTIC_SETS = {"NURSE", "NEAR", "SQUARE", "START", "NORTH", "FORCE", "CURE", "lettER"}


def is_set(token: str) -> bool:
    return token in LEXICAL_SETS


@dataclass
class Word:
    tokens: list[str]          # consonant IPA symbols and lexical-set names
    stress: int = 1            # 0 unstressed, 1 primary, 2 secondary/reduced
    text: str = ""

    def vowels(self) -> list[int]:
        return [i for i, t in enumerate(self.tokens) if is_set(t)]


@dataclass
class Phrase:
    id: str
    text: str
    words: list[Word]
    probes: list[str] = field(default_factory=list)
    note: str = ""


def w(text: str, tokens: str, stress: int = 1) -> Word:
    return Word(tokens=tokens.split(), stress=stress, text=text)


# ---------------------------------------------------------------------------
# The inventory
# ---------------------------------------------------------------------------
# Each short phrase is a diagnostic: it isolates one or two features so the
# difference between two varieties is audible rather than merely present.

PHRASES: list[Phrase] = [

    Phrase("harvard", "Park the car in Harvard Yard", [
        w("Park", "p START k"),
        w("the", "ð commA", 0),
        w("car", "k START"),
        w("in", "KIT n", 0),
        w("Harvard", "h START v lettER d"),
        w("Yard", "j START d"),
    ], probes=["rhoticity"],
       note="The standard rhoticity probe: five /r/s, four of them postvocalic."),

    Phrase("cot_caught", "Don caught a lot of cots", [
        w("Don", "d LOT n"),
        w("caught", "k THOUGHT t"),
        w("a", "commA", 0),
        w("lot", "l LOT t"),
        w("of", "commA v", 0),
        w("cots", "k LOT t s"),
    ], probes=["low_back_merge"],
       note="LOT against THOUGHT. Merged across most of North America, "
            "distinct across most of England."),

    Phrase("bath", "Ask for a glass of water in the bath", [
        w("Ask", "BATH s k"),
        w("for", "f NORTH", 0),
        w("a", "commA", 0),
        w("glass", "g l BATH s"),
        w("of", "commA v", 0),
        w("water", "w THOUGHT t lettER"),
        w("in", "KIT n", 0),
        w("the", "ð commA", 0),
        w("bath", "b BATH θ"),
    ], probes=["trap_bath"],
       note="The north/south English isogloss, three times over."),

    Phrase("bottle", "Better butter in a little bottle", [
        w("Better", "b DRESS t lettER"),
        w("butter", "b STRUT t lettER"),
        w("in", "KIT n", 0),
        w("a", "commA", 0),
        w("little", "l KIT t commA l"),
        w("bottle", "b LOT t commA l"),
    ], probes=["t_glottal"],
       note="Five intervocalic /t/s: glottalled in Glasgow and London, "
            "tapped in North America, released in conservative RP."),

    Phrase("thirty", "Three thousand things are worth it", [
        w("Three", "θ ɹ FLEECE"),
        w("thousand", "θ MOUTH z commA n d"),
        w("things", "θ KIT ŋ z"),
        w("are", "START", 0),
        w("worth", "w NURSE θ"),
        w("it", "KIT t", 0),
    ], probes=["th_shift"],
       note="Dental fricatives: fronted to [f] in much of England, stopped to "
            "[t] in Ireland and New York."),

    Phrase("goose", "Choose a few new tunes", [
        w("Choose", "tʃ GOOSE z"),
        w("a", "commA", 0),
        w("few", "f j GOOSE"),
        w("new", "n j GOOSE"),
        w("tunes", "t j GOOSE n z"),
    ], probes=["goose_f2"],
       note="GOOSE fronting, plus the yod that American varieties drop."),

    Phrase("price", "My wife likes rice at night", [
        w("My", "m PRICE"),
        w("wife", "w PRICE f"),
        w("likes", "l PRICE k s"),
        w("rice", "ɹ PRICE s"),
        w("at", "TRAP t", 0),
        w("night", "n PRICE t"),
    ], probes=["diph_index"],
       note="PRICE: a long glide in London, close to a monophthong in Alabama."),

    Phrase("mouth", "How now brown cow", [
        w("How", "h MOUTH"),
        w("now", "n MOUTH"),
        w("brown", "b ɹ MOUTH n"),
        w("cow", "k MOUTH"),
    ], probes=["diph_index"],
       note="MOUTH, which Pittsburgh flattens and Cockney fronts."),

    Phrase("face", "They say the name of the day", [
        w("They", "ð FACE", 0),
        w("say", "s FACE"),
        w("the", "ð commA", 0),
        w("name", "n FACE m"),
        w("of", "commA v", 0),
        w("the", "ð commA", 0),
        w("day", "d FACE"),
    ], probes=["diph_index"],
       note="FACE: monophthongal across the north of England and Scotland."),

    Phrase("northwind", "The North Wind and the Sun were disputing which was "
                        "the stronger, when a traveller came along wrapped in "
                        "a warm cloak", [
        w("The", "ð commA", 0),
        w("North", "n NORTH θ"),
        w("Wind", "w KIT n d"),
        w("and", "commA n d", 0),
        w("the", "ð commA", 0),
        w("Sun", "s STRUT n"),
        w("were", "w NURSE", 0),
        w("disputing", "d KIT s p j GOOSE t KIT ŋ"),
        w("which", "w KIT tʃ", 0),
        w("was", "w LOT z", 0),
        w("the", "ð commA", 0),
        w("stronger", "s t ɹ LOT ŋ g lettER"),
        w("when", "w DRESS n", 0),
        w("a", "commA", 0),
        w("traveller", "t ɹ TRAP v commA l lettER"),
        w("came", "k FACE m"),
        w("along", "commA l LOT ŋ", 0),
        w("wrapped", "ɹ TRAP p t"),
        w("in", "KIT n", 0),
        w("a", "commA", 0),
        w("warm", "w NORTH m"),
        w("cloak", "k l GOAT k"),
    ], probes=["npvi_v", "pct_v", "delta_c", "f0_span", "vowel_area"],
       note="The opening of the IPA's standard passage. Long enough that the "
            "rhythm metrics stabilise, which the one-line probes are not."),
]

BY_ID = {p.id: p for p in PHRASES}


def get(phrase_id: str) -> Phrase:
    if phrase_id not in BY_ID:
        raise KeyError(f"unknown phrase {phrase_id!r}; have {sorted(BY_ID)}")
    return BY_ID[phrase_id]
