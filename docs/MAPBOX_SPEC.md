# Mapbox Specification — Exposure Eclipse

> Mapbox GL JS v3 in the React + TS frontend. Map data comes only from
> `POST /api/exposures/map`. Enum values from `CONTRACTS.md`.

## Token

`VITE_MAPBOX_TOKEN` from env. **Never hardcode.** Token provisioning is **[OPEN]**
(`OPEN_QUESTIONS.md`); until provided, the map component should degrade to a clear
"map token not configured" state, not crash.

## v1 map

A global **choropleth** colored by the selected `metric`, switchable across aggregation
levels: `COUNTRY`, `STATE`, `COUNTY` (FL/TX/CA/NY in v1), `CRESTA` (where geometry exists).

- One fill layer per active level, joined to API features by `geographyId`.
- Color ramp scales to the metric's value distribution; show a legend with units
  (money / count / %). Signed metrics (`YOY_CHANGE`) use a diverging ramp around 0.
- Features present in API but missing geometry are listed in the warnings panel
  (`WARN_MAP_GEOMETRY_MISSING`); features with geometry but no data render muted/"no data".

## Geometry sources

GeoJSON in `/mockdata/geo/` (v1). `geographyId` keys must match fact/API keys:
`US`, `US-FL` (Admin-1), `US-FL-12086` (FIPS county), `CRESTA-<scheme>`. Document the exact
CRESTA id scheme alongside the fixture.

## Map metrics (color-by)

`TIV`, `LOCATION_COUNT`, `DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY`,
`GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO`, `SELECTED_DEAL_GEOGRAPHY_CONCENTRATION`,
`CLIENT_MARKET_SHARE`, `YOY_CHANGE`. The metric selector sets the request `metric`;
`metricValue` in each feature drives the fill.

## Hover tooltip (values **and** explanations)

Tooltips are an adoption feature, not decoration. Show value + a short formula reminder so
the three "share" metrics aren't confused.

```
Geography: Florida
Aggregation Level: State
TIV: $12.4bn
Location Count: 42,318
Deal Share of Portfolio in Geography: 18.2%   (deal FL TIV ÷ portfolio FL TIV)
Geography Share of Total Portfolio: 6.4%        (portfolio FL TIV ÷ total portfolio TIV)
Selected Deal Geography Concentration: 27.0%    (deal FL TIV ÷ deal total TIV)
Client Market Share: 3.1%                       (client TIV ÷ RMS IED industry TIV)
YoY Change: +5.8%
Currency: USD
⚠ County data unavailable — showing state level   (if applicable)
```

`null` metrics render as "N/A" with the relevant warning, never as 0%.

## Click behavior

Clicking a feature opens the detail side panel via `POST /api/exposures/detail` for that
`geographyId` (carrying the current filters/grain).

## Graceful degradation

- County geometry/data missing → render state/country + `WARN_COUNTY_DATA_UNAVAILABLE`.
- Token missing → non-crashing placeholder.
- Empty result set → empty map + `WARN_FILTERS_RETURN_NO_ROWS`.

## Performance

Use Mapbox feature-state for hover/selection (avoid re-adding sources). Keep large GeoJSON
out of React state; load via map sources. Debounce metric/level changes.

## Future (not v1)

Bubble/circle layer, heatmap, labels, side-by-side deal vs portfolio maps, overlays, map
style toggle. Keep the map component's props generic enough to add layers later without a
rewrite.
