# CALCULATIONS — the math (single source of truth)

All formulas live ONCE in `backend/app/services/calculations.py` +
`grouping.py`. Map, detail, pivot, and Excel export call the same functions.
Heaviest test coverage lives here (`backend/tests/test_calculations.py` +
`test_grouping.py`).

> Inputs are always `ExposureFactNormalized[]` from the provider (mock JSON
> or SQL cuts). Loading/caching is orthogonal — see
> [`MULTI_EDM.md`](./MULTI_EDM.md). Engineer overview:
> [`FOR_INTERNAL_DEVELOPERS.md`](./FOR_INTERNAL_DEVELOPERS.md).

## Universal principles

- **One source of truth.** Don't recompute a metric differently per surface.
- **No silent currency mixing.** Aggregations span only matching currencies,
  or an explicit conversion assumption is applied + surfaced via
  `WARN_CURRENCY_ASSUMED`.
- **`null`, not `0`, for "cannot compute."** Always pair with a warning code.
- **Divide-by-zero never raises** — return `None` + warning.
- **Aggregate, then divide.** Sum numerator and denominator at the target
  grain before taking ratios.

## Definitions

- **Selected deal** = the chosen `programmeId` / `chainId` / `chainIds[]` /
  `cedentId` (combined per its method).
- **Portfolio** = all **in-force BOUND** programmes when no selection target
  is supplied. Facts for those programmes are loaded in parallel (cache-aware)
  then combined under `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` when more than one
  programme is included.
- **Geography TIV** = `Σ fact.tiv` for a given `geographyId` at the active
  `aggregationLevel`.
- **Current viewed grain** = ordered tuple of active grouping dimensions
  (geography level + every pivot/filter dim). CONTRACTS.md §13.

## TIV / location count

```
TIV(scope, key) = Σ fact.tiv     where fact matches scope + filters + key
LocationCount(scope, key) = Σ fact.location_count
```

## Deal Share of Portfolio in Geography → `DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY`

```
= SelectedDealGeographyTIV / PortfolioGeographyTIV
```
Denominator 0 or missing → `null`.

## Geography Share of Total Portfolio → `GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO`

```
= PortfolioGeographyTIV / TotalAllLoadedPortfolioTIV
```

## Selected Deal Geography Concentration → `SELECTED_DEAL_GEOGRAPHY_CONCENTRATION`

```
= SelectedDealGeographyTIV / TotalSelectedDealTIV
```

> The three "share" metrics answer different questions; UI labels must stay
> distinct. The tooltip's Active-metric block plus the listed shares below
> already reinforce this.

## Client Market Share → `CLIENT_MARKET_SHARE`

```
= ClientTIV / RMS_IED_IndustryTIV
```
- Denominator must match geography and, where available, occupancy segment.
- No matching IED geography → share = `null` + `WARN_IED_DENOMINATOR_MISSING`
  (per-feature warning).
- `UNKNOWN` occupancy never force-mapped — reported separately.

## YoY Change → `YOY_CHANGE` *(historical: now driven by `yoyMode`)*

```
yoyChange = (CurrentValue − PriorValue) / PriorValue
```

| Condition | `yoyStatus` | `yoyChange` |
|---|---|---|
| current & prior present, prior ≠ 0 | `OK` | computed |
| current present, prior missing | `NEW` | `null` |
| prior present, current missing | `REMOVED` | `null` |
| prior = 0 | `NA` | `null` |
| no prior selected | — | `null` + `WARN_PRIOR_DATASET_NOT_SELECTED` |

**`yoyMode` is a view modifier**: when `true` and a comparison is set, the
response's `metricValue` is replaced by `yoy_change(current_metric,
prior_metric)` at the same grain. The original metric value rides as `tiv` /
etc. and `priorMetricValue` carries the prior so the tooltip can show
current / prior / Δ / Δ%.

**Approximation for ratio metrics in v1**: the prior-period denominator uses
the CURRENT portfolio (we don't carry a prior portfolio in v1). TIV and
LOCATION_COUNT are exact. Surface the limitation when needed.

## Group combination at view grain

Default for multi-peril selections: `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`.

```
For each group key g (= every active view dimension):
    combinedTIV(g) = MAX over distinct perils p of TIV(facts_p, g)
```

Examples (key = the grain):
- Viewing **State** → max per (state).
- Viewing **County + Occupancy** → max per (county, occupancy).

Rules:
- **Never sum** across distinct perils unless `SUM_DISTINCT_SEGMENTS` AND
  `distinctSegmentsConfirmed = true`.
- Max recomputed whenever the view grain changes.
- `SELECTED_EDM_AS_BASE`: exposure base = one EDM's TIV; others supply
  peril views only.
- `KEEP_PERILS_SEPARATE`: no combination; perils side by side.
- Location count under max-across-perils: **count of the EDM that supplied
  the max TIV** for that key (don't sum counts).

### Worked example

Members: WS, EQ, CS. Viewing by State:

| State | WS TIV | EQ TIV | CS TIV | combinedTIV (max) |
|---|---|---|---|---|
| FL | 12.4bn | 9.1bn | 7.8bn | **12.4bn** |
| CA | 3.0bn | 14.2bn | 2.1bn | **14.2bn** |

Summing would give FL = 29.3bn — overstated double-count. Max avoids it.

Asserted exactly by `backend/tests/test_grouping.py` against in-test fact
fixtures.

## Rounding & formatting

Calculations carry full precision. Round only for display (frontend) and in
export cells (raw values still available in the Raw Aggregated Data tab).
Ratios display as % to 1 decimal by default.

## Traceability

Every returned metric must be reconstructible from: source dataset(s) +
filters + this formula + currency (+ conversion assumption if any) +
combination method. The Excel export and tooltips expose enough of this to
audit a number.

## Hurricane impact (IBTrACS-driven)

`services/hurricane_impact.compute_impact(storm)` returns
`(impacts, footprint, inner_cone, outer_cone, outer_rings)`.

Filters applied to every storm fix before inclusion in the footprint:

- `wind_kt ≥ 64` (Cat 1 threshold)
- `status == "HU"` (true hurricane phase; excludes the extratropical "EX"
  phase where IBTrACS reports a much larger Rmax that isn't a hurricane
  wind field — Michael 2018 jumps from 15 nm to 120 nm post-EX)
- `lat/lon` inside US bbox

**Rmax (eyewall)** uses IBTrACS `USA_RMW` if present, else Willoughby
(2006) parametric fallback `Rmax(km) = 46.6 · exp(-0.0155·V_ms + 0.0169·|lat|)`.

**R64 (hurricane-wind extent)** uses IBTrACS `USA_R64_{NE,SE,SW,NW}` per
quadrant. `r64_at_bearing(quads, bearing)` linearly interpolates between
adjacent quadrant centers (NE=45°, SE=135°, SW=225°, NW=315°) so any
bearing yields a smooth lopsided value. Fallback (pre-~2004 storms with
no R64): symmetric 2.5×Rmax.

**County capture** — for each candidate county within a generous bbox:

    bearing_to_county = compass bearing from eye to centroid
    threshold = r64_at_bearing(quads, bearing_to_county, fallback=2.5×Rmax)
    capture iff haversine(eye, centroid) ≤ threshold
                AND fix.wind_kt ≥ 85   # MIN_IMPACT_WIND_KT

**TIV join** — fact rows joined by `geography_id`, summed per county and
also indexed per `dataset_id` for the per-programme breakdown in the
right-rail impact detail view.

## Layered loss scenarios

`services/layer_calc.run_scenario(layers, …)` runs deterministic XOL math:

    ground_up_loss = tiv × damage_ratio        (or supplied directly)
    loss_to_layer  = max(0, min(gross − ded, limit))
    ceded_loss     = loss_to_layer × share

Stacked layers evaluate INDEPENDENTLY against the same gross loss (no
cumulative carry-over). The reinsurer's total payout is the sum of
`ceded_loss` across the stack; the cedent's net loss is
`ground_up_loss − total_ceded`.

`run_sweep(layers, tiv)` runs a default damage-ratio series
`(0.5%, 1%, 2%, 5%, 10%, 15%, 20%, 30%, 50%, 75%, 100%)` to produce a
payout curve. Reinstatements / aggregate limits / event-vs-occurrence
wording are out of scope for v1.

## Hurricane loss bands (frontend, user-driven)

The backend's `/impact` response returns TIV per county but **no damage
ratios** — the user owns the loss model. Two zustand stores combine in
the browser to produce the displayed loss band:

- `damageAssumptions` (`frontend/src/state/damageAssumptions.ts`) — per
  SSHWS category {`mean`, `sd`} percentages. `applyAssumption(tiv,
  windKt, byCategory)` looks up the category from `windKt`, then returns
  a `LossBand` of `{ mean, low, high }` with `low = mean - sd` and
  `high = mean + sd`, clamped to `[0, 100]`. Persists to localStorage.
- `countyOverrides` (`frontend/src/state/countyOverrides.ts`) — per
  `(stormId, geoid)` exposed-fraction in `[0, 1]`. Applied as a scalar
  multiplier on the county's TIV BEFORE the damage assumption runs.
  Auto-prunes any override that's been set to 100% (the default).

The displayed county loss is therefore:

    effective_tiv = tiv * exposed_fraction
    loss_band(category) = effective_tiv * { mean - sd, mean, mean + sd } / 100

Neither store is sent back to the backend; persistence is per browser
in v1.

## Hazard climatology blend (tornado + hail)

Naive KDE of SPC point reports produces an obvious population-density
artifact — OKC, DFW, Atlanta, the I-35 corridor light up because reports
require humans to file them (Doswell 2007, Anderson et al. 2007).
Per-city deflation is the wrong fix — it trades urban DOTS for urban
HOLES at any city the deflator misses.

The shipped approach is a **climatology blend** that combines biased
point-history with a bias-free meteorology-based prior:

1. **Wide-kernel KDE of real SPC reports** (sigma 0.7°). Wider than the
   visual grid step (0.2°) so any single-city cluster dilutes across
   its ~50 mi region rather than forming a dot. Reports are weighted
   by:
   - Recency — tornado: 0.5× (1950) → 2.0× (2025); hail: 0.7× (1955) → 1.3× (2025).
   - Magnitude — tornado: EF3+ get `1 + 0.5·max(0, mag-2)` boost;
     hail: stones > 1″ get `1 + 0.5·(diam_in - 1)`, capped at 2.5×.

2. **Smooth climatology prior** (`backend/scripts/_climatology.py`).
   Encodes the published environmental-frequency surfaces as a bag of
   Gaussian anchors:
   - Tornado anchors from Brooks et al. 2003 + Tippett et al. 2015 mean-
     annual EF1+ density maps (Tornado Alley, Dixie Alley, FL sea-breeze,
     Plains).
   - Hail anchors from Cintineo et al. 2012 + Allen & Tippett 2015
     hail-day climatology (Hail Alley, Black Hills upslope, TX
     Panhandle).
   These have zero reporting bias because they're derived from
   atmospheric ingredients (CAPE × storm-relative helicity × shear), not
   point reports.

3. **Normalised blend** — each surface is normalised to its own max,
   then combined as:

        blended = 0.60 * climatology + 0.40 * historical

   Output is a 0-100 hazard index per cell. The climatology dominates
   so the surface has no urban artifacts of either sign; the historical
   40% lets local real-data deviations move the surface where they're
   physically meaningful (Black Hills hail, central-Florida tornado).

Wildfire uses the same KDE machinery on the WFIGS perimeter CSV but
**without** a climatology prior — WFIGS perimeters come from satellite
+ agency tracking (not point reports), so the bias is the opposite of
SPC reports (slightly biased AWAY from population since forests aren't
where people live densely). Each fire is weighted by acres burned,
capped at 300k per fire so mega-events don't blanket a region.

The build scripts (`backend/scripts/build_{tornado,hail,wildfire}_grid.py`)
emit `mockdata/hazard_*_grid.json` with `{stepDeg, cells}` shape. Re-bake
when the upstream shapefile updates or you change a tuning constant.

## Live wildfire overlay

`GET /api/wildfire/active` is a live-data endpoint distinct from the pre-baked
hazard grid above. It stitches two real sources at request time and applies
its own clustering pipeline. See `docs/API.md §Live wildfire overlay` for the
full request/response shape.

### Source 1: WFIGS burn-area perimeters

NIFC/WFIGS publishes the authoritative current fire perimeters via an ArcGIS
FeatureServer (no API key). Raw IR-mapped polygons can carry 60 000+ vertices
per fire; the service requests server-side generalisation (`maxAllowableOffset`
in degrees, default 0.005° ≈ 550 m) before serialisation, reducing payload
~70× with negligible shape distortion at mapping scales.

Only `attr_IncidentTypeCategory == "WF"` (wildfire) features are kept;
prescribed burns (`RX`) and other types are dropped.

### Source 2: NASA FIRMS satellite thermal anomalies

VIIRS 375 m (S-NPP + NOAA-20) and MODIS 1 km NRT products are fetched from
the FIRMS area CSV API. The API caps a single request at 5 consecutive days.
To support look-backs up to 30 days, the service chains consecutive ≤5-day
windows (most-recent window uses the FIRMS "last N days" form; earlier windows
supply an explicit `start_date`).

Requires `FIRMS_MAP_KEY` (free registration). Without the key the heat layer
returns empty; WFIGS perimeters are unaffected.

Confidence filtering: VIIRS reports `low/nominal/high`; MODIS reports 0–100
(mapped to `low < 30`, `nominal < 80`, `high ≥ 80`). Default filter is
`nominal`; `minFrp` drops detections below a fire-radiative-power threshold
(MW).

### Clustering: grid connected-components

Raw FIRMS detections are gridded at 0.02° (~2.2 km) and grouped into spatial
clusters via 8-connected component labelling (flood-fill). Each occupied cell
is a node; two cells are connected if they share any face or corner (8-way).

A component whose cell count is < `minCells` OR whose detection count is
< `minDetections` is discarded. This removes persistent point sources
(industrial flares, gas stacks) which appear in FIRMS as a single cell with
high detection counts but zero spatial spread.

The UI's **All / Small+ / Med+ / Large+** control maps to these thresholds:

| UI label | `minCells` | `minDetections` |
|---|---|---|
| All | 1 | 1 |
| Small+ | 2 | 4 |
| Med+ | 3 | 15 |
| Large+ | 5 | 40 |

Source: `MIN_SIZE_PARAMS` in `frontend/src/state/liveWildfire.ts`; parameters
are passed to the backend on every `GET /api/wildfire/active` call.

### Heat-shape footprint tracing (marching edges)

For each qualifying cluster, the service traces the outer boundary of the
**union of occupied grid cells** at 0.01° (~1.1 km, ≈ VIIRS pixel scale)
rather than computing a convex hull. This preserves concavities and unburned
interior gaps (ridges, green islands inside a perimeter) — features that matter
for exposure analysis.

Algorithm:

1. Assign each occupied cell four directed boundary half-edges (one per
   exposed face, oriented so the burned area lies on the left — CCW outer
   convention).
2. Walk the half-edge graph to extract closed rings.
3. Simplify collinear staircase vertices, then scale integer grid coordinates
   to lon/lat.
4. Classify and nest the rings (below), then emit GeoJSON `Polygon` (one outer
   ring plus ≥0 hole rings) or `MultiPolygon` (disconnected burned patches).

Fallback: if the marching-edge trace yields a degenerate result (< 4 vertices),
the service falls back to Andrew's monotone-chain convex hull over the cluster
points.

### Ring nesting (signed area)

Because the tracer keeps the burned area on the left, orientation alone
classifies a ring exactly: positive signed area (CCW) is an outer boundary,
negative (CW) is an unburned interior pocket. Each pocket is then assigned to
the smallest-area outer ring containing it, which satisfies RFC 7946 §3.1.6
winding and hole containment.

**Do not classify by ray-casting a ring vertex.** Every traced vertex sits on
the grid lattice, and two cells touching only at a corner share that exact
vertex — a point where point-in-polygon is undefined. Deciding nesting that
way misfiled disjoint lobes of a diagonal fire front as holes and silently
dropped their TIV from the rollup (a diagonal 8-cell front lost 2 cells, 25%
of its burned area). The containment probe therefore uses a point half a cell
to the *right* of a hole edge's midpoint — off-lattice, and inside the
unburned pocket by construction.

A pocket that cannot be placed under any outer ring is left filled rather than
discarded: over-stating burned area is the safe direction for an exposure
number, under-stating it is not.

### Display thinning

A 10-day CONUS FIRMS pull can exceed 50 000 detection points. The full point
set is used for shape construction; only the returned `activeFires` point list
is thinned to at most 8 000 points (evenly strided) for rendering. The
`counts.activeFiresTotal` field records the pre-thin count; `counts.activeFires`
records the displayed count. Heat shapes are built before thinning and are
therefore complete.

Shapes are capped separately at 2 000, keeping the largest by detection count.
At `minCells = 1` every isolated detection becomes its own polygon, so a
fire-season CONUS pull can otherwise emit tens of thousands. Truncation is
reported in `notes[]`.

## Wildfire exposed TIV (synthetic point method)

`POST /api/wildfire/exposure` reports TIV inside a fire polygon broken down by
client. See also `docs/API.md §POST /api/wildfire/exposure`.

**The result is labelled `synthetic: true` because the v1 exposure data plane
is county-aggregated.** The facts files carry no location coordinates — the
finest grain available is the county, and each county holds many rows (one per
peril × occupancy × construction × … segment). As shipped that is 3 956 COUNTY
rows over 1 184 distinct counties across the 7 in-portfolio datasets.

### Combining rows to a per-county TIV (rules 3+4)

Rows are folded to `(client, county)` before any point is synthesised:

1. Sum within a peril — a peril's rows are disjoint segments, so summing them
   is the correct combination at this grain.
2. **Take the max across perils *and* across treaty years** for the same
   client. Never sum. A cedent carrying WS+EQ+CS on one EDM, or renewing the
   same slot in consecutive years, appears as several datasets under one
   `cedentName`; summing reported it at a multiple of its real exposure.
   Measured on the shipped mock plane, Farmers Group in LA County (`06037`)
   summed to USD 14.60bn against a correct max of USD 9.10bn — a **1.60×
   overstatement** that fed straight into the XOL layer calc.

This is CLAUDE.md rules 3+4 applied at the finest grain this plane has.

If the rows span more than one currency they are not combinable (rule 5): the
rollup is reported as 0 with an entry in `warnings[]` rather than silently
mixed.

### Synthetic location generation

For each `(client, county)` TIV from the step above:

1. Look up the county centroid from the us-atlas TopoJSON index
   (`county_centroids()` in `hurricane_impact.py`).
2. Generate `_POINTS_PER_COUNTY = 4` deterministic jitter offsets using
   SHA-1 of `"{client}:{geoid}:{i}"`. The jitter radius is ±0.10° (~11 km).
3. Assign each synthetic point `tiv / 4` and the cedent name as `client`.

The county centroid plus deterministic jitter ensures the same polygon always
returns the same TIV (no random sampling), making the output auditable and
reproducible for any given data cut.

### Combining several selected fires

`combined` in the response is the union across every submitted polygon with
each synthetic location counted **once**. Selecting an official perimeter
together with the heat shape covering the same fire is the natural thing for
an underwriter to do, and summing the per-polygon totals would double-count
every location in the overlap. Clients must use `combined` rather than summing
`results`.

### Point-in-polygon test

A spatial grid index (cell size 0.5°) limits candidate testing to points
whose cell overlaps the polygon's bounding box. The polygon test uses the
ray-casting (even-odd) algorithm; multi-ring polygons with holes correctly
exclude interior hole regions.

### Accuracy characterisation

Because county TIV is distributed as 4 points within the county bounding area:

- A small fire that clips only part of a county will capture either 0 or a
  multiple of `tiv/4`, depending on whether any of the 4 synthetic points fall
  inside the perimeter. The error is bounded by one county's TIV (the largest
  partially-intersected county).
- A large fire spanning many complete counties will be accurate to within the
  partial-county error at each edge county.

**This is an estimation method, not a precise exposure report.** It is
appropriate for preliminary triage of fire exposure; it is not a substitute
for running a real location-level accumulation query.

### Resolution floor — when a zero means "unmeasurable"

4 points scattered over a ±0.10° box put one synthetic location every

```
resolution_deg2 = (2 × 0.10)² / 4 = 0.01 deg²
```

so a polygon smaller than roughly 0.01 deg² expects **fewer than one point**
even when it sits directly over dense exposure. Its result is structurally zero,
and that zero carries no information about the exposure underneath it.

This bites the flood inundation layer specifically. A modelled extent is river
corridors, not areas: measured on a Houston bbox, the whole extent was
8×10⁻⁵ deg² against a 0.72 deg² viewport — roughly 1/100th of the floor.
`POST /api/flood/inundation/exposure` therefore compares the dissolved extent
area against `wildfire_exposure.resolution_deg2()` and sets `belowResolution` on
the response; the UI renders "not measurable" in place of the `$0` an
underwriter would otherwise read as "no exposure here". Wildfire perimeters and
NWS alert polygons are both well above the floor, so they are unaffected.

The floor is computed from `_POINTS_PER_COUNTY` and `_JITTER_DEG` rather than
written down, so it follows the generator automatically. Real location-level
data (see *Upgrade path*) removes the floor entirely.

### Upgrade path

`_load_locations()` in `backend/app/services/wildfire_exposure.py` is the
documented single swap point. Replace its county-fact iteration with a
query against individual-location data (lat/lon, TIV, cedent); the
point-in-polygon rollup below that function is unchanged.
