-- Isogloss — the accent field: measurable dimensions and reference varieties.
--
-- HONESTY NOTE. These values are expert approximations synthesised from the
-- descriptive literature (Wells 1982 lexical sets; the Atlas of North American
-- English; the Survey of English Dialects; the rhythm-metric literature). They
-- are NOT measurements from a corpus. They are internally consistent and they
-- reproduce the well-known isoglosses, which is enough to exercise the model —
-- but a production deployment replaces this file with real survey data and
-- changes nothing else.

-- --------------------------------------------------------------------------
-- The dimensions
-- --------------------------------------------------------------------------
-- `lo`/`hi` are the scale the DSP reports on, so measured and reference values
-- are commensurate by construction. `nugget` is τ² from docs/DIFFUSION.md §5,
-- expressed on the normalised [0,1] scale: how much two speakers from the same
-- village differ. Features with a big nugget are weak evidence and the
-- posterior treats them that way.

INSERT INTO accent_feature (key, label, unit, lo, hi, nugget, is_variant, description) VALUES
('rhoticity',      'Rhoticity',              'index',    0,    1,   0.10, true,
  'Constriction of postvocalic /r/, measured as F3 lowering in vowel codas. The single most informative English feature — and the first casualty of narrowband audio.'),
('npvi_v',         'Vocalic nPVI',           'index',   20,   80,   0.14, false,
  'Normalised pairwise variability of successive vowel durations. High = stress-timed with reduction; low = syllable- or mora-timed.'),
('pct_v',          'Proportion vocalic',     '%',       33,   55,   0.16, false,
  'Share of speech that is vocalic. Rises as syllable structure simplifies.'),
('delta_c',        'Consonantal variability','ms',      25,   80,   0.16, false,
  'Standard deviation of consonantal interval durations. High = complex clusters.'),
('vowel_area',     'Vowel space area',       'index',  0.4,  1.4,   0.15, false,
  'Convex hull area of the speaker''s vowel distribution in Lobanov-normalised F1/F2. Large systems disperse further.'),
('goose_f2',       'GOOSE fronting',         'index',    0,    1,   0.14, false,
  'Normalised F2 of the high back vowel. A change in progress across most of the anglophone world, which makes it a clock as much as a place-marker.'),
('trap_bath',      'TRAP–BATH separation',   'index',    0,    1,   0.12, true,
  'Distance between the front-low and back-low vowel classes. The classic north/south English isogloss.'),
('low_back_merge', 'LOT–THOUGHT merger',     'index',    0,    1,   0.12, true,
  'Proximity of the two low back vowels; 1 = fully merged. Sharpest single divider of North American varieties.'),
('diph_index',     'Diphthongisation',       'index',    0,    1,   0.13, false,
  'Mean formant-trajectory length of long vowels. Low = Southern US or Yorkshire monophthongs; high = broad Australian or Cockney glides.'),
('vot_ms',         'Voiceless stop VOT',     'ms',      10,  110,   0.18, false,
  'Aspiration of voiceless stops. Separates Germanic from Romance and Scottish from Southern English.'),
('f0_span',        'Intonational span',      'st',       2,   14,   0.20, false,
  'Semitone range of the pitch contour. Wide in Belfast, Cork, Tyneside and Liverpool; narrow in most of the US.'),
('final_rise',     'Phrase-final rise',      'index',    0,    1,   0.18, false,
  'Share of declaratives ending on a rise. Belfast/Cork rises and Australasian/Californian uptalk are different histories with the same acoustics — which is why this feature alone never localises.'),
('t_glottal',      'T-glottalling',          'index',    0,    1,   0.15, true,
  'Glottal replacement of /t/. A textbook cascade-diffusion variable: urban first, rural after.'),
('th_shift',       'TH non-dental',          'index',    0,    1,   0.15, true,
  'Realisation of /θ ð/ as anything but dental fricatives — fronting to [f v] in England, stopping to [t d] in Ireland and New York. Deliberately conflated: the acoustics separate them poorly and the geography separates them well.');

-- --------------------------------------------------------------------------
-- Reference varieties
-- --------------------------------------------------------------------------
-- NULL means "this dimension is not defined for this variety". Non-English
-- sites carry only the language-general dimensions; the TRAP–BATH split is not
-- a thing you can have an opinion about in Polish. The long-form site_feature
-- table drops the NULLs, and the Gaussian process simply conditions on fewer
-- dimensions there. Nothing else in the pipeline needs to know.

CREATE TEMP TABLE seed_site (
  id text, label text, lang text, country text, settlement text,
  lon double precision, lat double precision, conf real,
  rhoticity real, npvi_v real, pct_v real, delta_c real, vowel_area real,
  goose_f2 real, trap_bath real, low_back_merge real, diph_index real,
  vot_ms real, f0_span real, final_rise real, t_glottal real, th_shift real
);

INSERT INTO seed_site VALUES
-- ---- England: south -------------------------------------------------------
('rp','Standard Southern British','en','GB','london',-0.30,51.45,0.90, 0.05,68,40,53,1.15,0.65,0.90,0.05,0.75,65,7.0,0.20,0.35,0.15),
('cockney','Cockney / East London','en','GB','london',0.05,51.53,0.85, 0.03,70,39,55,1.30,0.80,0.95,0.05,0.95,60,7.5,0.25,0.90,0.85),
('mle','Multicultural London English','en','GB','london',-0.10,51.56,0.70, 0.05,62,41,54,1.20,0.85,0.90,0.08,0.50,62,8.0,0.40,0.80,0.80),
('estuary','Estuary (Essex & Kent)','en','GB',NULL,0.55,51.45,0.75, 0.04,68,40,54,1.20,0.72,0.92,0.05,0.85,62,7.2,0.25,0.70,0.55),
('brighton','Sussex coastal','en','GB','brighton',-0.14,50.82,0.70, 0.06,67,40,53,1.15,0.68,0.90,0.06,0.80,63,7.0,0.25,0.60,0.45),
('southampton','Hampshire','en','GB','southampton',-1.40,50.90,0.70, 0.15,66,40,53,1.10,0.60,0.85,0.08,0.78,64,7.0,0.22,0.50,0.40),
('bristol','Bristol & the West Country','en','GB','bristol',-2.59,51.45,0.80, 0.55,64,41,52,1.05,0.50,0.90,0.10,0.70,66,7.5,0.20,0.30,0.40),
('exeter','Exeter','en','GB','exeter',-3.53,50.72,0.70, 0.50,63,41,52,1.02,0.48,0.88,0.10,0.70,66,7.6,0.20,0.28,0.38),
('plymouth','Devon','en','GB','plymouth',-4.14,50.38,0.75, 0.60,63,41,51,1.00,0.45,0.88,0.12,0.68,67,7.8,0.20,0.25,0.35),
('norwich','Norwich & East Anglia','en','GB','norwich',1.30,52.63,0.80, 0.05,66,40,53,1.20,0.90,0.85,0.06,0.70,63,7.2,0.20,0.70,0.60),
('miltonkeynes','Milton Keynes (new town)','en','GB','miltonkeynes',-0.76,52.04,0.65, 0.05,67,40,54,1.15,0.72,0.75,0.06,0.80,63,7.1,0.30,0.70,0.60),
-- ---- England: the TRAP–BATH transition zone -------------------------------
('lincoln','Lincolnshire','en','GB','lincoln',-0.54,53.23,0.60, 0.05,65,40,53,1.05,0.55,0.30,0.12,0.60,64,7.4,0.20,0.45,0.45),
('nottingham','East Midlands','en','GB','nottingham',-1.15,52.95,0.75, 0.05,65,40,53,1.05,0.58,0.35,0.12,0.62,64,7.5,0.22,0.50,0.50),
('birmingham','Birmingham & the Black Country','en','GB','birmingham',-1.90,52.48,0.85, 0.05,66,40,54,1.10,0.55,0.15,0.10,0.90,64,8.0,0.25,0.40,0.45),
('stoke','The Potteries','en','GB','stoke',-2.18,53.00,0.65, 0.05,64,40,53,1.00,0.50,0.10,0.12,0.70,64,7.6,0.20,0.40,0.45),
-- ---- England: north -------------------------------------------------------
('manchester','Manchester','en','GB','manchester',-2.24,53.48,0.85, 0.05,65,40,53,0.95,0.70,0.10,0.12,0.65,64,7.8,0.25,0.60,0.60),
('liverpool','Scouse','en','GB','liverpool',-2.99,53.41,0.90, 0.05,63,40,55,0.95,0.62,0.10,0.15,0.60,75,9.5,0.30,0.15,0.50),
('leeds','West Yorkshire','en','GB','leeds',-1.55,53.80,0.85, 0.05,64,40,53,0.95,0.30,0.05,0.15,0.45,63,7.4,0.20,0.50,0.50),
('sheffield','South Yorkshire','en','GB','sheffield',-1.47,53.38,0.75, 0.05,64,40,53,0.95,0.35,0.05,0.15,0.48,63,7.4,0.20,0.50,0.50),
('hull','Hull','en','GB','hull',-0.34,53.74,0.70, 0.05,64,40,53,1.00,0.55,0.05,0.14,0.50,63,7.4,0.20,0.55,0.50),
('newcastle','Geordie','en','GB','newcastle',-1.61,54.98,0.90, 0.05,62,41,54,1.00,0.35,0.05,0.15,0.50,64,11.0,0.55,0.60,0.35),
('carlisle','Cumbria','en','GB','carlisle',-2.94,54.89,0.65, 0.15,63,41,53,0.95,0.35,0.05,0.18,0.50,63,8.0,0.25,0.40,0.35),
-- ---- Wales ---------------------------------------------------------------
('cardiff','Cardiff','en','GB','cardiff',-3.18,51.48,0.80, 0.05,60,42,51,0.90,0.55,0.50,0.10,0.60,64,9.0,0.30,0.35,0.35),
('swansea','South Wales valleys','en','GB','swansea',-3.94,51.62,0.75, 0.05,55,43,49,0.90,0.50,0.40,0.10,0.58,64,10.5,0.40,0.30,0.30),
-- ---- Scotland ------------------------------------------------------------
('glasgow','Glasgow','en','GB','glasgow',-4.25,55.86,0.90, 0.45,60,41,54,0.70,0.55,0.05,0.95,0.45,45,8.5,0.30,0.90,0.60),
('edinburgh','Edinburgh','en','GB','edinburgh',-3.19,55.95,0.85, 0.60,60,41,53,0.72,0.50,0.05,0.95,0.45,45,8.0,0.25,0.70,0.35),
('aberdeen','North East Scots (Doric)','en','GB','aberdeen',-2.09,57.15,0.80, 0.80,58,41,53,0.70,0.40,0.05,0.95,0.40,44,8.0,0.25,0.40,0.15),
('inverness','Highland English','en','GB','inverness',-4.22,57.48,0.70, 0.70,52,44,47,0.75,0.45,0.08,0.90,0.45,46,9.0,0.30,0.35,0.15),
-- ---- Ireland -------------------------------------------------------------
('belfast','Belfast','en','GB','belfast',-5.93,54.60,0.85, 0.65,60,41,53,0.90,0.55,0.10,0.50,0.80,50,11.0,0.70,0.20,0.30),
('dublin','Dublin','en','IE','dublin',-6.26,53.35,0.85, 0.70,58,42,51,0.95,0.60,0.20,0.35,0.70,55,8.5,0.35,0.35,0.75),
('limerick','Limerick','en','IE','limerick',-8.62,52.66,0.70, 0.75,54,43,48,0.92,0.52,0.20,0.42,0.70,55,10.5,0.45,0.28,0.80),
('cork','Cork','en','IE','cork',-8.47,51.90,0.80, 0.75,55,43,49,0.95,0.55,0.20,0.40,0.72,55,12.0,0.50,0.30,0.80),
('galway','West of Ireland','en','IE','galway',-9.05,53.27,0.75, 0.80,52,44,47,0.90,0.50,0.20,0.45,0.70,55,10.0,0.45,0.25,0.85),
-- ---- US: Northeast -------------------------------------------------------
('nyc','New York City','en','US','new_york',-73.98,40.75,0.90, 0.45,66,40,54,1.15,0.45,0.70,0.10,0.80,70,7.0,0.25,0.35,0.50),
('boston','Eastern New England','en','US','boston',-71.06,42.36,0.85, 0.35,66,40,53,1.05,0.30,0.60,0.90,0.70,68,7.0,0.25,0.30,0.30),
('bangor_me','Maine','en','US','bangor_me',-68.78,44.80,0.65, 0.60,65,40,53,1.02,0.35,0.55,0.90,0.65,67,7.2,0.25,0.30,0.25),
('philadelphia','Philadelphia','en','US','philadelphia',-75.16,39.95,0.85, 0.95,66,40,53,1.10,0.80,0.75,0.15,0.75,68,7.0,0.25,0.30,0.30),
('pittsburgh','Pittsburgh','en','US','pittsburgh',-79.99,40.44,0.80, 0.95,65,40,53,1.05,0.75,0.45,0.95,0.50,68,7.5,0.25,0.35,0.25),
-- ---- US: Inland North (the Northern Cities Shift) -------------------------
('chicago','Inland North (Chicago)','en','US','chicago',-87.63,41.88,0.85, 0.95,67,40,53,1.15,0.35,0.85,0.10,0.80,68,7.2,0.25,0.25,0.25),
('detroit','Inland North (Detroit)','en','US','detroit',-83.05,42.33,0.80, 0.95,67,40,53,1.15,0.35,0.90,0.10,0.80,68,7.2,0.25,0.25,0.25),
('cleveland','Inland North (Cleveland)','en','US','cleveland',-81.69,41.50,0.75, 0.95,66,40,53,1.12,0.38,0.85,0.15,0.78,68,7.2,0.25,0.25,0.25),
('buffalo','Inland North (Buffalo)','en','US','buffalo',-78.88,42.89,0.80, 0.95,67,40,53,1.18,0.35,0.95,0.10,0.80,68,7.2,0.25,0.25,0.25),
('minneapolis','Upper Midwest','en','US','minneapolis',-93.27,44.98,0.80, 0.95,62,41,51,1.00,0.40,0.50,0.60,0.45,66,7.0,0.30,0.25,0.20),
-- ---- US: Midland ---------------------------------------------------------
('st_louis','St. Louis corridor','en','US','st_louis',-90.20,38.63,0.70, 0.95,65,40,52,1.05,0.45,0.60,0.50,0.70,67,7.2,0.25,0.25,0.25),
('cincinnati','Midland (Cincinnati)','en','US','cincinnati',-84.51,39.10,0.75, 0.95,65,40,52,1.05,0.55,0.45,0.45,0.70,67,7.2,0.25,0.25,0.25),
-- ---- US: South -----------------------------------------------------------
('richmond','Virginia Piedmont','en','US','richmond',-77.44,37.54,0.75, 0.75,64,41,52,1.05,0.60,0.55,0.50,0.35,66,8.0,0.28,0.25,0.25),
('asheville','Appalachian','en','US','asheville',-82.55,35.60,0.80, 0.98,60,42,50,1.00,0.55,0.50,0.75,0.15,66,8.5,0.25,0.20,0.30),
('nashville','Upper South','en','US','nashville',-86.78,36.16,0.80, 0.90,63,41,51,1.05,0.60,0.50,0.60,0.25,66,9.0,0.30,0.25,0.25),
('memphis','Mid-South','en','US','memphis',-90.05,35.15,0.75, 0.88,63,41,51,1.05,0.62,0.50,0.60,0.20,66,9.0,0.30,0.25,0.30),
('atlanta','Atlanta & the Deep South','en','US','atlanta',-84.39,33.75,0.80, 0.90,63,41,51,1.05,0.65,0.50,0.65,0.30,66,9.0,0.30,0.25,0.25),
('charleston_sc','Lowcountry','en','US','charleston_sc',-79.93,32.78,0.70, 0.60,62,41,51,1.02,0.55,0.50,0.50,0.40,66,8.5,0.28,0.25,0.30),
('ocracoke','Ocracoke Brogue','en','US','ocracoke',-75.98,35.11,0.70, 0.90,62,41,51,1.05,0.50,0.55,0.60,0.85,66,8.0,0.25,0.25,0.30),
('new_orleans','New Orleans (Yat)','en','US','new_orleans',-90.07,29.95,0.75, 0.50,65,40,54,1.10,0.50,0.60,0.30,0.55,68,7.5,0.28,0.30,0.55),
('houston','Texas (Houston)','en','US','houston',-95.37,29.76,0.80, 0.92,63,41,51,1.05,0.70,0.50,0.85,0.30,67,8.0,0.28,0.25,0.20),
('dallas','Texas (Dallas)','en','US','dallas',-96.80,32.78,0.80, 0.92,63,41,51,1.05,0.70,0.50,0.85,0.30,67,8.0,0.28,0.25,0.20),
('miami','Miami English','en','US','miami',-80.19,25.77,0.70, 0.90,55,43,47,1.00,0.60,0.50,0.70,0.55,62,7.5,0.30,0.25,0.30),
-- ---- US: West ------------------------------------------------------------
('denver','Western (Denver)','en','US','denver',-104.99,39.74,0.80, 0.95,65,40,52,1.05,0.60,0.35,0.90,0.70,68,7.0,0.30,0.25,0.20),
('salt_lake','Utah','en','US','salt_lake',-111.89,40.76,0.70, 0.95,64,40,52,1.02,0.58,0.35,0.92,0.68,68,7.0,0.30,0.25,0.20),
('albuquerque','New Mexico','en','US','albuquerque',-106.65,35.08,0.65, 0.95,62,41,51,1.02,0.60,0.35,0.90,0.65,67,7.5,0.30,0.25,0.20),
('phoenix','Arizona','en','US','phoenix',-112.07,33.45,0.70, 0.95,64,40,52,1.03,0.65,0.35,0.92,0.70,68,7.0,0.32,0.25,0.20),
('los_angeles','California (Los Angeles)','en','US','los_angeles',-118.24,34.05,0.85, 0.95,65,40,52,1.10,0.90,0.40,0.95,0.75,68,7.2,0.60,0.30,0.20),
('san_francisco','California (Bay Area)','en','US','san_francisco',-122.42,37.77,0.80, 0.95,65,40,52,1.10,0.88,0.40,0.95,0.75,68,7.2,0.55,0.30,0.20),
('seattle','Pacific Northwest','en','US','seattle',-122.33,47.61,0.80, 0.95,64,40,52,1.05,0.65,0.35,0.95,0.70,68,7.0,0.40,0.28,0.20),
-- ---- Canada --------------------------------------------------------------
('toronto','Canadian (Toronto)','en','CA','toronto',-79.38,43.65,0.85, 0.95,64,40,52,1.05,0.55,0.45,0.95,0.65,60,7.0,0.35,0.25,0.20),
('montreal','Montreal English','en','CA','montreal',-73.57,45.50,0.70, 0.95,60,41,51,1.05,0.50,0.45,0.90,0.62,60,7.2,0.35,0.25,0.20),
('vancouver','Canadian (Vancouver)','en','CA','vancouver',-123.12,49.28,0.80, 0.95,64,40,52,1.05,0.60,0.45,0.95,0.65,60,7.0,0.45,0.25,0.20),
('halifax','Nova Scotia','en','CA','halifax',-63.57,44.65,0.70, 0.90,63,41,52,1.02,0.45,0.45,0.90,0.60,62,7.5,0.30,0.25,0.25),
('st_johns_nl','Newfoundland','en','CA','st_johns_nl',-52.71,47.56,0.80, 0.85,58,42,50,1.00,0.50,0.40,0.40,0.60,58,10.0,0.40,0.25,0.70),
-- ---- Australia & New Zealand ---------------------------------------------
('sydney','Australian (Sydney)','en','AU','sydney',151.21,-33.87,0.85, 0.03,64,40,53,1.15,0.85,0.55,0.15,0.95,55,7.0,0.70,0.45,0.30),
('melbourne','Australian (Melbourne)','en','AU','melbourne',144.96,-37.81,0.85, 0.03,64,40,53,1.15,0.85,0.35,0.15,0.95,55,7.0,0.70,0.45,0.30),
('brisbane','Australian (Brisbane)','en','AU','brisbane',153.03,-27.47,0.75, 0.03,64,40,53,1.15,0.85,0.60,0.15,0.95,55,7.0,0.68,0.45,0.30),
('adelaide','Australian (Adelaide)','en','AU','adelaide',138.60,-34.93,0.75, 0.03,64,40,53,1.15,0.82,0.85,0.15,0.93,55,7.0,0.68,0.42,0.28),
('perth','Australian (Perth)','en','AU','perth',115.86,-31.95,0.70, 0.03,64,40,53,1.15,0.85,0.50,0.15,0.95,55,7.0,0.68,0.45,0.30),
('hobart','Australian (Tasmania)','en','AU','hobart',147.33,-42.88,0.65, 0.03,63,40,53,1.12,0.80,0.60,0.18,0.92,55,7.0,0.65,0.40,0.28),
('auckland','New Zealand (Auckland)','en','NZ','auckland',174.76,-36.85,0.85, 0.05,62,41,52,1.05,0.75,0.50,0.20,0.90,56,7.2,0.60,0.40,0.30),
('wellington','New Zealand (Wellington)','en','NZ','wellington',174.78,-41.29,0.80, 0.05,62,41,52,1.05,0.75,0.50,0.20,0.90,56,7.2,0.60,0.40,0.30),
('christchurch','New Zealand (Canterbury)','en','NZ','christchurch',172.64,-43.53,0.80, 0.10,62,41,52,1.05,0.72,0.50,0.22,0.88,56,7.2,0.58,0.38,0.28),
('dunedin','Southland (Scottish relic)','en','NZ','dunedin',170.50,-45.87,0.75, 0.35,61,41,52,1.00,0.65,0.45,0.40,0.85,54,7.5,0.55,0.35,0.25),
-- ---- Continental Europe: language-general dimensions only ------------------
('madrid','Castilian Spanish','es','ES','madrid',-3.70,40.42,0.80, 0.90,30,44,38,0.55,NULL,NULL,NULL,NULL,20,6.5,0.25,NULL,NULL),
('seville','Andalusian Spanish','es','ES','seville',-5.98,37.39,0.75, 0.70,33,45,40,0.55,NULL,NULL,NULL,NULL,20,7.5,0.30,NULL,NULL),
('barcelona','Catalonian Spanish','es','ES','barcelona',2.17,41.39,0.70, 0.90,32,44,40,0.60,NULL,NULL,NULL,NULL,22,7.0,0.28,NULL,NULL),
('paris','Parisian French','fr','FR','paris',2.35,48.86,0.85, 0.40,34,45,44,0.75,NULL,NULL,NULL,NULL,18,6.0,0.35,NULL,NULL),
('lyon','Lyonnais French','fr','FR','lyon',4.83,45.76,0.70, 0.45,35,45,44,0.76,NULL,NULL,NULL,NULL,19,6.2,0.35,NULL,NULL),
('marseille','Provençal French','fr','FR','marseille',5.37,43.30,0.75, 0.55,38,46,43,0.80,NULL,NULL,NULL,NULL,20,7.5,0.40,NULL,NULL),
('berlin','Berlin German','de','DE','berlin',13.40,52.52,0.80, 0.20,59,41,55,0.95,NULL,NULL,NULL,NULL,60,6.5,0.20,NULL,NULL),
('hamburg','Northern German','de','DE','hamburg',9.99,53.55,0.75, 0.18,60,41,56,0.95,NULL,NULL,NULL,NULL,62,6.5,0.20,NULL,NULL),
('cologne','Rhineland German','de','DE','cologne',6.96,50.94,0.75, 0.25,57,41,54,0.95,NULL,NULL,NULL,NULL,58,7.2,0.25,NULL,NULL),
('munich','Bavarian German','de','DE','munich',11.58,48.14,0.80, 0.45,55,42,53,0.95,NULL,NULL,NULL,NULL,55,7.0,0.25,NULL,NULL),
('vienna','Austrian German','de','AT','vienna',16.37,48.21,0.75, 0.40,54,42,52,0.95,NULL,NULL,NULL,NULL,50,7.0,0.25,NULL,NULL),
('zurich','Swiss German','de','CH','zurich',8.54,47.38,0.70, 0.50,52,42,52,0.95,NULL,NULL,NULL,NULL,45,7.5,0.30,NULL,NULL),
('amsterdam','Dutch','nl','NL','amsterdam',4.90,52.37,0.80, 0.35,61,41,54,0.95,NULL,NULL,NULL,NULL,30,6.8,0.25,NULL,NULL),
('rome','Roman Italian','it','IT','rome',12.50,41.90,0.80, 0.85,35,46,40,0.65,NULL,NULL,NULL,NULL,20,7.0,0.30,NULL,NULL),
('milan','Milanese Italian','it','IT','milan',9.19,45.46,0.75, 0.80,38,45,42,0.68,NULL,NULL,NULL,NULL,22,6.8,0.30,NULL,NULL),
('naples','Neapolitan Italian','it','IT','naples',14.27,40.85,0.75, 0.85,33,47,39,0.70,NULL,NULL,NULL,NULL,20,8.0,0.35,NULL,NULL),
('lisbon','European Portuguese','pt','PT','lisbon',-9.14,38.72,0.80, 0.60,47,41,47,0.85,NULL,NULL,NULL,NULL,25,6.5,0.25,NULL,NULL),
('warsaw','Polish','pl','PL','warsaw',21.01,52.23,0.80, 0.75,48,38,62,0.60,NULL,NULL,NULL,NULL,25,6.0,0.20,NULL,NULL),
('moscow','Russian','ru','RU','moscow',37.62,55.76,0.80, 0.70,52,39,60,0.60,NULL,NULL,NULL,NULL,25,6.5,0.20,NULL,NULL),
('stockholm','Swedish','sv','SE','stockholm',18.07,59.33,0.80, 0.55,57,43,50,1.00,NULL,NULL,NULL,NULL,55,8.5,0.30,NULL,NULL),
('athens','Greek','el','GR','athens',23.73,37.98,0.80, 0.80,40,45,43,0.55,NULL,NULL,NULL,NULL,20,6.8,0.30,NULL,NULL),
('istanbul','Turkish','tr','TR','istanbul',28.98,41.01,0.80, 0.75,42,44,41,0.75,NULL,NULL,NULL,NULL,30,6.5,0.25,NULL,NULL);

INSERT INTO accent_site (id, label, language, country, settlement_id, confidence, geog)
SELECT id, label, lang, country, settlement, conf,
       ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM seed_site;

-- Wide → long. NULLs drop out, which is how "not applicable here" is expressed.
INSERT INTO site_feature (site_id, key, value)
SELECT s.id, f.key, f.value
FROM seed_site s
CROSS JOIN LATERAL (VALUES
  ('rhoticity', s.rhoticity), ('npvi_v', s.npvi_v), ('pct_v', s.pct_v),
  ('delta_c', s.delta_c), ('vowel_area', s.vowel_area), ('goose_f2', s.goose_f2),
  ('trap_bath', s.trap_bath), ('low_back_merge', s.low_back_merge),
  ('diph_index', s.diph_index), ('vot_ms', s.vot_ms), ('f0_span', s.f0_span),
  ('final_rise', s.final_rise), ('t_glottal', s.t_glottal), ('th_shift', s.th_shift)
) AS f(key, value)
WHERE f.value IS NOT NULL;

DROP TABLE seed_site;
