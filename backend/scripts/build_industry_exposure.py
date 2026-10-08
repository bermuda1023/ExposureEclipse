"""Build the Industry cedant exposure book.

County residential and commercial insured values for wind (WS). The two
segments are stored separately so the UI can show the split. Map TIV and
hurricane-impact losses sum them. This is an estimate, not an RMS or AIR
industry database.

Residential
  Census ACS 5-year housing by tenure and units in structure, plus median
  owner-occupied value. Market value is turned into a structure replacement
  cost by removing a modeled land share (higher where the county median sits
  far above its state, because that premium is mostly land), lifting the
  median toward the mean, and bridging ACS 2023 dollars to early 2026.
  Contents and additional living expense sit on the structure. Homeowner
  take-up follows the housing survey (about 91 percent; higher on the
  hurricane coast, lower in California). Renters contents use a 48 percent
  take-up. Condo interiors stay residential. The condo shell and buildings
  of 5 or more units are commercial, so the structure is not counted twice.
  Small rental houses (1 to 4 units) stay residential.

Commercial
  EIA CBECS 2018 floorspace, grown to 2026, allocated to counties by Census
  County Business Patterns employment, then priced at a reconstruction cost
  per square foot times a state cost index. Public buildings are only partly
  insured. Manufacturing floorspace is added because CBECS excludes industrial
  buildings, and that piece is included in the commercial segment.

Run from the repo root:
  python backend/scripts/build_industry_exposure.py
"""

from __future__ import annotations

import csv
import json
import math
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_FACTS = ROOT / "mockdata" / "exposure_facts" / "ds-industry-ws.json"
OUT_CSV = ROOT / "mockdata" / "industry_exposure_counties.csv"
OUT_SUMMARY = ROOT / "mockdata" / "industry_exposure_summary.json"

USER_AGENT = "PerilVista/1.0 (industry exposure build)"
ACS_YEAR = 2023
CBP_YEAR = 2022

# ACS 2023 values to early-2026 reconstruction dollars.
VALUE_TO_2026 = 1.08
# Right tail: mean owner-occupied value sits above the median.
MEAN_OVER_MEDIAN = 1.22
# CBECS 2018 floorspace grown about 2 percent a year to 2026.
FLOORSPACE_GROWTH = 1.17
CBECS_SQFT_2018 = 96_400_000_000
# Modeled. CBECS does not cover manufacturing plants.
MANUFACTURING_SQFT_2018 = 12_000_000_000

RENTER_CONTENTS = 30_000
RENTER_ALE = 6_000
RENTER_TAKEUP = 0.48

HURRICANE_COAST = {"FL", "LA", "TX", "MS", "AL", "GA", "SC", "NC", "VA"}

# Fraction of owner-occupied market value that is land, before the
# county-versus-state adjustment. Modeled from the FHFA land-share range,
# not a vendor extract.
STATE_LAND: dict[str, float] = {
    "HI": 0.62, "DC": 0.60, "CA": 0.55, "NY": 0.52, "MA": 0.48, "NJ": 0.48,
    "CT": 0.46, "RI": 0.45, "WA": 0.45, "MD": 0.44, "OR": 0.42, "CO": 0.42,
    "NV": 0.42, "FL": 0.40, "VA": 0.40, "NH": 0.40, "AZ": 0.38, "DE": 0.36,
    "UT": 0.36, "IL": 0.34, "TX": 0.32, "NC": 0.32, "MN": 0.30, "PA": 0.30,
    "GA": 0.30, "SC": 0.30, "VT": 0.30, "PR": 0.30, "ME": 0.28, "OH": 0.28,
    "ID": 0.28, "AK": 0.28, "TN": 0.26, "MI": 0.26, "WI": 0.26, "LA": 0.24,
    "NM": 0.24, "IN": 0.24, "MO": 0.24, "AL": 0.22, "OK": 0.22, "KY": 0.22,
    "IA": 0.22, "NE": 0.22, "MT": 0.22, "AR": 0.20, "KS": 0.20, "WY": 0.20,
    "MS": 0.18, "WV": 0.18, "SD": 0.18, "ND": 0.18,
}

# Reconstruction cost index, 1.0 = US average. Modeled on RSMeans city indexes.
STATE_COST: dict[str, float] = {
    "HI": 1.40, "AK": 1.30, "NY": 1.28, "CA": 1.22, "NJ": 1.20, "MA": 1.18,
    "CT": 1.15, "WA": 1.12, "IL": 1.12, "OR": 1.08, "DC": 1.16, "MD": 1.05,
    "NV": 1.05, "PA": 1.05, "CO": 1.02, "RI": 1.10, "NH": 1.04, "VA": 0.98,
    "AZ": 0.94, "DE": 1.02, "FL": 0.92, "TX": 0.88, "GA": 0.90, "NC": 0.88,
    "UT": 1.00, "MN": 1.02, "MI": 1.00, "OH": 0.96, "TN": 0.90, "SC": 0.86,
    "LA": 0.90, "AL": 0.84, "MO": 0.92, "WI": 0.98, "IN": 0.92, "KY": 0.88,
    "OK": 0.86, "KS": 0.88, "IA": 0.90, "NE": 0.88, "AR": 0.82, "MS": 0.82,
    "WV": 0.88, "NM": 0.90, "ID": 0.94, "ME": 0.96, "VT": 0.98, "MT": 0.96,
    "WY": 0.94, "SD": 0.88, "ND": 0.92, "PR": 0.84,
}

FIPS_TO_USPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
    "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "72": "PR",
}

# CBECS 2018 floorspace by activity, in square feet. Shares are the published
# floorspace shares of 96.4 billion. Health, food, public order, and vacant
# are a split of the published "all other" bucket, not separate CBECS headlines.
# Public-order area is folded into office. Manufacturing is outside CBECS.
ACTIVITIES: dict[str, dict] = {
    # naics: one code, or several summed. takeup is the insured share.
    "office_private": {
        "sqft": 0.17 * CBECS_SQFT_2018,
        "naics": ("51", "52", "53", "54", "55", "56"),
        "cost": 340, "contents": 0.25, "bi": 0.20, "takeup": 0.90,
    },
    "office_public": {
        "sqft": 1_500_000_000,
        "naics": ("92",),
        "cost": 300, "contents": 0.12, "bi": 0.05, "takeup": 0.35,
    },
    "mercantile": {
        "sqft": 0.11 * CBECS_SQFT_2018,
        "naics": ("44-45",),
        "cost": 230, "contents": 0.55, "bi": 0.22, "takeup": 0.90,
    },
    "warehouse": {
        "sqft": 0.18 * CBECS_SQFT_2018,
        "naics": ("42", "48-49"),
        "cost": 150, "contents": 0.45, "bi": 0.12, "takeup": 0.88,
    },
    "education": {
        "sqft": 0.14 * CBECS_SQFT_2018,
        "naics": ("61",),
        "cost": 310, "contents": 0.18, "bi": 0.08, "takeup": 0.55,
    },
    "lodging": {
        "sqft": 0.07 * CBECS_SQFT_2018,
        "naics": ("721",),
        "cost": 360, "contents": 0.22, "bi": 0.30, "takeup": 0.92,
    },
    "assembly": {
        "sqft": 0.07 * CBECS_SQFT_2018,
        "naics": ("71",),
        "cost": 280, "contents": 0.15, "bi": 0.12, "takeup": 0.75,
    },
    "religious": {
        "sqft": 0.06 * CBECS_SQFT_2018,
        "naics": ("813",),
        "cost": 260, "contents": 0.12, "bi": 0.05, "takeup": 0.70,
    },
    "service": {
        "sqft": 0.06 * CBECS_SQFT_2018 + 1_496_000_000,
        "naics": ("81",),
        "cost": 240, "contents": 0.25, "bi": 0.15, "takeup": 0.85,
    },
    "health": {
        "sqft": 5_500_000_000,
        "naics": ("62",),
        "cost": 480, "contents": 0.40, "bi": 0.25, "takeup": 0.85,
    },
    "food": {
        "sqft": 3_000_000_000,
        "naics": ("722",),
        "cost": 300, "contents": 0.35, "bi": 0.28, "takeup": 0.88,
    },
    "vacant": {
        "sqft": 2_000_000_000,
        "naics": ("00",),
        "cost": 180, "contents": 0.02, "bi": 0.00, "takeup": 0.40,
    },
    "manufacturing": {
        "sqft": MANUFACTURING_SQFT_2018,
        "naics": ("31-33",),
        "cost": 200, "contents": 0.60, "bi": 0.22, "takeup": 0.90,
    },
}


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:400]
        raise SystemExit(f"HTTP {exc.code} for {url}\n{body}") from exc


# CBP 2022 stores a sector as "44----" and a 3-digit industry as "721---".
CBP_CODE = {
    "00": ("------",),
    "31-33": ("31----", "32----", "33----"),
    "42": ("42----",),
    "44-45": ("44----", "45----"),
    "48-49": ("48----", "49----"),
    "51": ("51----",),
    "52": ("52----",),
    "53": ("53----",),
    "54": ("54----",),
    "55": ("55----",),
    "56": ("56----",),
    "61": ("61----",),
    "62": ("62----",),
    "71": ("71----",),
    "72": ("72----",),
    "721": ("721///",),
    "722": ("722///",),
    "81": ("81----",),
    "813": ("813///",),
    "92": ("92----",),
}


def num(value: object) -> float:
    if value is None or value == "":
        return 0.0
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    if parsed < 0:
        return 0.0
    return parsed


def money(value: float) -> int:
    if value <= 0:
        return 0
    return int(round(value))


def stream_county_table(url: str, columns: tuple[str, ...]) -> dict[str, dict[str, float]]:
    """County rows only (summary level 050) from an ACS table-based file."""
    print(f"Fetching {url.split('/')[-1]}...")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    out: dict[str, dict[str, float]] = {}
    with urllib.request.urlopen(req, timeout=180) as resp:
        header = resp.readline().decode("utf-8").strip().split("|")
        index = {name: pos for pos, name in enumerate(header)}
        missing = [col for col in columns if col not in index]
        if missing:
            raise SystemExit(f"{url} is missing columns {missing}")
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("0500000US"):
                continue
            parts = line.split("|")
            geoid = parts[0][9:]
            if len(geoid) != 5 or geoid[:2] not in FIPS_TO_USPS:
                continue
            out[geoid] = {col: num(parts[index[col]]) for col in columns}
    print(f"  {len(out)} counties")
    return out


def county_label(name: str) -> str:
    place = name.split(",")[0].strip()
    for suffix in (
        " County", " Parish", " Municipio", " Borough", " Census Area",
        " Municipality", " city and borough",
    ):
        if place.endswith(suffix):
            place = place[: -len(suffix)]
    return place.strip() or name


def ho_takeup(usps: str) -> float:
    if usps in HURRICANE_COAST:
        return 0.94
    if usps == "CA":
        return 0.86
    return 0.91


def land_share(usps: str, county_median: float, state_median: float) -> float:
    base = STATE_LAND.get(usps, 0.30)
    if county_median <= 0 or state_median <= 0:
        return base
    adjusted = base + 0.10 * math.log(county_median / state_median)
    return min(0.78, max(0.12, adjusted))


def structure_cost(usps: str, county_median: float, state_median: float) -> float:
    if county_median <= 0:
        county_median = state_median
    if county_median <= 0:
        county_median = 280_000
    share = land_share(usps, county_median, state_median or county_median)
    structure = county_median * (1.0 - share) * MEAN_OVER_MEDIAN * VALUE_TO_2026
    return min(1_800_000, max(70_000, structure))


ACS_BASE = (
    "https://www2.census.gov/programs-surveys/acs/summary_file/"
    f"{ACS_YEAR}/table-based-SF/data/5YRData"
)
B25032_COLUMNS = (
    "B25032_E001",
    "B25032_E003", "B25032_E004", "B25032_E005", "B25032_E006",
    "B25032_E007", "B25032_E008", "B25032_E009", "B25032_E010",
    "B25032_E011",
    "B25032_E014", "B25032_E015", "B25032_E016", "B25032_E017",
    "B25032_E018", "B25032_E019", "B25032_E020", "B25032_E021",
    "B25032_E022",
)


def load_names() -> dict[str, str]:
    url = (
        "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
        "2024_Gazetteer/2024_Gaz_counties_national.zip"
    )
    print("Fetching 2024 county gazetteer...")
    import io
    import zipfile
    archive = zipfile.ZipFile(io.BytesIO(fetch_bytes(url)))
    text = archive.read(archive.namelist()[0]).decode("utf-8", errors="replace")
    lines = text.splitlines()
    header = lines[0].lstrip("\ufeff").split("\t")
    geoid_at = header.index("GEOID")
    name_at = header.index("NAME")
    out: dict[str, str] = {}
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) <= max(geoid_at, name_at):
            continue
        out[parts[geoid_at].zfill(5)] = parts[name_at].strip()
    print(f"  {len(out)} names")
    return out


def load_acs() -> dict[str, dict[str, float]]:
    housing = stream_county_table(
        f"{ACS_BASE}/acsdt5y{ACS_YEAR}-b25001.dat", ("B25001_E001",)
    )
    values = stream_county_table(
        f"{ACS_BASE}/acsdt5y{ACS_YEAR}-b25077.dat", ("B25077_E001",)
    )
    tenure = stream_county_table(
        f"{ACS_BASE}/acsdt5y{ACS_YEAR}-b25032.dat", B25032_COLUMNS
    )
    geoids = set(housing) | set(values) | set(tenure)
    out: dict[str, dict[str, float]] = {}
    for geoid in geoids:
        row = {}
        row.update(housing.get(geoid, {}))
        row.update(values.get(geoid, {}))
        row.update(tenure.get(geoid, {}))
        out[geoid] = row
    return out


def load_cbp() -> dict[str, dict[str, tuple[float, float]]]:
    """geoid -> logical NAICS key -> (employment, establishments)."""
    import csv
    import io
    import zipfile
    url = (
        "https://www2.census.gov/programs-surveys/cbp/datasets/"
        f"{CBP_YEAR}/cbp{str(CBP_YEAR)[2:]}co.zip"
    )
    print(f"Fetching CBP {CBP_YEAR} county file...")
    archive = zipfile.ZipFile(io.BytesIO(fetch_bytes(url)))
    raw_codes = {code for codes in CBP_CODE.values() for code in codes}
    reverse = {code: key for key, codes in CBP_CODE.items() for code in codes}
    out: dict[str, dict[str, list[float]]] = defaultdict(dict)
    text = io.TextIOWrapper(archive.open(archive.namelist()[0]), encoding="utf-8", newline="")
    for row in csv.DictReader(text):
        code = row.get("naics") or ""
        key = reverse.get(code)
        if key is None:
            continue
        state = (row.get("fipstate") or "").zfill(2)
        county = (row.get("fipscty") or "").zfill(3)
        if state not in FIPS_TO_USPS or county == "000":
            continue
        geoid = state + county
        emp, est = num(row.get("emp")), num(row.get("est"))
        prev = out[geoid].get(key)
        if prev is None:
            out[geoid][key] = [emp, est]
        else:
            prev[0] += emp
            prev[1] += est
    # Suppressed employment still has an establishment count. Fill it with the
    # national employees-per-establishment for that industry.
    rate: dict[str, float] = {}
    totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for cells in out.values():
        for key, pair in cells.items():
            if pair[0] > 0 and pair[1] > 0:
                totals[key][0] += pair[0]
                totals[key][1] += pair[1]
    for key, (emp, est) in totals.items():
        if est > 0:
            rate[key] = emp / est
    for cells in out.values():
        for key, pair in cells.items():
            if pair[0] <= 0 and pair[1] > 0 and key in rate:
                pair[0] = pair[1] * rate[key]
    print(f"  {len(out)} counties with a matched industry")
    return {geoid: {key: (pair[0], pair[1]) for key, pair in cells.items()} for geoid, cells in out.items()}


def activity_stats(
    cells: dict[str, tuple[float, float]],
) -> dict[str, tuple[float, float]]:
    """Split parent sectors only when the detailed industry is absent."""
    def pair(key: str) -> tuple[float, float]:
        return cells.get(key, (0.0, 0.0))

    def add(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
        return (a[0] + b[0], a[1] + b[1])

    lodging, food = pair("721"), pair("722")
    if lodging[0] + food[0] <= 0:
        parent = pair("72")
        lodging = (parent[0] * 0.15, parent[1] * 0.15)
        food = (parent[0] * 0.85, parent[1] * 0.85)
    religious, service = pair("813"), pair("81")
    if religious[0] > 0:
        service = (max(0.0, service[0] - religious[0]), max(0.0, service[1] - religious[1]))
    elif service[0] > 0:
        religious = (service[0] * 0.15, service[1] * 0.15)
        service = (service[0] * 0.85, service[1] * 0.85)
    office = (0.0, 0.0)
    for key in ("51", "52", "53", "54", "55", "56"):
        office = add(office, pair(key))
    return {
        "office_private": office,
        # County Business Patterns does not publish government employment.
        # Spread the small public-building stock with total employment.
        "office_public": pair("00"),
        "mercantile": pair("44-45"),
        "warehouse": add(pair("42"), pair("48-49")),
        "education": pair("61"),
        "lodging": lodging,
        "assembly": pair("71"),
        "religious": religious,
        "service": service,
        "health": pair("62"),
        "food": food,
        "vacant": pair("00"),
        "manufacturing": pair("31-33"),
    }


def blank_bucket() -> dict[str, int]:
    return {"building": 0, "contents": 0, "bi": 0, "locations": 0}


def add_policy(
    bucket: dict[str, int],
    locations: float,
    building_each: float,
    contents_ratio: float,
    bi_ratio: float,
    contents_each: float = 0.0,
    bi_each: float = 0.0,
) -> None:
    if locations <= 0:
        return
    building = money(locations * building_each)
    if contents_each or bi_each:
        contents = money(locations * contents_each)
        bi = money(locations * bi_each)
    else:
        contents = money(building * contents_ratio)
        bi = money(building * bi_ratio)
    bucket["building"] += building
    bucket["contents"] += contents
    bucket["bi"] += bi
    bucket["locations"] += int(round(locations))


def residential_for(row: dict[str, str], structure: float, usps: str) -> dict[str, int]:
    takeup = ho_takeup(usps)
    owner_sf = num(row.get("B25032_E003")) + num(row.get("B25032_E004"))
    owner_24 = num(row.get("B25032_E005")) + num(row.get("B25032_E006"))
    owner_5 = (
        num(row.get("B25032_E007")) + num(row.get("B25032_E008"))
        + num(row.get("B25032_E009")) + num(row.get("B25032_E010"))
    )
    owner_mh = num(row.get("B25032_E011"))
    renter_14 = (
        num(row.get("B25032_E014")) + num(row.get("B25032_E015"))
        + num(row.get("B25032_E016")) + num(row.get("B25032_E017"))
    )
    renter_mh = num(row.get("B25032_E022"))
    renter_all = (
        renter_14 + renter_mh
        + num(row.get("B25032_E018")) + num(row.get("B25032_E019"))
        + num(row.get("B25032_E020")) + num(row.get("B25032_E021"))
    )
    occupied = num(row.get("B25032_E001"))
    housing = num(row.get("B25001_E001"))
    one_unitish = owner_sf + owner_mh + renter_14 + renter_mh
    vacant = max(0.0, housing - occupied)
    vacant_one = vacant * (one_unitish / occupied) if occupied else 0.0

    unit = structure
    condo_unit = min(450_000, max(80_000, structure * 0.45))
    mobile = min(140_000, max(55_000, structure * 0.35))
    bucket = blank_bucket()
    add_policy(bucket, owner_sf * takeup, unit, 0.40, 0.10)
    add_policy(bucket, owner_24 * takeup, unit * 0.80, 0.30, 0.08)
    add_policy(bucket, owner_mh * 0.70, mobile, 0.30, 0.08)
    # HO-6 is the interior only. The shell is commercial.
    add_policy(bucket, owner_5 * 0.85, condo_unit * 0.25, 0.0, 0.0, condo_unit * 0.20, condo_unit * 0.05)
    add_policy(bucket, renter_14 * 0.82, unit * 0.75, 0.05, 0.08)
    add_policy(bucket, renter_mh * 0.60, mobile * 0.80, 0.05, 0.05)
    add_policy(bucket, renter_all * RENTER_TAKEUP, 0.0, 0.0, 0.0, RENTER_CONTENTS, RENTER_ALE)
    add_policy(bucket, vacant_one * 0.50, unit * 0.85, 0.0, 0.0)
    return bucket


def commercial_habitational(row: dict[str, str], structure: float) -> dict[str, int]:
    """5+ unit buildings. Condo shells and apartment buildings. Tenant contents are residential."""
    condo_units = (
        num(row.get("B25032_E007")) + num(row.get("B25032_E008"))
        + num(row.get("B25032_E009")) + num(row.get("B25032_E010"))
    )
    apt_units = (
        num(row.get("B25032_E018")) + num(row.get("B25032_E019"))
        + num(row.get("B25032_E020")) + num(row.get("B25032_E021"))
    )
    condo_unit = min(450_000, max(80_000, structure * 0.45))
    apt_unit = min(400_000, max(90_000, structure * 0.50))
    buildings = (
        num(row.get("B25032_E007")) / 7 + num(row.get("B25032_E018")) / 7
        + num(row.get("B25032_E008")) / 14 + num(row.get("B25032_E019")) / 14
        + num(row.get("B25032_E009")) / 30 + num(row.get("B25032_E020")) / 30
        + num(row.get("B25032_E010")) / 100 + num(row.get("B25032_E021")) / 100
    )
    bucket = blank_bucket()
    add_policy(bucket, condo_units * 0.90, condo_unit * 0.75, 0.06, 0.08)
    add_policy(bucket, apt_units * 0.93, apt_unit, 0.08, 0.12)
    # Location count is buildings, not units. add_policy counted units, so replace it.
    bucket["locations"] = int(round(buildings * 0.92))
    return bucket


def commercial_from_cbp(
    geoid: str,
    usps: str,
    activity: dict[str, tuple[float, float]],
    national_emp: dict[str, float],
) -> tuple[dict[str, int], int]:
    cost_index = STATE_COST.get(usps, 0.95)
    bucket = blank_bucket()
    estab = 0.0
    for name, spec in ACTIVITIES.items():
        denom = national_emp.get(name, 0.0)
        cell = activity.get(name, (0.0, 0.0))
        if denom <= 0 or cell[0] <= 0:
            continue
        weight = cell[0] / denom
        sqft = spec["sqft"] * FLOORSPACE_GROWTH * weight * spec["takeup"]
        building = sqft * spec["cost"] * cost_index
        bucket["building"] += money(building)
        bucket["contents"] += money(building * spec["contents"])
        bucket["bi"] += money(building * spec["bi"])
        estab += cell[1] * spec["takeup"]
    bucket["locations"] = int(round(estab))
    return bucket, bucket["building"] + bucket["contents"] + bucket["bi"]


def fact_row(
    segment: str,
    level: str,
    geography_id: str,
    bucket: dict[str, int],
    *,
    state: str | None = None,
    state_name: str | None = None,
    county: str | None = None,
) -> dict:
    tiv = bucket["building"] + bucket["contents"] + bucket["bi"]
    row = {
        "datasetId": "ds-industry-ws",
        "portname": "01012026",
        "sourceServerName": "REFERENCE",
        "sourceDatabaseName": "Industry_US_Property_WS",
        "sourceTableName": "industry_exposure_estimate",
        "aggregation": level,
        "geographyLevel": level,
        "country": "US",
        "countryName": "United States",
        "geographyId": geography_id,
        "peril": "WS",
        "occupancy": "All",
        "occupancyGroup": "All",
        "occupancySegment": segment,
        "construction": "Mixed",
        "yearBuilt": "Mixed",
        "distanceToCoast": "Mixed",
        "geocodingQuality": "Mixed",
        "numberOfStories": "Mixed",
        "building": bucket["building"],
        "contents": bucket["contents"],
        "bi": bucket["bi"],
        "tiv": tiv,
        "explimGross": tiv,
        "explimNet": tiv,
        "locationCount": bucket["locations"],
        "accountCount": bucket["locations"],
        "invalidTiv": 0,
        "invalidCount": 0,
        "currency": "USD",
        "exposureDataCutoffDate": "2026-01-01T00:00:00Z",
    }
    if state:
        row["statecode"] = state
        row["stateName"] = state_name or state
    if county:
        row["county"] = county
        row["countyName"] = county
    return row


def sum_buckets(buckets: list[dict[str, int]]) -> dict[str, int]:
    out = blank_bucket()
    for bucket in buckets:
        for key in out:
            out[key] += bucket[key]
    return out


def main() -> None:
    acs = load_acs()
    names = load_names()
    cbp = load_cbp()
    activity_by_geo = {geoid: activity_stats(cells) for geoid, cells in cbp.items()}
    national_emp: dict[str, float] = defaultdict(float)
    for activity in activity_by_geo.values():
        for name, (emp, _est) in activity.items():
            national_emp[name] += emp
    print("National employment used to spread floorspace:")
    for name in ACTIVITIES:
        print(f"  {name}: {national_emp[name]:,.0f}")

    medians_by_state: dict[str, list[float]] = defaultdict(list)
    parsed: list[tuple[str, dict[str, float]]] = []
    for geoid, row in acs.items():
        usps = FIPS_TO_USPS.get(geoid[:2])
        if not usps:
            continue
        median = num(row.get("B25077_E001"))
        if median > 0:
            medians_by_state[usps].append(median)
        parsed.append((geoid, row))

    state_median = {
        usps: sorted(values)[len(values) // 2]
        for usps, values in medians_by_state.items()
        if values
    }

    state_names = {
        "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
        "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
        "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
        "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
        "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
        "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
        "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
        "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
        "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
        "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
        "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
        "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
        "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
    }
    counties: list[dict] = []
    for geoid, row in parsed:
        usps = FIPS_TO_USPS[geoid[:2]]
        median = num(row.get("B25077_E001"))
        structure = structure_cost(usps, median, state_median.get(usps, 0.0))
        res = residential_for(row, structure, usps)
        habit = commercial_habitational(row, structure)
        cbp_bucket, _cbp_tiv = commercial_from_cbp(
            geoid, usps, activity_by_geo.get(geoid, {}), national_emp,
        )
        com = sum_buckets([habit, cbp_bucket])
        counties.append({
            "geoid": geoid,
            "usps": usps,
            "name": county_label(names.get(geoid, f"County {geoid}")),
            "stateName": state_names.get(usps, usps),
            "housing": num(row.get("B25001_E001")),
            "res": res,
            "com": com,
            "cbp_tiv": cbp_bucket["building"] + cbp_bucket["contents"] + cbp_bucket["bi"],
        })

    # Counties the business-patterns file does not cover (often Puerto Rico)
    # borrow their state's commercial-per-home rate, then half of that, so a
    # missing file does not invent a full metro economy.
    by_state_rate: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for county in counties:
        if county["cbp_tiv"] > 0 and county["housing"] > 0:
            by_state_rate[county["usps"]].append((county["cbp_tiv"], county["housing"]))
    national_pairs = [pair for pairs in by_state_rate.values() for pair in pairs]
    national_rate = (
        sum(tiv for tiv, _h in national_pairs) / sum(h for _tiv, h in national_pairs)
        if national_pairs else 0.0
    )
    for county in counties:
        if county["cbp_tiv"] > 0 or county["housing"] <= 0:
            continue
        pairs = by_state_rate.get(county["usps"]) or []
        if pairs:
            rate = sum(tiv for tiv, _h in pairs) / sum(h for _tiv, h in pairs)
        else:
            rate = national_rate
        borrowed = money(county["housing"] * rate * 0.50)
        building = int(round(borrowed * 0.65))
        contents = int(round(borrowed * 0.25))
        county["com"]["building"] += building
        county["com"]["contents"] += contents
        county["com"]["bi"] += borrowed - building - contents
        if county["com"]["locations"] <= 0 and borrowed > 0:
            county["com"]["locations"] = max(1, borrowed // 2_000_000)

    def tiv_of(bucket: dict[str, int]) -> int:
        return bucket["building"] + bucket["contents"] + bucket["bi"]

    res_total = sum(tiv_of(c["res"]) for c in counties)
    com_total = sum(tiv_of(c["com"]) for c in counties)
    print(f"Counties: {len(counties)}")
    print(f"Residential TIV: ${res_total:,.0f}")
    print(f"Commercial TIV:  ${com_total:,.0f}")
    print(f"Bundled TIV:     ${res_total + com_total:,.0f}")

    if not (15e12 <= res_total <= 55e12):
        raise SystemExit(f"Residential total ${res_total:,.0f} is outside $15-55T")
    if not (8e12 <= com_total <= 45e12):
        raise SystemExit(f"Commercial total ${com_total:,.0f} is outside $8-45T")

    ranked = sorted(counties, key=lambda c: tiv_of(c["res"]) + tiv_of(c["com"]), reverse=True)
    print("Largest counties:")
    for county in ranked[:8]:
        print(
            f"  {county['name']}, {county['usps']}: "
            f"res ${tiv_of(county['res']):,.0f}  com ${tiv_of(county['com']):,.0f}"
        )
    miami = next(c for c in counties if c["geoid"] == "12086")
    glades = next(c for c in counties if c["geoid"] == "12043")
    if tiv_of(miami["res"]) < tiv_of(glades["res"]) * 20:
        raise SystemExit("Miami-Dade residential is not far above Glades County")

    facts: list[dict] = []
    csv_rows: list[dict] = []
    by_state: dict[str, dict[str, list[dict[str, int]]]] = defaultdict(
        lambda: {"RESIDENTIAL": [], "COMMERCIAL": []}
    )
    for county in counties:
        gid = f"US-{county['usps']}-{county['geoid']}"
        for segment, bucket in (("RESIDENTIAL", county["res"]), ("COMMERCIAL", county["com"])):
            facts.append(fact_row(
                segment, "COUNTY", gid, bucket,
                state=county["usps"], state_name=county["stateName"], county=county["name"],
            ))
            by_state[county["usps"]][segment].append(bucket)
        csv_rows.append({
            "geographyId": gid,
            "state": county["usps"],
            "county": county["name"],
            "residentialBuilding": county["res"]["building"],
            "residentialContents": county["res"]["contents"],
            "residentialBi": county["res"]["bi"],
            "residentialTiv": tiv_of(county["res"]),
            "residentialLocations": county["res"]["locations"],
            "commercialBuilding": county["com"]["building"],
            "commercialContents": county["com"]["contents"],
            "commercialBi": county["com"]["bi"],
            "commercialTiv": tiv_of(county["com"]),
            "commercialLocations": county["com"]["locations"],
            "bundledTiv": tiv_of(county["res"]) + tiv_of(county["com"]),
        })

    country = {"RESIDENTIAL": [], "COMMERCIAL": []}
    for usps, segments in sorted(by_state.items()):
        state_name = next(c["stateName"] for c in counties if c["usps"] == usps)
        for segment in ("RESIDENTIAL", "COMMERCIAL"):
            rolled = sum_buckets(segments[segment])
            facts.append(fact_row(
                segment, "STATE", f"US-{usps}", rolled,
                state=usps, state_name=state_name,
            ))
            country[segment].append(rolled)
    for segment in ("RESIDENTIAL", "COMMERCIAL"):
        facts.append(fact_row(segment, "COUNTRY", "US", sum_buckets(country[segment])))

    for row in facts:
        if row["tiv"] != row["building"] + row["contents"] + row["bi"]:
            raise SystemExit(f"TIV identity failed for {row['geographyId']} {row['occupancySegment']}")

    OUT_FACTS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FACTS.write_text(json.dumps(facts, separators=(",", ":")), encoding="utf-8")
    with OUT_CSV.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(csv_rows[0].keys()))
        writer.writeheader()
        writer.writerows(csv_rows)
    summary = {
        "datasetId": "ds-industry-ws",
        "currency": "USD",
        "expressedIn": "early 2026 USD",
        "acsYear": ACS_YEAR,
        "cbpYear": CBP_YEAR,
        "counties": len(counties),
        "residentialTiv": res_total,
        "commercialTiv": com_total,
        "totalTiv": res_total + com_total,
        "note": (
            "Residential and commercial are informational. "
            "Map TIV and impact losses use the bundled total."
        ),
    }
    OUT_SUMMARY.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_FACTS} ({OUT_FACTS.stat().st_size / 1_000_000:.1f} MB)")
    print(f"Wrote {OUT_CSV}")
    print(f"Wrote {OUT_SUMMARY}")


if __name__ == "__main__":
    main()
