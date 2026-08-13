/* Isogloss — the accent synthesiser, ported to run in the browser.
 *
 * GitHub Pages is static, so there is no Python here: this is a faithful port
 * of backend/app/voice/{klatt,lexicon,realisation,synth}.py. Keep the two in
 * step — the Python side has the round-trip tests that prove the rules mean
 * what they claim (backend/tests/test_voice.py).
 *
 * Vowels are never written as sounds. They are written as Wells lexical sets,
 * and the accent parameters are interpolations *between* sets:
 *
 *     BATH = lerp(TRAP, PALM, trap_bath)      the north/south English isogloss
 *     LOT, THOUGHT converge by low_back_merge
 *
 * That is the whole trick, and it is why one transcription renders in any accent.
 */

export const SR = 16000;
export const HOP_S = 0.010;

/* ------------------------------------------------------------------ */
/* Lexicon                                                             */
/* ------------------------------------------------------------------ */

export const RHOTIC_SETS = new Set(
  ["NURSE", "NEAR", "SQUARE", "START", "NORTH", "FORCE", "CURE", "lettER"]);

const V = (f1, f2, f3, dur, off = null, rhotic = false) => ({ f1, f2, f3, dur, off, rhotic });

export const BASE_VOWELS = {
  KIT:     V(400, 1900, 2550, 95),
  DRESS:   V(550, 1770, 2490, 105),
  TRAP:    V(690, 1660, 2450, 135),
  LOT:     V(620, 1000, 2500, 115),
  STRUT:   V(620, 1200, 2550, 100),
  FOOT:    V(450, 1100, 2400, 95),
  CLOTH:   V(600, 900, 2450, 130),
  BATH:    V(690, 1660, 2450, 165),
  NURSE:   V(500, 1450, 2350, 185, null, true),
  FLEECE:  V(300, 2250, 2900, 175, [280, 2320, 2900]),
  FACE:    V(450, 2000, 2600, 195, [350, 2350, 2800]),
  PALM:    V(730, 1100, 2500, 195),
  THOUGHT: V(570, 840, 2400, 195),
  GOAT:    V(500, 1250, 2400, 195, [400, 900, 2350]),
  GOOSE:   V(310, 900, 2200, 180, [300, 1000, 2250]),
  PRICE:   V(720, 1300, 2500, 215, [350, 2100, 2700]),
  CHOICE:  V(500, 800, 2400, 225, [350, 2050, 2700]),
  MOUTH:   V(700, 1400, 2500, 220, [400, 900, 2300]),
  NEAR:    V(400, 2050, 2700, 210, [500, 1500, 2400], true),
  SQUARE:  V(550, 1850, 2500, 200, [520, 1500, 2400], true),
  START:   V(730, 1150, 2450, 205, null, true),
  NORTH:   V(570, 850, 2400, 195, null, true),
  FORCE:   V(450, 900, 2350, 195, null, true),
  CURE:    V(400, 1050, 2300, 200, [500, 1500, 2400], true),
  happY:   V(350, 2150, 2800, 95),
  lettER:  V(500, 1450, 2350, 80, null, true),
  commA:   V(500, 1500, 2450, 60),
};

const C = (kind, voiced, locus, dur, extra = {}) => ({
  kind, voiced, locus, dur, fricCf: 4000, fricBw: 1800, burstCf: 2000,
  aspirated: false, ...extra,
});

export const BASE_CONSONANTS = {
  p:  C("stop", false, [300, 800, 2100], 85, { burstCf: 1100, aspirated: true }),
  b:  C("stop", true,  [300, 800, 2100], 70, { burstCf: 900 }),
  t:  C("stop", false, [350, 1750, 2600], 85, { burstCf: 4200, aspirated: true }),
  d:  C("stop", true,  [350, 1750, 2600], 68, { burstCf: 3400 }),
  k:  C("stop", false, [300, 1900, 2400], 90, { burstCf: 2100, aspirated: true }),
  g:  C("stop", true,  [300, 1900, 2400], 72, { burstCf: 1800 }),
  "ʔ": C("stop", false, [400, 1500, 2400], 55, { burstCf: 700 }),
  m:  C("nasal", true, [300, 900, 2200], 72),
  n:  C("nasal", true, [300, 1600, 2600], 68),
  "ŋ": C("nasal", true, [300, 2000, 2600], 78),
  f:  C("fricative", false, [300, 900, 2200], 95, { fricCf: 5400, fricBw: 2600 }),
  v:  C("fricative", true,  [300, 900, 2200], 70, { fricCf: 4600, fricBw: 2400 }),
  "θ": C("fricative", false, [350, 1500, 2500], 95, { fricCf: 5800, fricBw: 3000 }),
  "ð": C("fricative", true,  [350, 1500, 2500], 55, { fricCf: 4200, fricBw: 2600 }),
  s:  C("fricative", false, [350, 1700, 2600], 105, { fricCf: 6600, fricBw: 1200 }),
  z:  C("fricative", true,  [350, 1700, 2600], 80, { fricCf: 5900, fricBw: 1300 }),
  "ʃ": C("fricative", false, [350, 1900, 2500], 110, { fricCf: 3700, fricBw: 1200 }),
  "ʒ": C("fricative", true,  [350, 1900, 2500], 85, { fricCf: 3400, fricBw: 1300 }),
  h:  C("fricative", false, [500, 1500, 2500], 62, { fricCf: 1600, fricBw: 3500 }),
  "tʃ": C("affricate", false, [350, 1900, 2500], 120, { fricCf: 3900, fricBw: 1300, burstCf: 3900 }),
  "dʒ": C("affricate", true,  [350, 1900, 2500], 100, { fricCf: 3300, fricBw: 1400, burstCf: 3300 }),
  l:  C("approximant", true, [400, 1400, 2700], 70),
  "ɫ": C("approximant", true, [450, 800, 2600], 80),
  "ɹ": C("approximant", true, [350, 1100, 1600], 70),
  w:  C("approximant", true, [300, 700, 2200], 62),
  j:  C("approximant", true, [280, 2100, 3000], 58),
};

const w = (text, tokens, stress = 1) => ({ text, tokens: tokens.split(" "), stress });

export const PHRASES = [
  { id: "harvard", text: "Park the car in Harvard Yard", probes: ["rhoticity"],
    note: "Five /r/s, four of them postvocalic — the standard rhoticity probe.",
    words: [w("Park", "p START k"), w("the", "ð commA", 0), w("car", "k START"),
            w("in", "KIT n", 0), w("Harvard", "h START v lettER d"), w("Yard", "j START d")] },
  { id: "cot_caught", text: "Don caught a lot of cots", probes: ["low_back_merge"],
    note: "Merged across most of North America, distinct across most of England.",
    words: [w("Don", "d LOT n"), w("caught", "k THOUGHT t"), w("a", "commA", 0),
            w("lot", "l LOT t"), w("of", "commA v", 0), w("cots", "k LOT t s")] },
  { id: "bath", text: "Ask for a glass of water in the bath", probes: ["trap_bath"],
    note: "The north/south English isogloss, three times over.",
    words: [w("Ask", "BATH s k"), w("for", "f NORTH", 0), w("a", "commA", 0),
            w("glass", "g l BATH s"), w("of", "commA v", 0),
            w("water", "w THOUGHT t lettER"), w("in", "KIT n", 0),
            w("the", "ð commA", 0), w("bath", "b BATH θ")] },
  { id: "bottle", text: "Better butter in a little bottle", probes: ["t_glottal"],
    note: "Five intervocalic /t/s: glottalled in Glasgow and London, tapped in North America.",
    words: [w("Better", "b DRESS t lettER"), w("butter", "b STRUT t lettER"),
            w("in", "KIT n", 0), w("a", "commA", 0), w("little", "l KIT t commA l"),
            w("bottle", "b LOT t commA l")] },
  { id: "thirty", text: "Three thousand things are worth it", probes: ["th_shift"],
    note: "Fronted to [f] in much of England, stopped to [t] in Ireland and New York.",
    words: [w("Three", "θ ɹ FLEECE"), w("thousand", "θ MOUTH z commA n d"),
            w("things", "θ KIT ŋ z"), w("are", "START", 0), w("worth", "w NURSE θ"),
            w("it", "KIT t", 0)] },
  { id: "goose", text: "Choose a few new tunes", probes: ["goose_f2"],
    note: "GOOSE fronting, plus the yod that American varieties drop.",
    words: [w("Choose", "tʃ GOOSE z"), w("a", "commA", 0), w("few", "f j GOOSE"),
            w("new", "n j GOOSE"), w("tunes", "t j GOOSE n z")] },
  { id: "price", text: "My wife likes rice at night", probes: ["diph_index"],
    note: "A long glide in London, close to a monophthong in Alabama.",
    words: [w("My", "m PRICE"), w("wife", "w PRICE f"), w("likes", "l PRICE k s"),
            w("rice", "ɹ PRICE s"), w("at", "TRAP t", 0), w("night", "n PRICE t")] },
  { id: "mouth", text: "How now brown cow", probes: ["diph_index"],
    note: "MOUTH, which Pittsburgh flattens and Cockney fronts.",
    words: [w("How", "h MOUTH"), w("now", "n MOUTH"), w("brown", "b ɹ MOUTH n"),
            w("cow", "k MOUTH")] },
  { id: "face", text: "They say the name of the day", probes: ["diph_index"],
    note: "FACE: monophthongal across the north of England and Scotland.",
    words: [w("They", "ð FACE", 0), w("say", "s FACE"), w("the", "ð commA", 0),
            w("name", "n FACE m"), w("of", "commA v", 0), w("the", "ð commA", 0),
            w("day", "d FACE")] },
  { id: "northwind", text: "The North Wind and the Sun were disputing which was the "
      + "stronger, when a traveller came along wrapped in a warm cloak",
    probes: ["npvi_v", "pct_v", "delta_c", "f0_span"],
    note: "The IPA's standard passage. Long enough that the rhythm metrics settle.",
    words: [w("The", "ð commA", 0), w("North", "n NORTH θ"), w("Wind", "w KIT n d"),
            w("and", "commA n d", 0), w("the", "ð commA", 0), w("Sun", "s STRUT n"),
            w("were", "w NURSE", 0), w("disputing", "d KIT s p j GOOSE t KIT ŋ"),
            w("which", "w KIT tʃ", 0), w("was", "w LOT z", 0), w("the", "ð commA", 0),
            w("stronger", "s t ɹ LOT ŋ g lettER"), w("when", "w DRESS n", 0),
            w("a", "commA", 0), w("traveller", "t ɹ TRAP v commA l lettER"),
            w("came", "k FACE m"), w("along", "commA l LOT ŋ", 0),
            w("wrapped", "ɹ TRAP p t"), w("in", "KIT n", 0), w("a", "commA", 0),
            w("warm", "w NORTH m"), w("cloak", "k l GOAT k")] },
];

export const isSet = (t) => Object.prototype.hasOwnProperty.call(BASE_VOWELS, t);

/* ------------------------------------------------------------------ */
/* Realisation — the accent vector becomes phonetic targets             */
/* ------------------------------------------------------------------ */

export const FEATURES = [
  { key: "rhoticity", label: "Rhoticity", lo: 0, hi: 1, step: 0.01,
    hint: "Does postvocalic /r/ surface? Heard as a lowered third formant." },
  { key: "trap_bath", label: "TRAP–BATH split", lo: 0, hi: 1, step: 0.01,
    hint: "0 = 'bath' rhymes with 'math' (Leeds). 1 = with 'palm' (Brighton)." },
  { key: "low_back_merge", label: "LOT–THOUGHT merger", lo: 0, hi: 1, step: 0.01,
    hint: "1 = 'cot' and 'caught' are the same word." },
  { key: "goose_f2", label: "GOOSE fronting", lo: 0, hi: 1, step: 0.01,
    hint: "How far forward the high back vowel has travelled. A change in progress." },
  { key: "diph_index", label: "Diphthongisation", lo: 0, hi: 1, step: 0.01,
    hint: "Glide length. Low = Yorkshire or Alabama monophthongs, high = Cockney." },
  { key: "vowel_area", label: "Vowel space area", lo: 0.4, hi: 1.4, step: 0.01,
    hint: "How far the vowels disperse from their common centre." },
  { key: "vot_ms", label: "Voice onset time", lo: 10, hi: 110, step: 1, unit: "ms",
    hint: "Aspiration after /p t k/. Long in Germanic, short in Romance and Scots." },
  { key: "npvi_v", label: "Vocalic nPVI", lo: 20, hi: 80, step: 1,
    hint: "Long–short alternation. High = stress-timed, low = syllable-timed." },
  { key: "pct_v", label: "Proportion vocalic", lo: 33, hi: 55, step: 0.5, unit: "%",
    hint: "Share of speech that is vowel." },
  { key: "delta_c", label: "Consonantal spread", lo: 25, hi: 80, step: 1, unit: "ms" ,
    hint: "Spread of consonant durations. High = complex clusters." },
  { key: "f0_span", label: "Pitch span", lo: 2, hi: 14, step: 0.1, unit: "st",
    hint: "Semitone range of the melody. Wide in Belfast, Cork and Tyneside." },
  { key: "final_rise", label: "Phrase-final rise", lo: 0, hi: 1, step: 0.01,
    hint: "Statements ending upward. Belfast, Cork, Australia, California." },
  { key: "t_glottal", label: "T-glottalling", lo: 0, hi: 1, step: 0.01,
    hint: "'bottle' → 'bo'le'. A textbook city-first cascade change." },
  { key: "th_shift", label: "TH shifting", lo: 0, hi: 1, step: 0.01,
    hint: "'three' → 'free' (England) or 'tree' (Ireland). Which one is inferred." },
];

export const VOICES = {
  male:   { tract: 1.00, f0: 112 },
  female: { tract: 1.17, f0: 196 },
  child:  { tract: 1.35, f0: 250 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const fmt = (v) => [v.f1, v.f2, v.f3];

export function realise(f, voiceName = "male") {
  const voice = VOICES[voiceName] || VOICES.male;
  const Vs = {};
  for (const [k, v] of Object.entries(BASE_VOWELS)) Vs[k] = { ...v, off: v.off ? [...v.off] : null };
  const notes = [];

  // LOT / THOUGHT merger.
  const mid = fmt(Vs.LOT).map((a, i) => (a + fmt(Vs.THOUGHT)[i]) / 2);
  [Vs.LOT.f1, Vs.LOT.f2, Vs.LOT.f3] = lerp3(fmt(Vs.LOT), mid, f.low_back_merge);
  [Vs.THOUGHT.f1, Vs.THOUGHT.f2, Vs.THOUGHT.f3] = lerp3(fmt(Vs.THOUGHT), mid, f.low_back_merge);
  Vs.THOUGHT.dur = lerp(195, 140, f.low_back_merge);
  Vs.CLOTH = { ...Vs.THOUGHT, dur: 130 };
  if (f.low_back_merge > 0.7) notes.push("LOT and THOUGHT merged");

  // TRAP / BATH split.
  [Vs.BATH.f1, Vs.BATH.f2, Vs.BATH.f3] = lerp3(fmt(Vs.TRAP), fmt(Vs.PALM), f.trap_bath);
  Vs.BATH.dur = lerp(140, 200, f.trap_bath);
  notes.push(f.trap_bath > 0.6 ? "BATH is PALM-like"
           : f.trap_bath < 0.4 ? "BATH is TRAP-like" : "BATH intermediate");

  // GOOSE fronting drags FOOT and the GOAT offglide with it.
  Vs.GOOSE.f2 = lerp(900, 1900, f.goose_f2);
  Vs.GOOSE.off = [Vs.GOOSE.off[0], Vs.GOOSE.f2 + 90, Vs.GOOSE.off[2]];
  Vs.FOOT.f2 = lerp(1050, 1500, f.goose_f2);
  Vs.GOAT.off = [Vs.GOAT.off[0], lerp(850, 1350, f.goose_f2), Vs.GOAT.off[2]];

  // Diphthong excursion is *measured* as trajectory length, so here it is one.
  const scale = 0.25 + 1.35 * f.diph_index;
  for (const v of Object.values(Vs)) {
    if (v.off) v.off = fmt(v).map((on, i) => lerp(on, v.off[i], scale));
  }

  // Rhoticity: r-colouring is F3 lowering, which is what the analyser measures.
  for (const name of RHOTIC_SETS) {
    const v = Vs[name];
    v.f3 = lerp(v.f3, 1700, f.rhoticity);
    v.f2 = lerp(v.f2, v.f2 * 0.93, f.rhoticity);
    if (["NEAR", "SQUARE", "CURE"].includes(name) && v.off) {
      v.off = v.off.map((o, i) => lerp(o, [v.f1, v.f2, 1700][i], f.rhoticity));
    }
    if (["START", "NORTH", "FORCE", "NURSE"].includes(name)) {
      v.dur = lerp(v.dur * 1.12, v.dur, f.rhoticity);
    }
  }
  notes.push(f.rhoticity > 0.55 ? "rhotic" : f.rhoticity < 0.3 ? "non-rhotic" : "variably rhotic");

  // Dispersion. Area scales as the square of a length.
  const all = Object.values(Vs);
  const cx = all.reduce((s, v) => s + v.f1, 0) / all.length;
  const cy = all.reduce((s, v) => s + v.f2, 0) / all.length;
  const disp = Math.sqrt(Math.max(0.35, f.vowel_area));
  for (const v of all) {
    v.f1 = cx + (v.f1 - cx) * disp;
    v.f2 = cy + (v.f2 - cy) * disp;
    if (v.off) v.off = [cx + (v.off[0] - cx) * disp, cy + (v.off[1] - cy) * disp, v.off[2]];
  }

  const Cs = {};
  for (const [k, c] of Object.entries(BASE_CONSONANTS)) Cs[k] = { ...c, locus: [...c.locus] };
  for (const ipa of ["p", "t", "k"]) Cs[ipa].dur = 55 + 0.45 * f.vot_ms;

  // Fronting vs stopping: acoustically close, geographically distinct. The tie
  // is broken the way a dialectologist would — stopping is the Irish/New York
  // pattern, which co-occurs with rhoticity and a wide pitch span.
  const thStrategy = (f.rhoticity > 0.5 && f.f0_span > 9.0) ? "stopping" : "fronting";

  for (const v of all) {
    v.f1 *= voice.tract; v.f2 *= voice.tract; v.f3 *= voice.tract;
    if (v.off) v.off = v.off.map((x) => x * voice.tract);
  }
  for (const c of Object.values(Cs)) {
    c.locus = c.locus.map((x) => x * voice.tract);
    c.fricCf *= 1 + (voice.tract - 1) * 0.5;
    c.burstCf *= 1 + (voice.tract - 1) * 0.5;
  }

  return { features: f, voice, vowels: Vs, consonants: Cs, thStrategy, notes };
}

/* Deterministic per-token roll, so the same phrase in the same accent renders
   identically every time. Variable rules are variable, not random. */
function roll(salt, wi, ti) {
  let h = 2166136261 >>> 0;
  const s = `${salt}:${wi}:${ti}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967295;
}

export function applyVariables(tokens, real, wi) {
  const f = real.features;
  let out = [...tokens];
  for (let i = 0; i < out.length; i++) {
    const tok = out[i];
    if (tok === "θ" || tok === "ð") {
      if (roll("th", wi, i) < f.th_shift) {
        out[i] = real.thStrategy === "stopping" ? (tok === "θ" ? "t" : "d")
                                                : (tok === "θ" ? "f" : "v");
      }
    } else if (tok === "t") {
      if (i !== 0 && roll("tg", wi, i) < f.t_glottal) out[i] = "ʔ";
    } else if (tok === "l") {
      if (!out.slice(i + 1).some(isSet)) out[i] = "ɫ";
    } else if (tok === "j") {
      const prev = i > 0 ? out[i - 1] : "";
      if (["t", "d", "n", "s", "z"].includes(prev) && f.rhoticity > 0.7 && f.trap_bath < 0.7) {
        out[i] = "";
      }
    }
  }
  return out.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

const LEAD_MS = 140, WORD_GAP_MS = 22, END_MS = 260;

export function segment(phrase, real) {
  const segs = [{ kind: "pause", token: "", dur: LEAD_MS }];
  phrase.words.forEach((word, wi) => {
    for (const tok of applyVariables(word.tokens, real, wi)) {
      if (isSet(tok)) {
        const v = real.vowels[tok];
        segs.push({ kind: "vowel", token: tok, dur: v.dur, onset: fmt(v),
                    offset: v.off || fmt(v), stressed: word.stress === 1, nasal: 0, wi });
      } else {
        if (tok === "ɹ" && real.features.rhoticity < 0.35) continue;
        const c = real.consonants[tok];
        if (!c) continue;
        segs.push({ kind: c.kind, token: tok, dur: c.dur, onset: c.locus, offset: c.locus,
                    voiced: c.voiced, fricCf: c.fricCf, fricBw: c.fricBw,
                    burstCf: c.burstCf, aspirated: c.aspirated,
                    nasal: c.kind === "nasal" ? 1 : 0, wi });
      }
    }
    segs.push({ kind: "pause", token: "", dur: WORD_GAP_MS, wi });
  });
  segs[segs.length - 1] = { kind: "pause", token: "", dur: END_MS };
  return segs;
}

const std = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
};

export function timeSegments(segs, real) {
  const f = real.features;
  const contrast = Math.min(1, Math.max(0, (f.npvi_v - 20) / 60));
  for (const s of segs) {
    if (s.kind === "vowel") s.dur *= s.stressed ? 1 + 0.55 * contrast : 1 - 0.45 * contrast;
  }
  const vowels = segs.filter((s) => s.kind === "vowel");
  const cons = segs.filter((s) => s.kind !== "vowel" && s.kind !== "pause");
  if (!vowels.length || !cons.length) return segs;

  // ΔC first, then %V: rescaling consonants would break a %V already solved,
  // while %V only scales vowels and leaves ΔC alone.
  let durs = cons.map((s) => s.dur);
  const want = Math.min(95, Math.max(15, f.delta_c));
  for (let it = 0; it < 6; it++) {
    const cur = std(durs);
    if (cur < 1e-6) break;
    const sc = Math.min(3.5, Math.max(0.3, want / cur));
    if (Math.abs(sc - 1) < 0.01) break;
    const m = durs.reduce((s, x) => s + x, 0) / durs.length;
    durs = durs.map((d) => Math.max(22, m + (d - m) * sc));
  }
  cons.forEach((s, i) => { s.dur = durs[i]; });

  const target = Math.min(0.62, Math.max(0.25, f.pct_v / 100));
  const Vt = vowels.reduce((s, x) => s + x.dur, 0);
  const Ct = cons.reduce((s, x) => s + x.dur, 0);
  const k = (target * Ct) / Math.max((1 - target) * Vt, 1e-6);
  for (const s of vowels) s.dur *= k;
  return segs;
}

/* ------------------------------------------------------------------ */
/* Track                                                               */
/* ------------------------------------------------------------------ */

export function buildTrack(segs, real, seed = 0) {
  const f = real.features;
  const hopMs = HOP_S * 1000;
  const total = segs.reduce((s, x) => s + x.dur, 0);
  const n = Math.max(4, Math.round(total / hopMs));

  const tr = {
    n, seed,
    f0: new Float64Array(n), av: new Float64Array(n), ah: new Float64Array(n),
    af: new Float64Array(n), nasal: new Float64Array(n),
    fricCf: new Float64Array(n).fill(4000), fricBw: new Float64Array(n).fill(1800),
    F: [0, 1, 2, 3, 4].map(() => new Float64Array(n)),
    B: [0, 1, 2, 3, 4].map(() => new Float64Array(n)),
  };

  const knots = [];
  const voiced = new Uint8Array(n), stressed = new Uint8Array(n), creak = new Uint8Array(n);

  let pos = 0;
  for (const s of segs) {
    const a = Math.round(pos / hopMs);
    const b = Math.min(n, Math.max(a + 1, Math.round((pos + s.dur) / hopMs)));
    pos += s.dur;
    const span = b - a;
    if (a >= n) break;

    if (s.kind === "pause") { tr.av.fill(0, a, b); continue; }

    if (s.kind === "vowel") {
      tr.av.fill(1, a, b);
      knots.push([a + 0.25 * span, ...s.onset]);
      knots.push([a + 0.78 * span, ...s.offset]);
      voiced.fill(1, a, b);
      if (s.stressed) stressed.fill(1, a, b);
    } else if (s.kind === "nasal") {
      tr.av.fill(0.75, a, b); tr.nasal.fill(1, a, b);
      knots.push([a + 0.5 * span, ...s.onset]); voiced.fill(1, a, b);
    } else if (s.kind === "approximant") {
      tr.av.fill(0.92, a, b);
      knots.push([a + 0.5 * span, ...s.onset]); voiced.fill(1, a, b);
    } else if (s.kind === "fricative") {
      if (s.token === "h") { tr.av.fill(0, a, b); tr.ah.fill(0.85, a, b); }
      else {
        tr.av.fill(s.voiced ? 0.3 : 0, a, b);
        tr.af.fill(s.voiced ? 0.85 : 1, a, b);
        tr.fricCf.fill(s.fricCf, a, b); tr.fricBw.fill(s.fricBw, a, b);
        knots.push([a + 0.5 * span, ...s.onset]);
        if (s.voiced) voiced.fill(1, a, b);
      }
    } else {
      knots.push([Math.max(a - 1, 0), ...s.onset]);
      const burst = Math.max(1, Math.round(18 / hopMs));
      const asp = s.aspirated ? Math.round(Math.max(0, f.vot_ms - 18) / hopMs) : 0;
      const closeEnd = Math.max(a + 1, b - burst - asp);
      tr.av.fill(s.voiced ? 0.12 : 0, a, closeEnd);
      if (s.token === "ʔ") { tr.av.fill(0.3, a, closeEnd); creak.fill(1, a, closeEnd); continue; }
      if (s.kind === "affricate") {
        tr.af.fill(1, closeEnd, b);
        tr.fricCf.fill(s.fricCf, closeEnd, b); tr.fricBw.fill(s.fricBw, closeEnd, b);
      } else {
        const be = Math.min(b, closeEnd + burst);
        tr.af.fill(0.9, closeEnd, be);
        tr.fricCf.fill(s.burstCf, closeEnd, be); tr.fricBw.fill(2200, closeEnd, be);
        if (asp) tr.ah.fill(0.7, be, b);
      }
      if (s.voiced) voiced.fill(1, a, closeEnd);
    }
  }

  interpolate(tr, knots, n);
  f0Contour(tr, real, voiced, stressed, creak, n);
  return tr;
}

function interpolate(tr, knots, n) {
  if (!knots.length) return;
  knots.sort((p, q) => p[0] - q[0]);
  for (let j = 0; j < 3; j++) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k < knots.length - 2 && knots[k + 1][0] < i) k++;
      const [x0, ...v0] = knots[Math.min(k, knots.length - 1)];
      const [x1, ...v1] = knots[Math.min(k + 1, knots.length - 1)];
      const t = x1 > x0 ? Math.min(1, Math.max(0, (i - x0) / (x1 - x0))) : 0;
      tr.F[j][i] = v0[j] + (v1[j] - v0[j]) * t;
    }
  }
  for (let i = 0; i < n; i++) {
    tr.F[3][i] = Math.max(tr.F[2][i] + 750, 3200);
    tr.F[4][i] = Math.max(tr.F[3][i] + 900, 4300);
    tr.B[0][i] = 55 + 0.06 * tr.F[0][i];
    tr.B[1][i] = 70 + 0.04 * tr.F[1][i];
    tr.B[2][i] = 110 + 0.03 * tr.F[2][i];
    tr.B[3][i] = 200; tr.B[4][i] = 280;
  }
}

function f0Contour(tr, real, voiced, stressed, creak, n) {
  const f = real.features;
  const base = real.voice.f0;
  const span = Math.min(16, Math.max(1.5, f.f0_span));
  const st = new Float64Array(n);
  for (let i = 0; i < n; i++) st[i] = -0.35 * span * (i / Math.max(1, n - 1));

  let i = 0;
  while (i < n) {
    if (!stressed[i]) { i++; continue; }
    let j = i; while (j < n && stressed[j]) j++;
    for (let k = i; k < j; k++) st[k] += 0.45 * span * Math.sin(Math.PI * (k - i) / Math.max(1, j - i));
    i = j;
  }

  const tail = Math.max(1, Math.round(0.18 * n));
  const rising = f.final_rise >= 0.45;
  for (let k = 0; k < tail; k++) {
    const s = k / Math.max(1, tail - 1);
    st[n - tail + k] += (rising ? 0.75 : -0.55) * span * s;
  }

  for (let k = 0; k < n; k++) {
    const on = voiced[k] || creak[k];
    tr.f0[k] = on ? base * Math.pow(2, st[k] / 12) : 0;
    if (creak[k]) { tr.f0[k] *= 0.78; tr.av[k] = Math.min(tr.av[k], 0.3); }
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function resonator(freq, bw) {
  const fq = Math.min(SR / 2 - 120, Math.max(80, freq));
  const b = Math.min(1800, Math.max(20, bw));
  const r = Math.exp(-Math.PI * b / SR);
  const theta = 2 * Math.PI * fq / SR;
  const a1 = 2 * r * Math.cos(theta), a2 = -(r * r);
  return { gain: 1 - a1 - a2, a1, a2 };
}

/* Coefficients are held constant within a frame and the filter state carries
   across frame boundaries — the same compromise the Python makes, for the same
   reason (a per-sample IIR in a scripting language is unusably slow). */
function filterTrack(x, freqs, bws, n, hopN) {
  const out = new Float64Array(x.length);
  let y1 = 0, y2 = 0;
  for (let k = 0; k < n; k++) {
    const a = k * hopN, b = Math.min((k + 1) * hopN, x.length);
    if (a >= x.length) break;
    const { gain, a1, a2 } = resonator(freqs[k], bws[k]);
    for (let i = a; i < b; i++) {
      const y = gain * x[i] + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y; out[i] = y;
    }
  }
  return out;
}

export function render(tr) {
  const hopN = Math.round(HOP_S * SR);
  const total = Math.max(hopN, tr.n * hopN);
  const rnd = mulberry32(tr.seed + 1);

  const up = (v) => {
    const o = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      const idx = i / hopN, lo = Math.min(v.length - 1, Math.floor(idx));
      const hi = Math.min(v.length - 1, lo + 1), fr = idx - lo;
      o[i] = v[lo] * (1 - fr) + v[hi] * fr;
    }
    return o;
  };

  const f0 = up(tr.f0), av = up(tr.av), ah = up(tr.ah), af = up(tr.af), nas = up(tr.nasal);

  // Voicing: Rosenberg glottal *flow* pulses. Not the derivative — the single
  // differentiation in this chain is lip radiation, at the end. Doing both
  // strips the first formant and the result reads as noise, not voice.
  const src = new Float64Array(total + 512);
  let t = 0;
  while (t < total) {
    const fr = f0[t];
    if (fr < 40 || av[t] <= 1e-3) { t += hopN >> 2; continue; }
    let period = SR / fr;
    period *= 1 + 0.012 * gauss(rnd);
    const nP = Math.max(8, Math.round(period));
    const nOpen = Math.max(2, Math.round(0.4 * nP));
    const nClose = Math.max(2, Math.round(0.16 * nP));
    const amp = av[t] * (1 + 0.05 * gauss(rnd));
    for (let i = 0; i < nOpen; i++) src[t + i] += amp * 0.5 * (1 - Math.cos(Math.PI * i / nOpen));
    for (let i = 0; i < nClose; i++) {
      src[t + nOpen + i] += amp * Math.cos(Math.PI * i / (2 * nClose));
    }
    t += nP;
  }

  let x = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    x[i] = src[i] + 0.04 * av[i] * gauss(rnd) + ah[i] * gauss(rnd) * 0.5;
  }
  for (let j = 0; j < 5; j++) x = filterTrack(x, tr.F[j], tr.B[j], tr.n, hopN);

  // Frication runs parallel to the tract: the noise source for [s] sits at the
  // teeth, in front of most of the cavity that shapes vowels.
  const noise = new Float64Array(total);
  for (let i = 0; i < total; i++) noise[i] = gauss(rnd) * af[i];
  const fric = filterTrack(noise, tr.fricCf, tr.fricBw, tr.n, hopN);

  const out = new Float32Array(total);
  let prev = 0, peak = 0;
  for (let i = 0; i < total; i++) {
    const v = x[i] * (1 - 0.35 * nas[i]) + fric[i] * 0.55;
    const rad = v - prev;                       // lip radiation, +6 dB/octave
    prev = v;
    out[i] = rad;
    if (Math.abs(rad) > peak) peak = Math.abs(rad);
  }
  if (peak > 0) for (let i = 0; i < total; i++) out[i] = (0.85 * out[i]) / peak;

  const edge = Math.round(0.005 * SR);
  for (let i = 0; i < edge && i < total; i++) {
    const r = 0.5 * (1 - Math.cos((Math.PI * i) / edge));
    out[i] *= r; out[total - 1 - i] *= r;
  }
  return out;
}

export function synthesise(phraseId, features, voice = "male", seed = 0) {
  const phrase = PHRASES.find((p) => p.id === phraseId) || PHRASES[0];
  const real = realise(features, voice);
  const segs = timeSegments(segment(phrase, real), real);
  const track = buildTrack(segs, real, seed);
  const samples = render(track);

  const timeline = [];
  let pos = 0;
  for (const s of segs) {
    if (s.kind !== "pause") {
      timeline.push({ token: s.token, kind: s.kind, start: pos / 1000, dur: s.dur / 1000 });
    }
    pos += s.dur;
  }
  return { samples, track, timeline, notes: real.notes, phrase,
           duration: samples.length / SR, real };
}

export function toWav(samples, sr = SR) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
