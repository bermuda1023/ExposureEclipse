/**
 * Methodology & data-sources reference.
 *
 * A single, structured page detailing every calculation, every external
 * data source, and every assumption baked into Peril Vista. Intended
 * to be the authoritative "how does this number get produced" resource
 * for anyone who has to defend the platform in a client conversation.
 *
 * Deliberately self-contained (no data loading, no state) so it renders
 * instantly and is straightforward to keep in sync with the code that
 * actually produces the numbers.
 */

import { BRAND } from "../brand";
import { BrandMark } from "../components/layout/BrandMark";

export function Methodology() {
  return (
    <div
      style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: "32px 24px 96px",
        fontSize: "0.9rem",
        lineHeight: 1.55,
        color: "var(--ink-900)",
      }}
    >
      <TopNav />

      <header style={{ marginBottom: 32, display: "flex", alignItems: "flex-start", gap: 14 }}>
        <BrandMark size={40} />
        <div>
        <div
          style={{
            fontSize: "0.7rem",
            color: "var(--ink-500)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {BRAND.name}
        </div>
        <h1 style={{ margin: "6px 0", fontSize: "1.8rem" }}>
          Methodology &amp; data sources
        </h1>
        <p style={{ color: "var(--ink-600)", marginTop: 8 }}>
          Everything on this page is derived directly from what the code does.
          When the code changes, this page should change with it — treat any
          drift as a bug.
        </p>
        </div>
      </header>

      <TOC />

      <Section id="exposure-map" title="Exposure map (choropleth)">
        <p>
          The core exposure map renders TIV, GWP, GNP, EPA, PML and
          policy-count metrics as a vector-tileset choropleth at{" "}
          <b>state or county</b> resolution.
        </p>
        <SubHead>Data plane</SubHead>
        <ul>
          <li>
            Frontend never touches raw data. Every value flows{" "}
            <code>Frontend → FastAPI → Provider → mock JSON</code>.
          </li>
          <li>
            Default provider is <code>mock</code> (files under{" "}
            <code>mockdata/</code>). Alternative providers are{" "}
            <code>hybrid</code> and <code>sqlserver</code> — both read the same
            pre-aggregated cut shape from real EDM databases via the
            multi-host connection registry (see docs/MULTI_EDM.md).
          </li>
          <li>
            Facts load lazily by <code>datasetId</code> through{" "}
            <code>FactCache</code>. No dataset is parsed until its rows are
            actually needed for a view.
          </li>
        </ul>
        <SubHead>Peril combination rule</SubHead>
        <p>
          Default combination is{" "}
          <code>MAX_ACROSS_PERILS_AT_VIEW_GRAIN</code>. TIV is never summed
          across distinct perils unless the caller explicitly opts into{" "}
          <code>SUM_DISTINCT_SEGMENTS</code> with{" "}
          <code>distinctSegmentsConfirmed=true</code>. Max-across-perils is
          computed at the viewed grain — every active grouping dimension
          (geography + pivot dims) participates.
        </p>
        <SubHead>Geometry</SubHead>
        <ul>
          <li>
            State + county polygons are Mapbox vector tilesets, defined in{" "}
            <code>frontend/src/components/Map/MapView.tsx</code>. Tiles carry
            promoted IDs so per-feature choropleth fills can be joined
            client-side.
          </li>
          <li>
            County reference metadata (population, households, avg
            replacement cost) is derived from{" "}
            <code>us-atlas TopoJSON</code> for centroids plus ~35 curated
            census-style rows and deterministic synthesis for the remainder.
          </li>
        </ul>
        <Sources>
          <li>
            Mapbox vector tilesets — proprietary, tokenized. Token comes from
            env (no hard-coded token in code).
          </li>
          <li>
            <a
              href="https://github.com/topojson/us-atlas"
              target="_blank"
              rel="noreferrer"
            >
              us-atlas TopoJSON
            </a>{" "}
            (MIT) — county / state centroids.
          </li>
        </Sources>
      </Section>

      <Section id="hurricane-impact" title="Hurricane impact engine">
        <p>
          County TIV under a storm wind field. Two entry points, two track
          sources — they must not be mixed.
        </p>
        <SubHead>Which track is used</SubHead>
        <ul>
          <li>
            <b>Live storm → Run county impact</b>: the current NHC official
            forecast (OFCL / CARQ a-deck, tau 0–120 h) plus the NHC
            forecast-track KMZ for positions. Wind size comes from that
            advisory&apos;s operational <code>RMW</code> and 34/50/64-kt
            quadrant radii — the same field Tropical Tidbits draws. IBTrACS /
            HURDAT is <em>not</em> consulted (the current year is not in
            those archives, and a lookup would pull a 70 MB CSV).
          </li>
          <li>
            <b>Historical hurricane browser</b>: IBTrACS v04r01 North
            Atlantic CSV (NCEI), process-lifetime cache. Tracks are 3-hour
            interpolated USA fixes with recon <code>Rmax</code> and
            per-quadrant <code>R64</code>. Missing recon falls back to
            Willoughby et al. (2006).
          </li>
        </ul>
        <SubHead>Wind-field construction</SubHead>
        <ul>
          <li>
            <b>Inner Rmax</b> (eyewall): live NHC <code>RMW</code> when
            present; else IBTrACS recon; else Willoughby:
            <Equation>
              Rmax(km) = 46.6 · exp(−0.0155 · V<sub>max</sub>(m/s) + 0.0169
              · |lat|)
            </Equation>
            with a floor of 8 nm.
          </li>
          <li>
            <b>Outer asymmetric R64</b>: NHC a-deck quadrants (NE/SE/SW/NW)
            for live storms; IBTrACS quadrants for historical storms;
            otherwise symmetric <code>2.5 × Rmax</code>.
          </li>
          <li>
            Between fixes, quadrant radii are bearing-interpolated to the
            angle from the storm center to each candidate county centroid.
          </li>
        </ul>
        <SubHead>County capture</SubHead>
        <ul>
          <li>
            A county is captured under a storm if its centroid falls inside
            the interpolated R64 polygon at any fix along the track.
          </li>
          <li>
            Minimum wind for the impact set is{" "}
            <code>MIN_IMPACT_WIND_KT = 85 kt</code> (inside Cat 2). Below
            that the storm's wind is treated as noise — the visual footprint
            still draws down to TS strength but counties don't count as
            impacted.
          </li>
          <li>
            The visualization footprint spans the entire cyclone lifecycle
            (including post-landfall while still ≥ Cat 1) so the user can
            see how the field grew and shrank.
          </li>
        </ul>
        <SubHead>Loss modelling</SubHead>
        <ul>
          <li>
            User-editable per-SSHWS-category damage-ratio inputs (mean +
            SD) live in the <code>damageAssumptions</code> Zustand store.
            Together they produce a probabilistic loss band per storm.
          </li>
          <li>
            Per-county <b>exposed-fraction overrides</b>{" "}
            (<code>countyOverrides</code>) let the underwriter override
            partial-county exposure. Both stores persist to localStorage.
          </li>
        </ul>
        <Sources>
          <li>
            <a
              href="https://www.ncei.noaa.gov/products/international-best-track-archive"
              target="_blank"
              rel="noreferrer"
            >
              NOAA IBTrACS v04r01 (Public Domain)
            </a>
            — historical browser only.
          </li>
          <li>
            NHC ATCF a-decks (
            <code>ftp.nhc.noaa.gov/atcf/aid_public/</code>
            ) — live official track + RMW / R34 / R50 / R64.
          </li>
          <li>
            Willoughby, H.E., Darling, R.W.R., Rahn, M.E. (2006).{" "}
            <i>Parametric representation of the primary hurricane vortex.</i>{" "}
            Monthly Weather Review, 134(4).
          </li>
        </Sources>
      </Section>

      <Section id="live-storms" title="Live-storm overlay">
        <p>
          When an Atlantic system is active, the overlay pulls NHC advisories
          and observation layers. There is no replay/demo storm in the
          picker — empty basin is empty.
        </p>
        <SubHead>Panel chrome</SubHead>
        <ul>
          <li>
            The live-storm panel is not glued to the map. <b>Collapse</b>{" "}
            shrinks it to a one-line bar; <b>→ detail</b> moves the whole
            panel into the right-hand Detail rail so the map is clear.
            Overlays stay until ✕. The toolbar chip only shows/hides chrome;
            it does not clear the storm.
          </li>
        </ul>
        <SubHead>Storm list</SubHead>
        <ul>
          <li>
            Active storms: <code>https://www.nhc.noaa.gov/CurrentStorms.json</code>{" "}
            — free, no auth. Center, motion, intensity, GIS product URLs.
          </li>
          <li>
            Invests (CY 90–99): probed from ATCF a-decks in parallel.
            Model tracks and ensemble strike probability work; NHC cone /
            watches / surge do not until an advisory exists.
          </li>
        </ul>
        <SubHead>Observed &amp; forecast tracks</SubHead>
        <ul>
          <li>
            <b>Observed</b>: current NHC fix plus two back-projected trailing
            fixes from the reported motion vector, so the storm reads as
            more than a lone dot.
          </li>
          <li>
            <b>Forecast track</b>: parsed directly from NHC's forecast-track
            KMZ (<code>trackCone.kmzFile</code> and{" "}
            <code>forecastTrack.kmzFile</code>). Points are the actual
            forecaster-issued fixes at T+12/24/36/48/72/96/120 hr, along
            with the projected intensity and valid time.
          </li>
          <li>
            <b>Forecast evolution ("ghost tracks")</b>: prior advisories are
            fetched by walking the ATCF advisory number backward (handling
            both full <code>NNN</code> and intermediate <code>NNNA</code>{" "}
            forms). Up to 4 priors are added so the user can see how the
            forecast has been trending across advisories.
          </li>
          <li>
            <b>Cone of uncertainty</b>: the swept-circle envelope from NHC's{" "}
            <code>trackCone.kmzFile</code>. Parsed with stdlib{" "}
            <code>zipfile</code> + <code>xml.etree</code>.
          </li>
          <li>
            All KMZ parses are lru-cached by URL. Failed fetches degrade to
            an empty result — the bundle never 500s when NHC hiccups.
          </li>
        </ul>
        <SubHead>Modelled wind field</SubHead>
        <ul>
          <li>
            Same Rmax / asymmetric R64 cone builder as historical impact,
            applied to the observed track (tau 0) and the latest official
            forecast (tau 12…120).
          </li>
          <li>
            Radii come from the latest OFCL/CARQ a-deck: <code>RMW</code>{" "}
            and 34/50/64-kt NE/SE/SW/NW quadrants. IBTrACS is not queried
            for live storms. If a lead time has no radii, Willoughby +
            symmetric <code>2.5 × Rmax</code> fills the gap.
          </li>
          <li>
            Fixes below <b>25 kt</b> are dropped so the cone follows
            weakening below TS strength.
          </li>
        </ul>
        <SubHead>Model ensemble &amp; strike probability</SubHead>
        <ul>
          <li>
            ATCF a-deck spaghetti (GFS, ECMWF, GEFS, AI models, NHC
            official) for the latest init cycle. Ensemble strike
            probability is P(track within a nautical-mile threshold) by
            county.
          </li>
        </ul>
        <SubHead>Formation outlook (TWO)</SubHead>
        <ul>
          <li>
            NHC Tropical Weather Outlook — basin-wide, no storm required.
            Yellow / orange / red = low / medium / high chance of
            development in 7 days.
          </li>
        </ul>
        <SubHead>Peak storm surge</SubHead>
        <ul>
          <li>
            Parsed from NHC's <code>peakSurgeKML</code> product — one KML per
            storm with coloured coastal polygons per surge band (1-2 ft, 3-6
            ft, ...).
          </li>
          <li>
            Empty when the storm doesn't publish a surge product
            (open-ocean systems, weak systems).
          </li>
        </ul>
        <SubHead>NWS active alerts in the cone</SubHead>
        <ul>
          <li>
            Fetched from <code>api.weather.gov</code>. Filtered to the
            state list overlapping the storm's bbox to keep the response
            small.
          </li>
        </ul>
        <SubHead>Hurricane hunters (when a plane is in the storm)</SubHead>
        <ul>
          <li>
            NHC HDOB (URNT15) every ~30 s along the flight track. Surface
            wind is SFMR when the QC flag says the radiometer is good;
            otherwise 0.80 × flight-level wind (typical 700 mb reduction).
            Points with a bad lat/lon flag are dropped. SFMR in rain
            ≥ 20 mm/h is discarded.
          </li>
          <li>
            Vortex Data Message (URNT12) — latest center fix, min pressure,
            max flight-level wind — plotted as a VDM marker.
          </li>
          <li>
            Live NHC text pages only hold the current bulletin, so we also
            pull the last 8 hours from the recon archive. Empty when no
            mission is flying (the layer chip greys out).
          </li>
        </ul>
        <SubHead>Sea-surface temperature backdrop</SubHead>
        <ul>
          <li>
            JPL MUR SST v4.1 (~1 km native) via ERDDAP CSV, subsampled to an
            adaptive lat/lon grid (0.05 → 0.5°) sized to the bbox.
          </li>
          <li>
            Cells above 26.5 °C are flagged as "favorable for
            intensification" per the historical rule of thumb.
          </li>
        </ul>
        <Sources>
          <li>
            NHC <code>CurrentStorms.json</code>,{" "}
            <code>storm_graphics/api/</code> KMZ/KML, ATCF a-decks (Public Domain).
          </li>
          <li>
            NWS <code>api.weather.gov</code> alerts, observations (Public
            Domain).
          </li>
          <li>
            NDBC <code>latest_obs.txt</code> (Public Domain).
          </li>
          <li>
            NHC aircraft recon: live URNT15 HDOB + URNT12 vortex messages,
            plus the last 8 hours of the{" "}
            <code>/archive/recon/</code> AHONT1 / REPNT2 files (Public Domain).
          </li>
          <li>
            <a
              href="https://podaac.jpl.nasa.gov/dataset/MUR-JPL-L4-GLOB-v4.1"
              target="_blank"
              rel="noreferrer"
            >
              JPL MUR v4.1 SST via ERDDAP
            </a>{" "}
            (Public Domain, NASA/JPL).
          </li>
        </Sources>
      </Section>

      <Section id="wind-heatmap" title="Interpolated surface-wind heatmap">
        <p>
          The wind speed map ("windy.com-style") is our own IDW blend of NDBC
          buoy + NWS land-station observations, plus hurricane-hunter HDOB
          when a USAF WC-130 or NOAA P-3 / G-IV is in the storm, cleaned and
          interpolated to a uniform grid.
        </p>
        <SubHead>Cleaning pipeline</SubHead>
        <ol>
          <li>
            <b>Age</b>: drop buoy/land observations older than 4 hours.
            Recon HDOB is kept for 8 hours (a typical mission is longer than
            the buoy window).
          </li>
          <li>
            <b>Absurdity</b>: drop wind_kt above 200 kt (world-record
            sustained wind is ~220 kt — anything higher is anemometer
            corruption).
          </li>
          <li>
            <b>Dead-sensor zero</b>: 0-kt readings whose local (1.5°)
            neighborhood median is above 5 kt are dropped as stuck-at-zero
            rather than pulling the IDW mean toward zero.
          </li>
          <li>
            <b>Outlier vs neighbourhood</b>: readings whose value deviates
            from the local median by more than 25 kt are dropped. Catches
            single-station lightning spikes and spurious readings without
            requiring per-station QC flags.
          </li>
        </ol>
        <SubHead>Interpolation</SubHead>
        <ul>
          <li>
            <b>Grid step</b>: fixed 0.5° (aligned with the GFS/ECMWF model
            grids so obs-vs-model diffs are cell-to-cell).
          </li>
          <li>
            <b>Method</b>: inverse-distance weighted (power = 2),
            longitude-scaled by cos(lat) for correct geographic distance.
            Influence radius = 3° (~330 km) for buoys and land stations;
            0.8° (~90 km) for recon so an eyewall transect does not smear
            across the basin. Cells with zero obs in radius are omitted —
            the renderer paints "no data" as a gap rather than
            extrapolating nonsense.
          </li>
          <li>
            <b>Direction</b>: interpolated using a parallel IDW on the u/v
            vector components. Averaging angles directly breaks at the
            0°/360° wraparound; vector-mean handles convergent and
            divergent flow correctly.
          </li>
        </ul>
        <SubHead>Confidence heuristic</SubHead>
        <p>
          Composite of three signals, multiplied so one weak signal drags
          the whole score down:
        </p>
        <ul>
          <li>
            <b>Distance</b>: full score when nearest contributing obs is
            within ~0.7° (one grid cell), fading linearly to zero at the
            radius edge (3°).
          </li>
          <li>
            <b>Count</b>: 2+ contributors = full trust. Solo contributor is
            rated 0.7 so a lucky single station doesn't max out the score.
          </li>
          <li>
            <b>Agreement</b>: standard deviation of contributor speeds.
            Tight agreement (&lt; 5 kt) = full, loose (≥ 20 kt) = 0. High
            disagreement usually means the cell straddles a real gradient
            (eyewall vs eye) and the IDW mean is misleading.
          </li>
        </ul>
        <p>Frontend badges: HIGH ≥ 0.5, MED ≥ 0.25, LOW &lt; 0.25.</p>
        <SubHead>Click-to-inspect popup</SubHead>
        <ul>
          <li>
            Shows the observed speed (kt / mph / km/h), compass direction,
            confidence badge with raw %, nearest-obs distance, and a
            clickable "N sources" link that highlights the actual
            contributing stations on the map.
          </li>
          <li>
            Fires a background fetch to{" "}
            <code>/api/live/wind-forecast?lat=…&amp;lon=…</code> for GFS +
            ECMWF at the same point, so obs vs model agreement is visible
            side-by-side.
          </li>
          <li>
            "Δ vs model mean" line flags obs-vs-model disagreement: green
            if within 5 kt, orange 5–15, red &gt; 15 (worth flagging).
          </li>
        </ul>
        <SubHead>Source mode selector</SubHead>
        <p>
          The panel exposes six modes: <b>Obs</b>, <b>GFS</b>, <b>ECMWF</b>,
          and three <b>diff</b> views (Obs−GFS, Obs−ECMWF, GFS−ECMWF). GFS
          / ECMWF grids are fetched from Open-Meteo on demand and cached
          per bbox. Diff view uses a diverging blue → white → red palette
          centered on 0.
        </p>
        <Sources>
          <li>
            <a href="https://www.ndbc.noaa.gov/" target="_blank" rel="noreferrer">
              NOAA NDBC
            </a>{" "}
            <code>latest_obs.txt</code> — buoy observations (Public Domain).
          </li>
          <li>
            <a href="https://www.nhc.noaa.gov/recon.php" target="_blank" rel="noreferrer">
              NHC aircraft reconnaissance
            </a>{" "}
            — HDOB (SFMR + flight-level) and vortex data messages (Public Domain).
          </li>
          <li>
            <a
              href="https://www.weather.gov/documentation/services-web-api"
              target="_blank"
              rel="noreferrer"
            >
              NWS api.weather.gov
            </a>{" "}
            — land-station latest observations (Public Domain).
          </li>
          <li>
            <a href="https://open-meteo.com" target="_blank" rel="noreferrer">
              Open-Meteo
            </a>{" "}
            — free proxy for GFS (<code>gfs_seamless</code>) and ECMWF (
            <code>ecmwf_ifs025</code>) hourly wind at 10 m. CC-BY-4.0.
          </li>
          <li>
            <a
              href="https://www.nco.ncep.noaa.gov/pmb/products/gfs/"
              target="_blank"
              rel="noreferrer"
            >
              NOAA GFS
            </a>{" "}
            — upstream model, Public Domain.
          </li>
          <li>
            <a
              href="https://www.ecmwf.int/en/forecasts/datasets"
              target="_blank"
              rel="noreferrer"
            >
              ECMWF Open Data
            </a>{" "}
            — upstream model, CC-BY-4.0.
          </li>
        </Sources>
      </Section>

      <Section id="hazard-grids" title="Hazard climatology grids (tornado / hail / wildfire)">
        <p>
          Grids are built <b>offline</b> and baked into{" "}
          <code>mockdata/hazard_*_grid.json</code>. The API just serves the
          static grid. Tornado and hail blend historical events with a
          smooth climatology prior; wildfire uses acres-weighted KDE of
          historical perimeters.
        </p>
        <SubHead>Tornado + hail</SubHead>
        <ul>
          <li>
            60% climatology prior / 40% historical KDE. The climatology
            component uses Brooks/Tippett/Cintineo grids; the historical
            component KDE-smooths SPC SVRGIS events, magnitude-weighted
            (EF-scale for tornado, size-in-inches for hail) and
            recency-weighted (recent events count more).
          </li>
          <li>
            No per-city bias correction. Grid resolution: 0.2° lat/lon.
          </li>
        </ul>
        <SubHead>Wildfire</SubHead>
        <ul>
          <li>
            Acres-weighted KDE of WFIGS perimeters. Grid endpoint is live;
            the UI chip is currently hidden pending further review.
          </li>
        </ul>
        <Sources>
          <li>
            <a href="https://www.spc.noaa.gov/gis/svrgis/" target="_blank" rel="noreferrer">
              SPC SVRGIS
            </a>{" "}
            — tornado + hail history shapefiles (Public Domain).
          </li>
          <li>
            Brooks, H. E., Doswell III, C. A., &amp; Kay, M. P. (2003).
            Climatological estimates of local daily tornado probability.
          </li>
          <li>
            Tippett, M. K. et al. — regression climatology for severe
            weather.
          </li>
          <li>
            Cintineo, J. L. et al. — hail severity climatology.
          </li>
          <li>
            <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noreferrer">
              NIFC WFIGS
            </a>{" "}
            — wildfire perimeters (Public Domain).
          </li>
        </Sources>
      </Section>

      <Section id="layers-engine" title="Layer / XOL calculation engine">
        <p>
          <code>POST /api/calc/layers</code> runs deterministic XOL
          scenarios. Given a TIV + a stack of{" "}
          <code>(deductible, limit, share)</code> tuples, the engine walks the
          default damage-ratio sweep to produce a payout curve per layer.
          The frontend UI for this engine is not yet wired.
        </p>
        <ul>
          <li>
            Loss to a layer = <code>max(0, min(TIV × DR − deductible, limit)) × share</code>.
          </li>
          <li>
            Currency rides on every monetary value. Mixed-currency scenarios
            block or warn — nothing silently converts.
          </li>
        </ul>
      </Section>

      <Section id="observability" title="Observability &amp; edge behaviour">
        <ul>
          <li>
            All third-party fetches (NHC, NWS, NDBC, NCEI, Open-Meteo,
            ERDDAP) run inside try/except. On failure the affected slice
            degrades to an empty result — the rest of the bundle stays
            up.
          </li>
          <li>
            IBTrACS is not fetched for the live picker or live county
            impact. A slow NCEI response cannot take down live-storm
            mode. Historical impact still uses the cached IBTrACS parse.
          </li>
          <li>
            <code>fetch_prior_forecast_tracks</code> fires its candidate
            URLs in parallel via a ThreadPoolExecutor. What used to be up
            to 8 sequential HTTP GETs is now a single wall-clock round
            trip.
          </li>
          <li>
            Model-grid Open-Meteo requests are chunked (max 100 coords per
            URL) and dispatched in parallel with lru caching per (bbox,
            model).
          </li>
        </ul>
      </Section>

      <Section id="the-rules" title="The ten operating rules">
        <ol>
          <li>Frontend never touches data sources.</li>
          <li>Mock data first; providers are pluggable behind the same ABC.</li>
          <li>
            Default group combination is <code>MAX_ACROSS_PERILS_AT_VIEW_GRAIN</code>.
          </li>
          <li>Max-across-perils is computed at the current viewed grain.</li>
          <li>Currency rides on every monetary value.</li>
          <li>
            Every displayed number is traceable to source(s) → filters →
            formula → currency → warnings.
          </li>
          <li>Don't guess business logic — pick a safe default and mark it.</li>
          <li>No hard-coded SQL table names, support email, or Mapbox token.</li>
          <li>Excel export accuracy &gt; formatting.</li>
          <li>Use canonical enums from docs/CONTRACTS.md.</li>
        </ol>
      </Section>
    </div>
  );
}

// ─────────────────────────── layout primitives ───────────────────────────

function TopNav() {
  return (
    <nav
      style={{
        display: "flex",
        gap: 14,
        alignItems: "center",
        padding: "10px 0 20px",
        borderBottom: "1px solid var(--ink-200)",
        marginBottom: 24,
      }}
    >
      <a
        href="/"
        style={{
          fontSize: "0.75rem",
          color: "var(--brand-700)",
          textDecoration: "none",
          fontWeight: 700,
        }}
      >
        ← Back to {BRAND.name}
      </a>
    </nav>
  );
}

function TOC() {
  const entries: Array<[string, string]> = [
    ["exposure-map", "Exposure map (choropleth)"],
    ["hurricane-impact", "Hurricane impact engine"],
    ["live-storms", "Live-storm overlay"],
    ["wind-heatmap", "Interpolated wind heatmap"],
    ["hazard-grids", "Hazard climatology grids"],
    ["layers-engine", "Layer / XOL engine"],
    ["observability", "Observability & edge behaviour"],
    ["the-rules", "The ten operating rules"],
  ];
  return (
    <div
      style={{
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 6,
        padding: 14,
        marginBottom: 32,
      }}
    >
      <div
        style={{
          fontSize: "0.65rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-500)",
          marginBottom: 6,
        }}
      >
        Contents
      </div>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          columns: 2,
          columnGap: 24,
        }}
      >
        {entries.map(([anchor, label]) => (
          <li key={anchor} style={{ padding: "3px 0" }}>
            <a
              href={`#${anchor}`}
              style={{
                fontSize: "0.82rem",
                color: "var(--brand-700)",
                textDecoration: "none",
              }}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({
  id, title, children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ marginBottom: 40, scrollMarginTop: 24 }}>
      <h2
        style={{
          fontSize: "1.15rem",
          margin: "12px 0 8px",
          borderBottom: "1px solid var(--ink-200)",
          paddingBottom: 4,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: "0.82rem",
        color: "var(--ink-700)",
        margin: "16px 0 4px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {children}
    </h3>
  );
}

function Equation({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 4,
        padding: "8px 12px",
        margin: "6px 0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "0.85rem",
      }}
    >
      {children}
    </div>
  );
}

function Sources({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 10,
        background: "#fefce8",
        border: "1px solid #fde047",
        borderRadius: 4,
        padding: "10px 14px",
      }}
    >
      <div
        style={{
          fontSize: "0.65rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "#854d0e",
          marginBottom: 4,
        }}
      >
        Sources
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: "0.82rem" }}>
        {children}
      </ul>
    </div>
  );
}
