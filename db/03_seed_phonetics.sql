-- Isogloss — universal phone set, languages, phonotactics.
--
-- Formant targets are adult-male reference values in the Peterson–Barney /
-- Hillenbrand tradition. The recogniser normalises the speaker's vocal tract
-- before comparing, so these are anchors, not thresholds.
-- Obstruent targets are spectral centre-of-gravity (Hz) and noise-likeness.
-- The noise-likeness column is calibrated against `dsp.spectral_flatness`
-- exactly: 0 is modal voice, ~0.5 a fricative, 1.0 white noise. Changing that
-- function means recalibrating this column, and vice versa.

-- --------------------------------------------------------------------------
-- Phones
-- --------------------------------------------------------------------------
INSERT INTO phone (ipa, arpa, manner, place, voiced, f1_hz, f2_hz, f3_hz, centroid_hz, flatness, typical_ms, sonority) VALUES
-- vowels ------------------------------------------------------------------
('i',  'IY', 'vowel', 'close-front',   true,  280, 2250, 2890, NULL, NULL, 110, 7),
('ɪ',  'IH', 'vowel', 'near-close',    true,  400, 1920, 2560, NULL, NULL,  75, 7),
('e',  'EY', 'vowel', 'close-mid-front',true, 460, 2100, 2650, NULL, NULL, 100, 7),
('ɛ',  'EH', 'vowel', 'open-mid-front',true,  550, 1770, 2490, NULL, NULL,  85, 7),
('æ',  'AE', 'vowel', 'near-open-front',true, 690, 1660, 2450, NULL, NULL, 120, 7),
('a',  'AA', 'vowel', 'open-front',    true,  750, 1400, 2500, NULL, NULL, 110, 7),
('ɑ',  'AH', 'vowel', 'open-back',     true,  710, 1100, 2540, NULL, NULL, 120, 7),
('ɒ',  'AO', 'vowel', 'open-back-rnd', true,  650,  950, 2480, NULL, NULL, 105, 7),
('ɔ',  'AO', 'vowel', 'open-mid-back', true,  570,  840, 2410, NULL, NULL, 110, 7),
('o',  'OW', 'vowel', 'close-mid-back',true,  480,  900, 2400, NULL, NULL, 100, 7),
('ʊ',  'UH', 'vowel', 'near-close-back',true, 450, 1030, 2380, NULL, NULL,  70, 7),
('u',  'UW', 'vowel', 'close-back',    true,  310,  870, 2250, NULL, NULL, 100, 7),
('ʌ',  'AH', 'vowel', 'open-mid-back', true,  620, 1200, 2550, NULL, NULL,  75, 7),
('ə',  'AX', 'vowel', 'mid-central',   true,  500, 1500, 2500, NULL, NULL,  55, 7),
('ɜ',  'ER', 'vowel', 'open-mid-centr',true,  500, 1450, 2400, NULL, NULL, 120, 7),
('ɝ',  'ER', 'vowel', 'rhotic-central',true,  490, 1350, 1690, NULL, NULL, 130, 7),
('y',  'UY', 'vowel', 'close-front-rnd',true, 300, 1750, 2200, NULL, NULL, 100, 7),
('ø',  'OE', 'vowel', 'close-mid-f-rnd',true, 400, 1550, 2200, NULL, NULL, 100, 7),
('œ',  'OE', 'vowel', 'open-mid-f-rnd',true,  550, 1500, 2200, NULL, NULL,  90, 7),
('ɯ',  'UU', 'vowel', 'close-back-unr',true,  300, 1200, 2200, NULL, NULL,  95, 7),
-- approximants -------------------------------------------------------------
('ɹ',  'R',  'approximant', 'alveolar', true, 320, 1000, 1600, NULL, NULL,  70, 6),
('l',  'L',  'approximant', 'lateral',  true, 360, 1300, 2700, NULL, NULL,  70, 6),
('ɫ',  'L',  'approximant', 'velarised',true, 400,  800, 2600, NULL, NULL,  80, 6),
('w',  'W',  'approximant', 'labiovelar',true,300,  610, 2200, NULL, NULL,  60, 6),
('j',  'Y',  'approximant', 'palatal',  true, 260, 2070, 3000, NULL, NULL,  55, 6),
('ɾ',  'DX', 'approximant', 'tap',      true, 400, 1500, 2500, NULL, NULL,  25, 5),
('r',  'RR', 'approximant', 'trill',    true, 400, 1400, 2400, NULL, NULL,  60, 5),
('ʁ',  'RH', 'approximant', 'uvular',   true, 450,  950, 2200, NULL, NULL,  65, 5),
-- nasals -------------------------------------------------------------------
('m',  'M',  'nasal', 'bilabial',  true, 250, 1100, 2200, NULL, NULL, 70, 4),
('n',  'N',  'nasal', 'alveolar',  true, 250, 1500, 2500, NULL, NULL, 65, 4),
('ŋ',  'NG', 'nasal', 'velar',     true, 250, 2000, 2600, NULL, NULL, 75, 4),
('ɲ',  'NY', 'nasal', 'palatal',   true, 260, 1900, 2700, NULL, NULL, 70, 4),
-- fricatives ---------------------------------------------------------------
('s', 'S', 'fricative', 'alveolar', false, NULL, NULL, NULL, 6600, 0.45, 100, 1),
('z', 'Z', 'fricative', 'alveolar', true, NULL, NULL, NULL, 5900, 0.38, 80, 1),
('ʃ', 'SH', 'fricative', 'postalveolar', false, NULL, NULL, NULL, 3700, 0.60, 110, 1),
('ʒ', 'ZH', 'fricative', 'postalveolar', true, NULL, NULL, NULL, 3400, 0.50, 85, 1),
('f', 'F', 'fricative', 'labiodental', false, NULL, NULL, NULL, 5400, 0.55, 95, 1),
('v', 'V', 'fricative', 'labiodental', true, NULL, NULL, NULL, 4600, 0.45, 70, 1),
('θ', 'TH', 'fricative', 'dental', false, NULL, NULL, NULL, 5800, 0.58, 95, 1),
('ð', 'DH', 'fricative', 'dental', true, NULL, NULL, NULL, 4200, 0.45, 55, 1),
('x', 'X', 'fricative', 'velar', false, NULL, NULL, NULL, 2300, 0.42, 95, 1),
('ç', 'CC', 'fricative', 'palatal', false, NULL, NULL, NULL, 4300, 0.50, 90, 1),
('h', 'HH', 'fricative', 'glottal', false, NULL, NULL, NULL, 1600, 0.34, 60, 2),
('β', 'BB', 'fricative', 'bilabial', true, NULL, NULL, NULL, 1800, 0.30, 60, 1),
-- affricates ---------------------------------------------------------------
('tʃ', 'CH', 'affricate', 'postalveolar', false, NULL, NULL, NULL, 3900, 0.55, 120, 0),
('dʒ', 'JH', 'affricate', 'postalveolar', true, NULL, NULL, NULL, 3300, 0.45, 100, 0),
('ts', 'TS', 'affricate', 'alveolar', false, NULL, NULL, NULL, 6200, 0.48, 110, 0),
-- stops --------------------------------------------------------------------
('p', 'P', 'stop', 'bilabial', false, NULL, NULL, NULL, 1100, 0.35, 85, 0),
('b', 'B', 'stop', 'bilabial', true, NULL, NULL, NULL, 900, 0.30, 70, 0),
('t', 'T', 'stop', 'alveolar', false, NULL, NULL, NULL, 4200, 0.45, 85, 0),
('d', 'D', 'stop', 'alveolar', true, NULL, NULL, NULL, 3400, 0.38, 65, 0),
('k', 'K', 'stop', 'velar', false, NULL, NULL, NULL, 2100, 0.40, 90, 0),
('g', 'G', 'stop', 'velar', true, NULL, NULL, NULL, 1800, 0.34, 70, 0),
('ʔ', 'Q', 'stop', 'glottal', false, NULL, NULL, NULL, 700, 0.20, 45, 0),
('sil', 'SIL', 'silence', NULL, false, NULL, NULL, NULL, 200, 0.15, 90, 0);

-- --------------------------------------------------------------------------
-- Languages
-- --------------------------------------------------------------------------
-- Rhythm-metric means follow the Ramus / Grabe & Low tradition: stress-timed
-- languages sit high on nPVI_V, syllable-timed low, mora-timed low with a very
-- small ΔC. These three numbers alone separate the big rhythm classes.

INSERT INTO language (code, name, family, rhythm_class, npvi_v_mean, pct_v_mean, delta_c_mean,
                      vowel_inventory, cv_strictness, cluster_tol, speakers_m, notes) VALUES
('en', 'English',    'Germanic',   'stress',   65, 40.0, 53, 12, 0.45, 0.85, 1450, 'Heavy reduction; large vowel system'),
('de', 'German',     'Germanic',   'stress',   59, 41.0, 55, 15, 0.40, 0.90,  135, 'Front rounded vowels; final devoicing'),
('nl', 'Dutch',      'Germanic',   'stress',   61, 41.5, 54, 14, 0.42, 0.88,   25, 'Velar fricative; diphthong-rich'),
('sv', 'Swedish',    'Germanic',   'stress',   57, 43.0, 50, 17, 0.48, 0.80,   13, 'Pitch accent; long/short contrast'),
('es', 'Spanish',    'Romance',    'syllable', 30, 44.0, 38,  5, 0.78, 0.30,  560, 'Five vowels; simple onsets'),
('it', 'Italian',    'Romance',    'syllable', 35, 46.0, 40,  7, 0.75, 0.35,   67, 'Geminates; open syllables'),
('pt', 'Portuguese', 'Romance',    'mixed',    47, 41.0, 47, 12, 0.55, 0.55,  260, 'Nasal vowels; heavy reduction (EP)'),
('fr', 'French',     'Romance',    'syllable', 34, 45.0, 44, 15, 0.62, 0.55,  310, 'Nasal + front rounded vowels; final stress'),
('ro', 'Romanian',   'Romance',    'mixed',    45, 42.0, 46,  7, 0.58, 0.60,   24, 'Central vowels; Slavic contact'),
('ru', 'Russian',    'Slavic',     'stress',   52, 39.0, 60,  6, 0.35, 0.95,  255, 'Palatalisation; heavy clusters'),
('pl', 'Polish',     'Slavic',     'stress',   48, 38.0, 62,  6, 0.32, 0.97,   45, 'Very heavy clusters; sibilant-rich'),
('el', 'Greek',      'Hellenic',   'syllable', 40, 45.0, 43,  5, 0.68, 0.45,   13, 'Five vowels; dental fricatives'),
('tr', 'Turkish',    'Turkic',     'syllable', 42, 44.0, 41,  8, 0.72, 0.35,   88, 'Vowel harmony; agglutinative'),
('ar', 'Arabic',     'Semitic',    'stress',   55, 38.0, 57,  6, 0.55, 0.60,  400, 'Pharyngeals; emphatic consonants'),
('he', 'Hebrew',     'Semitic',    'stress',   50, 41.0, 52,  5, 0.58, 0.62,    9, 'Uvular rhotic; five vowels'),
('hi', 'Hindi',      'Indo-Aryan', 'syllable', 44, 43.0, 45, 11, 0.65, 0.50,  600, 'Retroflex series; aspiration contrast'),
('ja', 'Japanese',   'Japonic',    'mora',     41, 47.0, 33,  5, 0.92, 0.10,  125, 'Strict CV; mora timing'),
('ko', 'Korean',     'Koreanic',   'syllable', 45, 43.0, 44,  8, 0.70, 0.35,   80, 'Three-way stop laryngeal contrast'),
('zh', 'Mandarin',   'Sinitic',    'syllable', 38, 46.0, 36,  6, 0.85, 0.15, 1100, 'Tonal; very restricted codas'),
('vi', 'Vietnamese', 'Austroasiatic','syllable',36, 47.0, 34, 11, 0.88, 0.12,   85, 'Tonal; monosyllabic');

-- --------------------------------------------------------------------------
-- Phone inventories
-- --------------------------------------------------------------------------
-- Three frequency bands instead of a measured unigram distribution. The band
-- boundaries matter far less than presence/absence: a confident [θ] all but
-- excludes Spanish outside Castile, and that is what does the work.

CREATE OR REPLACE FUNCTION iso_seed_inventory(p_lang text, common text[], mid text[], rare text[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO language_phone (language, ipa, freq)
  SELECT p_lang, ipa, freq FROM (
      SELECT unnest(common) AS ipa, 0.055::real AS freq
      UNION ALL SELECT unnest(mid),  0.022
      UNION ALL SELECT unnest(rare), 0.006
  ) s
  WHERE EXISTS (SELECT 1 FROM phone WHERE phone.ipa = s.ipa)
  ON CONFLICT (language, ipa) DO NOTHING;
$$;

SELECT iso_seed_inventory('en',
  ARRAY['ə','ɪ','n','t','s','ɹ','l','d','k','m','i','ɛ','æ','ʌ','ʊ','u','ɑ','w','h','b','p','f','v','ð','z','g'],
  ARRAY['ŋ','ʃ','tʃ','dʒ','j','θ','ɔ','o','e','ɝ','ɫ','ʔ'],
  ARRAY['ʒ','ɒ','ɜ','ɾ']);
SELECT iso_seed_inventory('de',
  ARRAY['ə','n','t','s','ɛ','a','ɪ','l','d','m','k','ʁ','i','u','o','ʊ','f','v','z','h','b','p','g'],
  ARRAY['ç','x','ʃ','ts','y','ø','œ','ŋ','j'],
  ARRAY['dʒ','ʒ','r']);
SELECT iso_seed_inventory('nl',
  ARRAY['ə','n','t','s','ɛ','a','ɪ','l','d','m','k','i','u','o','ʊ','f','v','z','h','b','p','g','ɹ'],
  ARRAY['x','ʃ','y','ø','œ','ŋ','j','ç'],
  ARRAY['ʒ','ts']);
SELECT iso_seed_inventory('sv',
  ARRAY['ə','n','t','s','ɛ','a','ɪ','l','d','m','k','i','u','o','ʊ','f','v','h','b','p','g','r'],
  ARRAY['ʃ','y','ø','œ','ŋ','j','ç','ɯ'],
  ARRAY['z','ʒ','x']);
SELECT iso_seed_inventory('es',
  ARRAY['a','e','i','o','u','s','n','ɾ','l','t','k','d','m','p','β','b'],
  ARRAY['x','ɲ','tʃ','g','f','r','j','w'],
  ARRAY['θ','ʃ','ʒ','z']);
SELECT iso_seed_inventory('it',
  ARRAY['a','e','i','o','u','n','t','s','l','ɾ','k','d','m','p','ɛ','ɔ'],
  ARRAY['tʃ','dʒ','ʃ','ɲ','ts','v','f','g','b','r','j','w'],
  ARRAY['z','ʒ','h']);
SELECT iso_seed_inventory('pt',
  ARRAY['a','e','i','o','u','s','n','ɾ','l','t','k','d','m','p','ə','ɛ','ɔ','ʃ'],
  ARRAY['ʒ','ɲ','v','f','g','b','ɫ','j','w','ʁ'],
  ARRAY['tʃ','θ','x']);
SELECT iso_seed_inventory('fr',
  ARRAY['a','e','i','o','u','ə','ɛ','ɔ','s','n','l','t','k','d','m','p','ʁ','v','z'],
  ARRAY['y','ø','œ','ʃ','ʒ','f','g','b','j','w','ɲ'],
  ARRAY['ŋ','tʃ','h']);
SELECT iso_seed_inventory('ro',
  ARRAY['a','e','i','o','u','ə','s','n','ɾ','l','t','k','d','m','p','ɯ'],
  ARRAY['ts','tʃ','dʒ','ʃ','ʒ','v','f','g','b','j','w'],
  ARRAY['θ','x','ɲ']);
SELECT iso_seed_inventory('ru',
  ARRAY['a','i','o','u','ɛ','s','n','t','ɾ','l','d','k','m','p','v','ɫ','j','ɯ'],
  ARRAY['ʃ','ʒ','x','ts','tʃ','z','f','g','b','ɲ','r'],
  ARRAY['θ','h','w']);
SELECT iso_seed_inventory('pl',
  ARRAY['a','ɛ','i','o','u','s','n','t','ɾ','l','d','k','m','p','v','j','ts','ʃ'],
  ARRAY['ʒ','x','tʃ','z','f','g','b','ɲ','ɯ','r'],
  ARRAY['θ','h','w','ŋ']);
SELECT iso_seed_inventory('el',
  ARRAY['a','e','i','o','u','s','n','t','ɾ','l','d','k','m','p','θ','ð','x','ç'],
  ARRAY['v','f','g','z','ɲ','j','β'],
  ARRAY['ʃ','ʒ','tʃ','ŋ']);
SELECT iso_seed_inventory('tr',
  ARRAY['a','e','i','o','u','ɯ','y','ø','s','n','t','ɾ','l','d','k','m','p','ʃ'],
  ARRAY['tʃ','dʒ','z','v','f','g','b','j','h'],
  ARRAY['θ','ð','x','ŋ']);
SELECT iso_seed_inventory('ar',
  ARRAY['a','i','u','s','n','t','ɾ','l','d','k','m','b','h','ʃ','ʁ','ħ' ],
  ARRAY['θ','ð','x','ç','f','dʒ','z','ʔ','w','j','ts'],
  ARRAY['p','g','v','tʃ','ŋ']);
SELECT iso_seed_inventory('he',
  ARRAY['a','e','i','o','u','s','n','t','l','d','k','m','b','ʁ','ʃ','v','f'],
  ARRAY['x','z','ts','h','ʔ','j','g','p'],
  ARRAY['θ','ð','w','ŋ','tʃ']);
SELECT iso_seed_inventory('hi',
  ARRAY['a','ə','i','o','u','ɛ','ɾ','n','t','k','d','m','s','l','b','p','g','h'],
  ARRAY['ʃ','tʃ','dʒ','ɲ','ŋ','j','v','ʈ' ,'ɖ'],
  ARRAY['θ','ð','z','f','x','w']);
SELECT iso_seed_inventory('ja',
  ARRAY['a','i','u','e','o','k','s','t','n','m','ɾ','ɯ','d','g','h'],
  ARRAY['ʃ','tʃ','dʒ','ts','j','w','b','p','z','ɲ'],
  ARRAY['θ','ð','v','f','l','ŋ','ʔ']);
SELECT iso_seed_inventory('ko',
  ARRAY['a','ʌ','i','o','u','ɯ','n','k','t','s','m','ɾ','l','p','h','ə'],
  ARRAY['tʃ','ʃ','ŋ','j','w','b','d','g'],
  ARRAY['θ','ð','v','f','z','ʒ']);
SELECT iso_seed_inventory('zh',
  ARRAY['a','i','u','ə','o','ɯ','n','ŋ','ʃ','ts','tʃ','t','k','m','l','s','x'],
  ARRAY['f','p','h','j','w','ʂ'],
  ARRAY['θ','ð','v','z','ʒ','g','b','d','ɾ']);
SELECT iso_seed_inventory('vi',
  ARRAY['a','i','u','ə','o','ɛ','ɔ','ɯ','n','ŋ','t','k','m','l','s','ɲ','h'],
  ARRAY['f','p','j','w','ts','x','ɓ','d'],
  ARRAY['θ','ð','v','z','ʒ','g','ɹ','ʃ']);

-- --------------------------------------------------------------------------
-- Phonotactic exceptions
-- --------------------------------------------------------------------------
-- The bulk of the bigram model is generated from cv_strictness/cluster_tol at
-- query time (see app/langid.py). This table holds only the transitions worth
-- naming individually — the ones that are genuinely diagnostic.

INSERT INTO language_bigram (language, prev, next, logp) VALUES
-- English: /ð/ initial in function words is extremely frequent, and near-unique.
('en', '^', 'ð',  -1.6),
('en', 'ŋ', '$',  -1.9),
('en', 'ə', '$',  -1.7),
-- German/Dutch: final devoicing means voiced obstruents essentially never end an utterance.
('de', 'd', '$',  -6.5), ('de', 'g', '$', -6.5), ('de', 'v', '$', -6.5),
('nl', 'd', '$',  -6.5), ('nl', 'g', '$', -6.5), ('nl', 'v', '$', -6.5),
('de', '^', 'ʃ',  -1.9), ('de', 'ʃ', 't', -1.8), ('de', 'ʃ', 'p', -2.2),
-- Spanish/Italian: onset /s/+stop is repaired by prothesis, so it barely occurs.
('es', '^', 's',  -4.5), ('it', '^', 's', -3.5),
('es', 'ɾ', '$',  -2.0), ('es', 'a', '$', -1.5), ('es', 'o', '$', -1.5),
-- French: final stress and a strong preference for open final syllables.
('fr', 'ə', '$',  -3.5), ('fr', 'ʁ', '$', -2.2), ('fr', '^', 'ʁ', -2.4),
-- Japanese: only /n/ and long vowels close a syllable.
('ja', 'n', '$',  -1.4), ('ja', 't', '$', -7.0), ('ja', 'k', '$', -7.0),
('ja', 's', 't',  -6.0), ('ja', 'k', 't', -6.0),
-- Mandarin: codas are limited to nasals.
('zh', 'ŋ', '$',  -1.3), ('zh', 'n', '$', -1.3), ('zh', 't', '$', -6.5),
('zh', 's', 't',  -5.5),
-- Slavic: clusters that would be illegal almost anywhere else.
('pl', '^', 'ʃ',  -1.7), ('pl', 'ʃ', 'tʃ', -2.0), ('pl', '^', 'ts', -2.2),
('ru', '^', 'v',  -1.9), ('ru', 'ɫ', '$', -2.4),
-- Arabic: definite article assimilation makes utterance-initial /ʔa/ common.
('ar', '^', 'ʔ',  -1.8), ('ar', 'l', 'ʃ', -2.4);
