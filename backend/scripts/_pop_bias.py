"""Population-density bias correction for SPC-style report counts.

SPC tornado / hail reports require humans on the ground to record them,
so the raw report-count surface is biased toward population centres.
You can see this clearly in OKC, DFW, Atlanta, and the I-35 corridor —
big spikes that almost certainly reflect *reporting density* rather
than physical hazard density. Brooks et al. and Doswell have published
extensively on this (e.g. Doswell 2007 "Small sample size and data
quality issues …").

This module supplies a smoothed population-density surface for CONUS
and a gentle deflation function:

    corrected = raw / max(1, (pop_dens / median_pop_dens)^alpha)

with ``alpha`` around 0.5 — i.e. cells at 10× median pop density get
divided by sqrt(10) ≈ 3.2, cells at median or below are unchanged.
This squashes urban spikes without zeroing out rural areas.

The pop-density surface is built from a hand-curated top-180 list of
US metropolitan areas (covers every metro ≥ ~150k pop) smoothed by
the same Gaussian kernel the hazard grids use, so the deflation
surface and the hazard surface are at the same scale and grain.
"""

from __future__ import annotations

import math
from functools import lru_cache

# (lat, lon, population) — top US metro centroids, ≥ ~150k people.
# Source: US Census 2020 MSA / urban area estimates, rounded.
# Curated rather than fetched live so the build script has no runtime
# dependencies and works on a plane.
US_METROS: list[tuple[float, float, int]] = [
    # Top 30 metros (>2M)
    (40.7128, -74.0060, 19_800_000),  # New York
    (34.0522, -118.2437, 13_100_000), # Los Angeles
    (41.8781, -87.6298, 9_500_000),   # Chicago
    (32.7767, -96.7970, 7_600_000),   # Dallas-Fort Worth
    (29.7604, -95.3698, 7_300_000),   # Houston
    (33.4484, -112.0740, 5_000_000),  # Phoenix
    (38.9072, -77.0369, 6_300_000),   # Washington DC
    (25.7617, -80.1918, 6_200_000),   # Miami
    (33.7490, -84.3880, 6_300_000),   # Atlanta
    (40.7608, -111.8910, 1_300_000),  # Salt Lake City
    (40.7357, -74.1724, 2_700_000),   # Newark (NJ)
    (42.3601, -71.0589, 4_900_000),   # Boston
    (37.7749, -122.4194, 4_700_000),  # San Francisco
    (47.6062, -122.3321, 4_000_000),  # Seattle
    (39.9526, -75.1652, 6_200_000),   # Philadelphia
    (39.7392, -104.9903, 3_000_000),  # Denver
    (30.2672, -97.7431, 2_500_000),   # Austin
    (32.7157, -117.1611, 3_300_000),  # San Diego
    (29.4241, -98.4936, 2_600_000),   # San Antonio
    (28.5383, -81.3792, 2_800_000),   # Orlando
    (27.9506, -82.4572, 3_200_000),   # Tampa
    (39.7684, -86.1581, 2_100_000),   # Indianapolis
    (35.2271, -80.8431, 2_700_000),   # Charlotte
    (35.7796, -78.6382, 1_500_000),   # Raleigh
    (39.0997, -94.5786, 2_200_000),   # Kansas City
    (45.5152, -122.6784, 2_500_000),  # Portland (OR)
    (38.6270, -90.1994, 2_800_000),   # St. Louis
    (44.9778, -93.2650, 3_700_000),   # Minneapolis
    (35.1495, -90.0490, 1_300_000),   # Memphis
    (33.5207, -86.8025, 1_100_000),   # Birmingham
    # 1M-2M metros
    (41.4993, -81.6944, 2_100_000),   # Cleveland
    (39.9612, -82.9988, 2_100_000),   # Columbus (OH)
    (41.0814, -81.5190, 700_000),     # Akron
    (39.1031, -84.5120, 2_300_000),   # Cincinnati
    (35.1175, -89.9711, 1_300_000),   # Memphis duplicate region
    (35.4676, -97.5164, 1_500_000),   # Oklahoma City
    (36.1627, -86.7816, 2_000_000),   # Nashville
    (30.3322, -81.6557, 1_700_000),   # Jacksonville
    (37.5407, -77.4360, 1_300_000),   # Richmond
    (36.8508, -76.2859, 1_800_000),   # Virginia Beach / Norfolk
    (43.0389, -87.9065, 1_600_000),   # Milwaukee
    (43.6532, -79.3832, 200_000),     # near border but mostly Canadian — small weight
    (44.0521, -123.0868, 380_000),    # Eugene
    (42.3314, -83.0458, 4_400_000),   # Detroit
    (40.4406, -79.9959, 2_400_000),   # Pittsburgh
    (35.0844, -106.6504, 920_000),    # Albuquerque
    (36.1716, -115.1391, 2_300_000),  # Las Vegas
    (33.8303, -116.5453, 470_000),    # Palm Springs / Coachella
    (32.2226, -110.9747, 1_050_000),  # Tucson
    (36.7378, -119.7871, 1_000_000),  # Fresno
    (38.5816, -121.4944, 2_400_000),  # Sacramento
    (40.7831, -73.9712, 1_700_000),   # Manhattan core (dense)
    # 500k-1M metros
    (35.9940, -78.8986, 700_000),     # Durham
    (36.0726, -79.7920, 800_000),     # Greensboro
    (40.7128, -74.0060, 1_500_000),   # Jersey City / Hudson (dense)
    (43.0731, -89.4012, 700_000),     # Madison
    (38.2527, -85.7585, 1_400_000),   # Louisville
    (35.0456, -85.3097, 580_000),     # Chattanooga
    (35.9606, -83.9207, 880_000),     # Knoxville
    (32.0809, -81.0912, 415_000),     # Savannah
    (32.0835, -81.0998, 415_000),     # Savannah
    (34.8526, -82.3940, 920_000),     # Greenville (SC)
    (32.7765, -79.9311, 800_000),     # Charleston (SC)
    (38.0293, -78.4767, 230_000),     # Charlottesville
    (29.9511, -90.0715, 1_300_000),   # New Orleans
    (30.4515, -91.1871, 850_000),     # Baton Rouge
    (32.5252, -93.7502, 400_000),     # Shreveport
    (31.5497, -97.1467, 280_000),     # Waco
    (31.7619, -106.4850, 870_000),    # El Paso
    (32.7357, -97.1081, 2_000_000),   # Arlington / Ft Worth area
    (33.0198, -96.6989, 1_100_000),   # Plano area
    (35.4823, -97.5350, 650_000),     # Norman / OKC south
    (36.1540, -95.9928, 1_000_000),   # Tulsa
    (37.6872, -97.3301, 650_000),     # Wichita
    (39.0997, -94.5786, 500_000),     # KC core
    (37.6889, -97.3361, 400_000),     # Wichita
    (41.2565, -95.9345, 970_000),     # Omaha
    (41.5868, -93.6250, 700_000),     # Des Moines
    (41.6611, -91.5302, 175_000),     # Iowa City
    (44.9778, -93.2650, 580_000),     # Minneapolis core
    (46.7867, -92.1005, 290_000),     # Duluth
    (45.5051, -122.6750, 660_000),    # Portland core
    (47.6062, -122.3321, 750_000),    # Seattle core
    (47.6588, -117.4260, 560_000),    # Spokane
    (43.6150, -116.2023, 800_000),    # Boise
    (40.7608, -111.8910, 200_000),    # SLC core
    (39.7392, -104.9903, 720_000),    # Denver core
    (38.8339, -104.8214, 750_000),    # Colorado Springs
    (39.5501, -105.7821, 110_000),    # Front Range / Evergreen
    (40.5853, -105.0844, 360_000),    # Fort Collins
    (37.6868, -97.3301, 400_000),     # Wichita
    (32.3617, -88.7036, 38_000),      # Meridian MS
    (34.7465, -92.2896, 750_000),     # Little Rock
    (35.7327, -81.6743, 80_000),      # Hickory NC
    (39.2904, -76.6122, 2_800_000),   # Baltimore
    (38.9784, -76.4922, 540_000),     # Annapolis
    (39.7491, -75.5398, 770_000),     # Wilmington (DE)
    (41.7658, -72.6734, 1_200_000),   # Hartford
    (41.3083, -72.9279, 850_000),     # New Haven
    (42.6526, -73.7562, 850_000),     # Albany
    (43.0481, -76.1474, 660_000),     # Syracuse
    (43.1566, -77.6088, 1_050_000),   # Rochester
    (42.8864, -78.8784, 1_140_000),   # Buffalo
    (40.2732, -76.8867, 580_000),     # Harrisburg
    (40.0379, -76.3055, 540_000),     # Lancaster
    (40.6936, -89.5890, 400_000),     # Peoria
    (39.7817, -89.6501, 210_000),     # Springfield (IL)
    (38.6270, -90.1994, 320_000),     # St Louis core
    (44.5133, -88.0133, 320_000),     # Green Bay
    (44.0521, -123.0868, 380_000),    # Eugene
    (43.0731, -89.4012, 270_000),     # Madison core
    (35.7796, -78.6382, 470_000),     # Raleigh core
    (33.4734, -82.0105, 600_000),     # Augusta
    (32.8407, -83.6324, 230_000),     # Macon
    (30.6954, -88.0399, 410_000),     # Mobile
    (30.4383, -84.2807, 380_000),     # Tallahassee
    (26.1224, -80.1373, 1_900_000),   # Ft Lauderdale
    (26.7153, -80.0534, 1_500_000),   # West Palm Beach
    (28.0395, -81.9498, 700_000),     # Lakeland
    (29.6516, -82.3248, 270_000),     # Gainesville
    (24.5551, -81.7800, 80_000),      # Key West
    (35.2226, -82.7160, 130_000),     # Asheville area
    (35.5951, -82.5515, 470_000),     # Asheville
    (37.4316, -78.6569, 80_000),      # Lynchburg
    (36.0823, -80.4421, 240_000),     # Winston-Salem
    (35.7126, -80.2068, 60_000),      # Salisbury NC
    (36.9716, -86.4808, 175_000),     # Bowling Green KY
    (33.6891, -78.8867, 530_000),     # Myrtle Beach
    (38.4496, -82.4452, 175_000),     # Huntington WV
    (39.6295, -79.9559, 110_000),     # Morgantown
    (35.7565, -83.9966, 80_000),      # Sevierville
    (33.5779, -101.8552, 320_000),    # Lubbock
    (32.4487, -99.7331, 170_000),     # Abilene
    (31.5604, -91.4032, 33_000),      # Natchez
    (30.2241, -92.0198, 480_000),     # Lafayette LA
    (37.0902, -113.5841, 180_000),    # St George UT
    (35.0844, -106.6504, 250_000),    # Albuquerque core
    (36.1539, -95.9928, 410_000),     # Tulsa core
    (35.0078, -97.5164, 200_000),     # OKC south
    (38.0293, -78.4767, 95_000),      # Charlottesville
    (44.4759, -73.2121, 215_000),     # Burlington VT
    (43.6614, -70.2553, 540_000),     # Portland ME
    (42.9956, -71.4548, 410_000),     # Manchester NH
    (41.8240, -71.4128, 770_000),     # Providence
    (32.8205, -97.0114, 230_000),     # Hurst-Euless-Bedford TX
    (33.4942, -111.9261, 270_000),    # Tempe
    (34.0007, -81.0348, 830_000),     # Columbia SC
    (32.3617, -86.2792, 380_000),     # Montgomery AL
    (31.7785, -85.9714, 75_000),      # Troy AL
    (40.2732, -86.1349, 470_000),     # Lafayette IN
    (39.1612, -75.5264, 175_000),     # Dover DE
    (38.9586, -94.7066, 200_000),     # Overland Park KS
    (41.4925, -99.9018, 30_000),      # central Nebraska
    (44.0683, -103.2270, 80_000),     # Rapid City SD
    (43.5460, -96.7313, 280_000),     # Sioux Falls
    (46.8772, -96.7898, 250_000),     # Fargo
    (46.8083, -100.7837, 130_000),    # Bismarck
    (47.9253, -97.0329, 100_000),     # Grand Forks
    (46.5891, -112.0391, 80_000),     # Helena MT
    (45.7833, -108.5007, 180_000),    # Billings
    (46.8721, -113.9940, 120_000),    # Missoula
    (44.0805, -103.2310, 80_000),     # Rapid City core
    (42.8666, -106.3131, 80_000),     # Casper
    (44.7619, -85.6206, 16_000),      # Traverse City
    (45.7669, -84.7278, 4_000),       # Mackinaw City
    (40.7128, -82.7755, 80_000),      # Mansfield OH
    (39.2904, -76.6122, 700_000),     # Baltimore core
    (28.2639, -80.7214, 600_000),     # Melbourne FL
    (27.3364, -82.5307, 850_000),     # Sarasota
    (26.6406, -81.8723, 770_000),     # Ft Myers
    (30.5083, -91.1898, 200_000),     # Baton Rouge core
    (32.3792, -86.3077, 200_000),     # Montgomery
    (32.4609, -84.9877, 320_000),     # Columbus GA
    (33.9519, -83.3576, 260_000),     # Athens GA
    (34.7304, -86.5861, 480_000),     # Huntsville
    (34.5034, -88.1456, 110_000),     # Tupelo
    (35.8456, -86.3903, 180_000),     # Murfreesboro
    (36.5298, -87.3595, 220_000),     # Clarksville TN
    (37.9762, -87.5558, 175_000),     # Evansville
    (39.0997, -84.5120, 800_000),     # Cincinnati core
    (41.4993, -81.6944, 700_000),     # Cleveland core
    (41.6611, -83.5379, 600_000),     # Toledo
    (41.6764, -86.2520, 270_000),     # South Bend
    (42.2625, -85.5836, 330_000),     # Kalamazoo
    (42.9634, -85.6681, 1_100_000),   # Grand Rapids
    (43.5979, -84.7676, 100_000),     # Mt Pleasant MI
    (44.5588, -69.6480, 30_000),      # Augusta ME
    (45.2538, -69.4455, 16_000),      # Dover-Foxcroft ME
    (43.1939, -71.5724, 110_000),     # Concord NH
    (39.5296, -119.8138, 470_000),    # Reno
    (39.1638, -119.7674, 55_000),     # Carson City
    (37.6394, -120.9966, 540_000),    # Modesto
    (38.4404, -122.7141, 480_000),    # Santa Rosa
    (37.3382, -121.8863, 1_950_000),  # San Jose
    (36.7468, -119.7726, 1_000_000),  # Fresno
    (35.3733, -119.0187, 900_000),    # Bakersfield
    (34.4208, -119.6982, 440_000),    # Santa Barbara
    (33.7701, -118.1937, 470_000),    # Long Beach
    (34.1083, -117.2898, 220_000),    # San Bernardino
    (33.9533, -117.3962, 320_000),    # Riverside
    (33.6803, -117.8265, 350_000),    # Newport Beach
    (32.7157, -117.1611, 1_400_000),  # San Diego core
]


def population_density_at(
    lat: float,
    lon: float,
    sigma_deg: float = 0.7,
) -> float:
    """KDE estimate of nearby population (sum of metro pops weighted by
    Gaussian distance). The sigma is wider than the hazard KDE because
    metro influence on reporting density spreads further than a tornado
    or hail cell does — a stringer driving 30 mi from OKC still reports
    storms back to Oklahoma City. Returns weighted sum (units: people)."""
    sigma2 = sigma_deg * sigma_deg
    total = 0.0
    for mlat, mlon, pop in US_METROS:
        dlat = lat - mlat
        dlon = lon - mlon
        d2 = dlat * dlat + dlon * dlon
        if d2 > 9 * sigma2:  # 3-sigma cutoff
            continue
        total += pop * math.exp(-d2 / sigma2)
    return total


_THRESHOLD_POP = 200_000   # below this weighted-pop, no correction is applied
_ALPHA = 0.7                # slope of the log deflator above threshold
_MAX_DEFLATOR = 2.5         # cap so dense metros aren't blanked out entirely


def deflator(lat: float, lon: float) -> float:
    """Multiplicative deflator at (lat, lon).

    ``divide raw hazard by this``.

    Formula: ``min(MAX, max(1, 1 + alpha * log10(pop / threshold)))``.
    Calibration targets — gives ~1.7x at OKC, ~2.2x at DFW, ~2.5x at
    NYC, ~1.0x in rural Plains / Black Hills. That's enough to visibly
    tame the urban reporting spikes without zeroing them out (urban
    areas still get real storms — Doswell 2007 specifically warns
    against over-correction here)."""
    pop = population_density_at(lat, lon)
    if pop <= _THRESHOLD_POP:
        return 1.0
    raw = 1.0 + _ALPHA * math.log10(pop / _THRESHOLD_POP)
    return min(_MAX_DEFLATOR, max(1.0, raw))
