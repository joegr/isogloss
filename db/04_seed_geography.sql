-- Isogloss — the geographic substrate: land, barriers, corridors, settlements.
--
-- Land polygons are deliberately coarse (tens of vertices). They exist to clip
-- Voronoi cells to something coastline-shaped, not to be a basemap.

-- --------------------------------------------------------------------------
-- Study areas
-- --------------------------------------------------------------------------

INSERT INTO study_area (id, name, land) VALUES
('gb-ie', 'Britain & Ireland', ST_Multi(ST_Collect(ARRAY[
  ST_GeomFromText('POLYGON((-5.7 50.07,-5.2 50.3,-4.2 51.2,-5.3 51.9,-4.7 52.8,-4.1 53.3,
    -3.1 53.4,-3.0 54.1,-3.6 54.5,-4.8 54.7,-5.2 55.0,-4.8 55.7,-5.6 55.4,-5.1 56.5,
    -5.8 57.5,-5.4 58.3,-4.7 58.6,-3.0 58.6,-2.0 57.7,-2.1 56.9,-1.6 55.9,-1.3 54.7,
    -0.2 54.1,0.1 53.5,0.3 52.9,1.7 52.7,1.3 51.9,1.0 51.4,1.4 51.1,0.5 50.8,-1.4 50.6,
    -3.5 50.6,-4.2 50.3,-5.7 50.07))', 4326),
  ST_GeomFromText('POLYGON((-10.4 51.8,-9.9 52.6,-9.9 53.4,-10.1 54.3,-8.6 54.3,-8.3 55.2,
    -7.3 55.4,-6.0 55.2,-5.5 54.7,-6.1 54.1,-6.0 53.4,-6.1 52.8,-6.5 52.2,-7.6 51.9,
    -9.0 51.5,-10.4 51.8))', 4326)
]))),

('na', 'North America', ST_Multi(ST_Collect(ARRAY[
  ST_GeomFromText('POLYGON((-124.7 48.4,-124.1 46.2,-124.0 43.3,-122.4 37.8,-120.6 34.5,
    -117.1 32.5,-114.7 32.7,-111.0 31.3,-108.2 31.3,-106.5 31.8,-103.0 29.0,-99.1 26.4,
    -97.1 25.9,-94.7 29.3,-93.8 29.7,-91.0 29.2,-89.0 29.2,-88.0 30.4,-85.5 29.9,
    -84.0 30.1,-82.8 27.9,-80.9 25.2,-80.5 27.5,-81.3 31.0,-79.0 33.5,-76.0 35.2,
    -75.5 37.5,-74.0 40.4,-71.5 41.2,-70.0 41.7,-70.8 43.1,-67.0 44.8,-64.0 45.2,
    -61.0 45.5,-59.9 46.2,-64.5 48.5,-68.0 48.8,-71.2 46.8,-74.5 45.5,-76.5 44.3,
    -79.5 43.4,-82.4 41.7,-83.0 42.3,-82.5 45.0,-84.7 46.0,-88.0 48.3,-89.5 48.0,
    -95.2 49.0,-104.0 49.0,-114.0 49.0,-123.0 49.0,-124.7 48.4))', 4326),
  ST_GeomFromText('POLYGON((-59.4 47.6,-58.5 48.5,-56.0 51.4,-55.5 49.5,-53.0 49.7,
    -52.6 47.6,-55.0 46.8,-59.4 47.6))', 4326)
]))),

('anz', 'Australia & New Zealand', ST_Multi(ST_Collect(ARRAY[
  ST_GeomFromText('POLYGON((113.2 -26.0,114.0 -21.8,122.0 -18.0,126.0 -13.8,130.8 -11.2,
    136.7 -12.0,135.0 -15.0,141.0 -12.5,145.5 -15.0,149.0 -21.0,153.0 -25.5,153.6 -28.6,
    151.0 -33.9,150.0 -37.5,146.0 -38.9,141.0 -38.4,138.0 -35.6,135.0 -34.8,132.0 -32.0,
    126.0 -32.3,120.0 -34.0,115.0 -34.4,114.9 -31.9,113.2 -26.0))', 4326),
  ST_GeomFromText('POLYGON((144.6 -40.7,148.3 -40.7,148.0 -43.5,145.0 -43.5,144.6 -40.7))', 4326),
  ST_GeomFromText('POLYGON((172.7 -34.4,174.5 -35.2,178.5 -37.5,178.0 -39.5,176.0 -41.4,
    174.0 -41.5,173.0 -40.5,174.5 -38.0,172.7 -34.4))', 4326),
  ST_GeomFromText('POLYGON((172.5 -40.5,174.3 -41.7,173.0 -43.6,171.0 -45.0,170.8 -46.0,
    168.0 -46.7,166.5 -45.9,168.5 -44.0,171.5 -42.0,172.5 -40.5))', 4326)
]))),

('eu', 'Continental Europe', ST_Multi(ST_GeomFromText('POLYGON((
  -9.5 43.8,-9.0 38.7,-6.0 36.0,-1.5 36.8,3.3 42.4,9.5 44.0,12.5 41.9,15.5 38.2,
  18.5 40.0,19.5 42.5,23.7 38.0,26.5 39.5,29.0 41.0,28.0 45.0,30.5 46.5,37.0 47.0,
  40.0 50.0,38.0 56.0,30.0 60.0,25.0 60.0,21.0 56.0,19.0 54.5,12.0 54.5,10.5 57.7,
  8.0 55.0,4.5 52.5,3.0 51.0,-1.5 49.3,-4.8 48.4,-1.5 46.0,-1.8 43.4,-9.5 43.8
))', 4326)));

-- --------------------------------------------------------------------------
-- Barriers — what diffusion does not cross
-- --------------------------------------------------------------------------

INSERT INTO barrier (name, kind, resistance, geom) VALUES
('Pennines',            'mountain',  0.9, ST_GeomFromText('LINESTRING(-2.3 53.4,-2.2 54.0,-2.4 54.6,-2.4 55.1)', 4326)),
('Cambrian Mountains',  'mountain',  0.7, ST_GeomFromText('LINESTRING(-3.0 51.8,-3.3 52.6,-3.5 53.2)', 4326)),
('Highland Line',       'mountain',  1.1, ST_GeomFromText('LINESTRING(-5.6 55.9,-4.5 56.3,-3.3 57.2,-2.2 57.6)', 4326)),
('Irish Sea',           'water',     1.6, ST_GeomFromText('LINESTRING(-5.9 51.6,-5.5 53.4,-5.0 54.6,-5.2 55.4)', 4326)),
('English Channel',     'water',     1.9, ST_GeomFromText('LINESTRING(-5.5 49.6,-2.0 49.9,0.0 50.3,1.6 51.0)', 4326)),
('Appalachians',        'mountain',  1.0, ST_GeomFromText('LINESTRING(-84.5 33.8,-82.5 36.0,-80.0 38.5,-78.0 40.5,-75.5 42.5)', 4326)),
('Rocky Mountains',     'mountain',  1.2, ST_GeomFromText('LINESTRING(-108.5 32.0,-106.5 39.0,-110.0 45.0,-113.5 49.0)', 4326)),
('Cascades & Sierra',   'mountain',  1.0, ST_GeomFromText('LINESTRING(-118.3 35.6,-119.5 38.5,-121.5 41.5,-121.7 45.5,-121.8 48.8)', 4326)),
('Great Lakes',         'water',     1.0, ST_GeomFromText('LINESTRING(-83.0 41.6,-82.5 43.0,-84.0 45.5,-87.0 45.9,-88.0 47.5)', 4326)),
('Mason–Dixon',         'political', 0.6, ST_GeomFromText('LINESTRING(-80.5 39.72,-75.8 39.72)', 4326)),
('Ohio River line',     'political', 0.5, ST_GeomFromText('LINESTRING(-79.9 40.4,-82.6 38.7,-85.7 38.2,-88.0 37.8,-89.1 37.0)', 4326)),
('Gulf of St Lawrence', 'water',     1.3, ST_GeomFromText('LINESTRING(-64.5 48.6,-60.0 47.5,-56.5 47.0)', 4326)),
('Bass Strait',         'water',     1.2, ST_GeomFromText('LINESTRING(144.0 -39.6,148.8 -39.6)', 4326)),
('Cook Strait',         'water',     1.0, ST_GeomFromText('LINESTRING(173.8 -41.4,175.5 -41.0)', 4326)),
('Tasman Sea',          'water',     1.5, ST_GeomFromText('LINESTRING(152.0 -34.0,165.0 -38.0,171.0 -41.5)', 4326)),
('Nullarbor',           'political', 0.8, ST_GeomFromText('LINESTRING(129.0 -25.0,129.0 -31.6)', 4326)),
('Alps',                'mountain',  1.4, ST_GeomFromText('LINESTRING(6.0 45.9,10.0 46.6,13.5 47.0)', 4326)),
('Pyrenees',            'mountain',  1.4, ST_GeomFromText('LINESTRING(-1.6 43.3,0.7 42.7,3.2 42.4)', 4326)),
('Benrath line',        'political', 0.8, ST_GeomFromText('LINESTRING(6.0 51.2,7.5 51.0,9.5 51.3,11.5 51.6)', 4326));

-- --------------------------------------------------------------------------
-- Corridors — what diffusion follows
-- --------------------------------------------------------------------------

INSERT INTO corridor (name, kind, assist, width_m, geom) VALUES
('Mississippi River',   'river', 0.6, 60000, ST_GeomFromText('LINESTRING(-90.1 29.9,-90.2 32.3,-90.0 35.1,-90.5 38.6,-91.5 41.5,-93.1 44.9)', 4326)),
('Ohio River',          'river', 0.5, 45000, ST_GeomFromText('LINESTRING(-79.9 40.4,-82.6 38.4,-85.7 38.1,-88.0 37.8,-89.1 37.0)', 4326)),
('National Road (US-40)','road', 0.5, 40000, ST_GeomFromText('LINESTRING(-76.6 39.3,-79.0 39.6,-82.0 39.9,-86.2 39.8,-89.6 39.8)', 4326)),
('Northeast Corridor',  'rail',  0.7, 40000, ST_GeomFromText('LINESTRING(-77.0 38.9,-75.2 40.0,-74.0 40.7,-72.9 41.3,-71.1 42.4)', 4326)),
('Great Valley',        'road',  0.6, 50000, ST_GeomFromText('LINESTRING(-75.5 40.6,-78.9 38.4,-80.5 37.0,-82.5 35.6,-84.5 34.5)', 4326)),
('Erie Canal',          'river', 0.5, 40000, ST_GeomFromText('LINESTRING(-73.8 42.7,-76.1 43.0,-78.9 43.0,-81.7 41.5,-83.0 42.3)', 4326)),
('Great North Road',    'road',  0.5, 30000, ST_GeomFromText('LINESTRING(-0.13 51.5,-0.5 52.1,-1.1 52.6,-1.5 53.4,-1.5 54.0,-1.6 54.9)', 4326)),
('Thames Estuary',      'river', 0.6, 25000, ST_GeomFromText('LINESTRING(-1.3 51.5,-0.1 51.5,0.7 51.5,1.4 51.4)', 4326)),
('M62 / Trans-Pennine', 'road',  0.4, 25000, ST_GeomFromText('LINESTRING(-2.99 53.41,-2.24 53.48,-1.55 53.80)', 4326)),
('West Coast Main Line','rail',  0.5, 30000, ST_GeomFromText('LINESTRING(-0.13 51.5,-1.9 52.48,-2.24 53.48,-2.94 54.89,-4.25 55.86)', 4326)),
('Rhine corridor',      'river', 0.6, 45000, ST_GeomFromText('LINESTRING(7.6 47.6,8.3 49.0,7.3 50.0,6.9 51.2,6.1 51.9,4.9 52.4)', 4326)),
('Trans-Australian',    'rail',  0.6, 80000, ST_GeomFromText('LINESTRING(115.9 -32.0,121.5 -30.8,130.0 -31.5,138.6 -34.9,145.0 -37.8,151.2 -33.9)', 4326));

-- --------------------------------------------------------------------------
-- Settlements — nodes of the interaction graph
-- --------------------------------------------------------------------------
-- Populations are metro-area order-of-magnitude figures. Precision does not
-- matter much: gravity uses P^0.5, so a factor-of-two error moves the weight by
-- 40%, while the London/Ocracoke ratio spans four orders of magnitude.

INSERT INTO settlement (id, name, country, population, geog) VALUES
-- Britain & Ireland
('london',      'London',        'GB',  9540000, 'SRID=4326;POINT(-0.13 51.51)'),
('birmingham',  'Birmingham',    'GB',  2600000, 'SRID=4326;POINT(-1.90 52.48)'),
('manchester',  'Manchester',    'GB',  2730000, 'SRID=4326;POINT(-2.24 53.48)'),
('liverpool',   'Liverpool',     'GB',   900000, 'SRID=4326;POINT(-2.99 53.41)'),
('leeds',       'Leeds',         'GB',  1900000, 'SRID=4326;POINT(-1.55 53.80)'),
('sheffield',   'Sheffield',     'GB',   730000, 'SRID=4326;POINT(-1.47 53.38)'),
('newcastle',   'Newcastle',     'GB',   810000, 'SRID=4326;POINT(-1.61 54.98)'),
('bristol',     'Bristol',       'GB',   700000, 'SRID=4326;POINT(-2.59 51.45)'),
('nottingham',  'Nottingham',    'GB',   730000, 'SRID=4326;POINT(-1.15 52.95)'),
('norwich',     'Norwich',       'GB',   200000, 'SRID=4326;POINT(1.30 52.63)'),
('glasgow',     'Glasgow',       'GB',  1200000, 'SRID=4326;POINT(-4.25 55.86)'),
('edinburgh',   'Edinburgh',     'GB',   540000, 'SRID=4326;POINT(-3.19 55.95)'),
('aberdeen',    'Aberdeen',      'GB',   200000, 'SRID=4326;POINT(-2.09 57.15)'),
('inverness',   'Inverness',     'GB',    65000, 'SRID=4326;POINT(-4.22 57.48)'),
('cardiff',     'Cardiff',       'GB',   490000, 'SRID=4326;POINT(-3.18 51.48)'),
('swansea',     'Swansea',       'GB',   240000, 'SRID=4326;POINT(-3.94 51.62)'),
('belfast',     'Belfast',       'GB',   640000, 'SRID=4326;POINT(-5.93 54.60)'),
('dublin',      'Dublin',        'IE',  1460000, 'SRID=4326;POINT(-6.26 53.35)'),
('cork',        'Cork',          'IE',   220000, 'SRID=4326;POINT(-8.47 51.90)'),
('galway',      'Galway',        'IE',    85000, 'SRID=4326;POINT(-9.05 53.27)'),
('limerick',    'Limerick',      'IE',   100000, 'SRID=4326;POINT(-8.62 52.66)'),
('plymouth',    'Plymouth',      'GB',   265000, 'SRID=4326;POINT(-4.14 50.38)'),
('exeter',      'Exeter',        'GB',   130000, 'SRID=4326;POINT(-3.53 50.72)'),
('southampton', 'Southampton',   'GB',   350000, 'SRID=4326;POINT(-1.40 50.90)'),
('brighton',    'Brighton',      'GB',   290000, 'SRID=4326;POINT(-0.14 50.82)'),
('carlisle',    'Carlisle',      'GB',    75000, 'SRID=4326;POINT(-2.94 54.89)'),
('hull',        'Hull',          'GB',   285000, 'SRID=4326;POINT(-0.34 53.74)'),
('stoke',       'Stoke-on-Trent','GB',   260000, 'SRID=4326;POINT(-2.18 53.00)'),
('lincoln',     'Lincoln',       'GB',   100000, 'SRID=4326;POINT(-0.54 53.23)'),
('miltonkeynes','Milton Keynes', 'GB',   230000, 'SRID=4326;POINT(-0.76 52.04)'),
-- North America
('new_york',    'New York',      'US', 18900000, 'SRID=4326;POINT(-74.01 40.71)'),
('los_angeles', 'Los Angeles',   'US', 12500000, 'SRID=4326;POINT(-118.24 34.05)'),
('chicago',     'Chicago',       'US',  8900000, 'SRID=4326;POINT(-87.63 41.88)'),
('houston',     'Houston',       'US',  6300000, 'SRID=4326;POINT(-95.37 29.76)'),
('dallas',      'Dallas',        'US',  6600000, 'SRID=4326;POINT(-96.80 32.78)'),
('philadelphia','Philadelphia',  'US',  5700000, 'SRID=4326;POINT(-75.16 39.95)'),
('miami',       'Miami',         'US',  5700000, 'SRID=4326;POINT(-80.19 25.77)'),
('atlanta',     'Atlanta',       'US',  5300000, 'SRID=4326;POINT(-84.39 33.75)'),
('phoenix',     'Phoenix',       'US',  4600000, 'SRID=4326;POINT(-112.07 33.45)'),
('boston',      'Boston',        'US',  4300000, 'SRID=4326;POINT(-71.06 42.36)'),
('san_francisco','San Francisco','US',  4400000, 'SRID=4326;POINT(-122.42 37.77)'),
('detroit',     'Detroit',       'US',  3800000, 'SRID=4326;POINT(-83.05 42.33)'),
('seattle',     'Seattle',       'US',  3300000, 'SRID=4326;POINT(-122.33 47.61)'),
('minneapolis', 'Minneapolis',   'US',  3300000, 'SRID=4326;POINT(-93.27 44.98)'),
('denver',      'Denver',        'US',  2600000, 'SRID=4326;POINT(-104.99 39.74)'),
('st_louis',    'St. Louis',     'US',  2200000, 'SRID=4326;POINT(-90.20 38.63)'),
('pittsburgh',  'Pittsburgh',    'US',  1700000, 'SRID=4326;POINT(-79.99 40.44)'),
('cleveland',   'Cleveland',     'US',  1700000, 'SRID=4326;POINT(-81.69 41.50)'),
('cincinnati',  'Cincinnati',    'US',  1700000, 'SRID=4326;POINT(-84.51 39.10)'),
('nashville',   'Nashville',     'US',  1600000, 'SRID=4326;POINT(-86.78 36.16)'),
('memphis',     'Memphis',       'US',  1200000, 'SRID=4326;POINT(-90.05 35.15)'),
('salt_lake',   'Salt Lake City','US',  1200000, 'SRID=4326;POINT(-111.89 40.76)'),
('buffalo',     'Buffalo',       'US',  1100000, 'SRID=4326;POINT(-78.88 42.89)'),
('new_orleans', 'New Orleans',   'US',  1000000, 'SRID=4326;POINT(-90.07 29.95)'),
('richmond',    'Richmond',      'US',  1000000, 'SRID=4326;POINT(-77.44 37.54)'),
('albuquerque', 'Albuquerque',   'US',   900000, 'SRID=4326;POINT(-106.65 35.08)'),
('charleston_sc','Charleston',   'US',   700000, 'SRID=4326;POINT(-79.93 32.78)'),
('asheville',   'Asheville',     'US',   250000, 'SRID=4326;POINT(-82.55 35.60)'),
('bangor_me',   'Bangor',        'US',   100000, 'SRID=4326;POINT(-68.78 44.80)'),
('ocracoke',    'Ocracoke',      'US',      950, 'SRID=4326;POINT(-75.98 35.11)'),
('toronto',     'Toronto',       'CA',  6200000, 'SRID=4326;POINT(-79.38 43.65)'),
('montreal',    'Montreal',      'CA',  4200000, 'SRID=4326;POINT(-73.57 45.50)'),
('vancouver',   'Vancouver',     'CA',  2600000, 'SRID=4326;POINT(-123.12 49.28)'),
('halifax',     'Halifax',       'CA',   450000, 'SRID=4326;POINT(-63.57 44.65)'),
('st_johns_nl', 'St. John''s',   'CA',   210000, 'SRID=4326;POINT(-52.71 47.56)'),
-- Australia & New Zealand
('sydney',      'Sydney',        'AU',  5300000, 'SRID=4326;POINT(151.21 -33.87)'),
('melbourne',   'Melbourne',     'AU',  5000000, 'SRID=4326;POINT(144.96 -37.81)'),
('brisbane',    'Brisbane',      'AU',  2600000, 'SRID=4326;POINT(153.03 -27.47)'),
('perth',       'Perth',         'AU',  2100000, 'SRID=4326;POINT(115.86 -31.95)'),
('adelaide',    'Adelaide',      'AU',  1400000, 'SRID=4326;POINT(138.60 -34.93)'),
('hobart',      'Hobart',        'AU',   250000, 'SRID=4326;POINT(147.33 -42.88)'),
('auckland',    'Auckland',      'NZ',  1700000, 'SRID=4326;POINT(174.76 -36.85)'),
('wellington',  'Wellington',    'NZ',   420000, 'SRID=4326;POINT(174.78 -41.29)'),
('christchurch','Christchurch',  'NZ',   400000, 'SRID=4326;POINT(172.64 -43.53)'),
('dunedin',     'Dunedin',       'NZ',   130000, 'SRID=4326;POINT(170.50 -45.87)'),
-- Continental Europe
('madrid',      'Madrid',        'ES',  6700000, 'SRID=4326;POINT(-3.70 40.42)'),
('barcelona',   'Barcelona',     'ES',  5600000, 'SRID=4326;POINT(2.17 41.39)'),
('seville',     'Seville',       'ES',  1500000, 'SRID=4326;POINT(-5.98 37.39)'),
('paris',       'Paris',         'FR', 11100000, 'SRID=4326;POINT(2.35 48.86)'),
('marseille',   'Marseille',     'FR',  1600000, 'SRID=4326;POINT(5.37 43.30)'),
('lyon',        'Lyon',          'FR',  1700000, 'SRID=4326;POINT(4.83 45.76)'),
('berlin',      'Berlin',        'DE',  4500000, 'SRID=4326;POINT(13.40 52.52)'),
('munich',      'Munich',        'DE',  2600000, 'SRID=4326;POINT(11.58 48.14)'),
('hamburg',     'Hamburg',       'DE',  3300000, 'SRID=4326;POINT(9.99 53.55)'),
('cologne',     'Cologne',       'DE',  3600000, 'SRID=4326;POINT(6.96 50.94)'),
('vienna',      'Vienna',        'AT',  2000000, 'SRID=4326;POINT(16.37 48.21)'),
('zurich',      'Zurich',        'CH',  1400000, 'SRID=4326;POINT(8.54 47.38)'),
('amsterdam',   'Amsterdam',     'NL',  2500000, 'SRID=4326;POINT(4.90 52.37)'),
('rome',        'Rome',          'IT',  4300000, 'SRID=4326;POINT(12.50 41.90)'),
('milan',       'Milan',         'IT',  5300000, 'SRID=4326;POINT(9.19 45.46)'),
('naples',      'Naples',        'IT',  3000000, 'SRID=4326;POINT(14.27 40.85)'),
('lisbon',      'Lisbon',        'PT',  2900000, 'SRID=4326;POINT(-9.14 38.72)'),
('warsaw',      'Warsaw',        'PL',  3100000, 'SRID=4326;POINT(21.01 52.23)'),
('moscow',      'Moscow',        'RU', 12600000, 'SRID=4326;POINT(37.62 55.76)'),
('stockholm',   'Stockholm',     'SE',  1600000, 'SRID=4326;POINT(18.07 59.33)'),
('athens',      'Athens',        'GR',  3200000, 'SRID=4326;POINT(23.73 37.98)'),
('istanbul',    'Istanbul',      'TR', 15500000, 'SRID=4326;POINT(28.98 41.01)');

-- --------------------------------------------------------------------------
-- Ancestry — the wormholes
-- --------------------------------------------------------------------------
-- Pairs that are linguistically adjacent despite being geographically remote.
-- Without these, the interpolator has no way to explain why Dunedin sounds
-- Scottish or why Newfoundland sounds Irish.

INSERT INTO ancestry (parent_id, child_id, weight, note) VALUES
('london',    'sydney',      5.0, 'Founder population, 1788 onward'),
('london',    'melbourne',   4.0, 'Gold-rush era migration'),
('london',    'auckland',    4.0, 'Organised settlement, 1840s'),
('london',    'toronto',     2.5, 'Loyalist and later British migration'),
('london',    'boston',      3.0, 'Puritan migration, 1630s'),
('plymouth',  'boston',      3.0, 'West Country founder effect in New England'),
('bristol',   'charleston_sc',2.5,'Atlantic trade settlement'),
('cork',      'st_johns_nl', 5.0, 'Southeast Irish migratory fishery'),
('dublin',    'new_york',    3.0, 'Post-Famine migration'),
('glasgow',   'belfast',     4.0, 'Ulster Scots, continuous contact'),
('belfast',   'asheville',   3.5, 'Scots-Irish down the Great Valley'),
('edinburgh', 'dunedin',     4.5, 'Free Church of Scotland settlement, 1848'),
('galway',    'st_johns_nl', 2.5, 'Western Irish migration');
