"""Exposure endpoints — `/map`, `/detail`, `/pivot` (API_SPEC.md §Exposure APIs).

Routers are thin: pull facts from the provider, apply filters, hand off to the
calculation / grouping services, attach warnings, return the response. No
formula lives here (CLAUDE.md rule "single source of truth").

Source-of-truth notes:

* **Grain semantics** (CONTRACTS.md §13): the view grain is the union of
  geography + active dimensions. Map uses ``[geography_attr]``; pivot uses
  ``rows + columns``; detail uses ``[geography_attr]`` (one row).
* **Group combination** (CLAUDE.md rule 3, CONTRACTS.md §4): the default
  ``MAX_ACROSS_PERILS_AT_VIEW_GRAIN`` is computed by
  :func:`grouping.combine_at_grain` at the requested grain. The location count
  follows :func:`grouping.location_count_at_max_peril` so we don't double-count.
* **County fallback** (CLAUDE.md rule 11): when ``COUNTY`` is requested and a
  state has no county rows in the data, we fall back to STATE rows for that
  state and attach ``WARN_COUNTY_DATA_UNAVAILABLE`` once.
* **Geometry availability**: features whose ``geographyId`` is not in
  ``provider.get_geometry_availability()`` get ``hasGeometry: false`` and a
  per-feature ``WARN_MAP_GEOMETRY_MISSING`` (info severity).
* **YoY**: only when ``comparisonDatasetId`` is supplied; else attach a
  top-level ``WARN_PRIOR_DATASET_NOT_SELECTED`` and leave the yoy fields
  ``None`` (CLAUDE.md rule "null on cannot-compute").
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException

from ..models.cedent import Cedent, Programme, ProgrammeChain
from ..models.enums import (
    AggregationLevel,
    CombinationMethod,
    ErrorCode,
    Measure,
    MetricKey,
    OccupancySegment,
    Peril,
    WarningCode,
    YoyStatus,
)
from ..models.exposure import (
    BreakdownRow,
    DealVsPortfolio,
    DetailBreakdowns,
    DetailRequest,
    DetailResponse,
    DetailSummary,
    ExposureFactNormalized,
    ExposureFilters,
    MapFeature,
    MapRequest,
    MapResponse,
    MarketShareDetail,
    PivotCell,
    PivotRequest,
    PivotResponse,
    YoyDetail,
)
from ..models.warnings import Warning, make_warning
from ..providers import ExposureDataProvider, get_provider
from ..services.calculations import (
    aggregate_location_count,
    aggregate_measure,
    aggregate_tiv,
    apply_filters,
    client_market_share,
    deal_share_of_portfolio_in_geography,
    filter_to_geography_level,
    geography_share_of_total_portfolio,
    lookup_industry_tiv,
    selected_deal_geography_concentration,
    yoy_change,
)
from ..services.grouping import combine_at_grain, location_count_at_max_peril

router = APIRouter(prefix="/exposures", tags=["exposures"])


# ───────────────────────────── helpers ─────────────────────────────


_LEVEL_TO_ATTR: dict[AggregationLevel, str] = {
    AggregationLevel.COUNTRY: "country",
    AggregationLevel.STATE: "statecode",
    AggregationLevel.COUNTY: "county",
    AggregationLevel.CRESTA: "cresta",
}


# Pivot dimension key → fact attribute. Includes the AggregationLevel codes
# (so rows/columns may carry "STATE", "COUNTY", etc.) and the broader dimension
# names listed in API_SPEC.md §pivot.
_PIVOT_DIM_TO_ATTR: dict[str, str] = {
    # geography levels (also acceptable as rows/columns)
    AggregationLevel.COUNTRY.value: "country",
    AggregationLevel.STATE.value: "statecode",
    AggregationLevel.COUNTY.value: "county",
    AggregationLevel.CRESTA.value: "cresta",
    # dimension keys
    "PERIL": "peril",
    "OCCUPANCY": "occupancy",
    "OCCUPANCY_GROUP": "occupancy_group",
    "OCCUPANCY_SEGMENT": "occupancy_segment",
    "CONSTRUCTION": "construction",
    "DISTANCE_TO_COAST": "distance_to_coast",
    "GEOCODING": "geocoding_quality",
    "NUMBER_OF_STORIES": "number_of_stories",
    "YEAR_BUILT": "year_built",
    "DATASET": "dataset_id",
    "DATASET_GROUP": "dataset_group_id",
    "CURRENCY": "currency",
    "TREATY_YEAR": "portname",  # close-enough proxy; v1 doesn't carry treaty year on facts
}


def _require_exactly_one_target(payload: "MapRequest | DetailRequest | PivotRequest") -> None:
    """Enforce: exactly one of programmeId / chainId / chainIds / cedentId / datasetId / datasetGroupId."""
    chain_ids = list(getattr(payload, "chain_ids", []) or [])
    targets = {
        "programmeId": getattr(payload, "programme_id", None),
        "chainId": getattr(payload, "chain_id", None),
        "chainIds": chain_ids if chain_ids else None,
        "cedentId": getattr(payload, "cedent_id", None),
        "datasetId": getattr(payload, "dataset_id", None),
        "datasetGroupId": getattr(payload, "dataset_group_id", None),
    }
    set_count = sum(1 for v in targets.values() if v)
    if set_count != 1:
        raise HTTPException(
            status_code=422,
            detail={
                "code": ErrorCode.VALIDATION_ERROR.value,
                "message": (
                    "Provide exactly one of 'programmeId', 'chainId', 'chainIds', "
                    "'cedentId', 'datasetId', or 'datasetGroupId'."
                ),
                "details": targets,
            },
        )


class _ResolvedView:
    """The flattened result of resolving any view target into the same shape."""

    __slots__ = (
        "facts",
        "currency",
        "combination_method",
        "base_dataset_id",
        "comparison_dataset_id",
        "warnings",
    )

    def __init__(
        self,
        facts: list[ExposureFactNormalized],
        currency: str,
        combination_method: CombinationMethod | None,
        base_dataset_id: str | None,
        comparison_dataset_id: str | None,
        warnings: list[Warning] | None = None,
    ) -> None:
        self.facts = facts
        self.currency = currency
        self.combination_method = combination_method
        self.base_dataset_id = base_dataset_id
        self.comparison_dataset_id = comparison_dataset_id
        self.warnings = warnings or []


def _not_found(code: ErrorCode, message: str, details: dict) -> "HTTPException":
    return HTTPException(
        status_code=404,
        detail={"code": code.value, "message": message, "details": details},
    )


def _resolve_view(
    provider: ExposureDataProvider,
    payload: "MapRequest | DetailRequest | PivotRequest",
) -> _ResolvedView:
    """Resolve whichever identifier was supplied into a uniform `_ResolvedView`.

    Resolution order: programmeId > chainId > cedentId > datasetId > datasetGroupId.
    The chain path also auto-derives the prior programme as the comparison (unless
    the user supplied a `comparison_programme_id` or `comparison_dataset_id`).
    """
    # programmeId — single programme, treat like a dataset.
    if getattr(payload, "programme_id", None):
        prog = provider.get_programme(payload.programme_id)  # type: ignore[arg-type]
        if prog is None:
            raise _not_found(
                ErrorCode.DATASET_NOT_FOUND,
                f"Programme '{payload.programme_id}' was not found.",
                {"programmeId": payload.programme_id},
            )
        return _ResolvedView(
            facts=provider.get_facts_for_dataset(prog.dataset_id),
            currency=prog.edm.currency,
            combination_method=None,
            base_dataset_id=prog.dataset_id,
            comparison_dataset_id=_resolve_comparison_dataset_id(provider, payload),
        )

    # chainId — latest programme; auto-prior unless overridden.
    if getattr(payload, "chain_id", None):
        chain = provider.get_chain(payload.chain_id)  # type: ignore[arg-type]
        if chain is None:
            raise _not_found(
                ErrorCode.DATASET_NOT_FOUND,
                f"Programme chain '{payload.chain_id}' was not found.",
                {"chainId": payload.chain_id},
            )
        progs = sorted(chain.programmes, key=lambda p: p.treaty_year, reverse=True)
        if not progs:
            raise _not_found(
                ErrorCode.DATASET_NOT_FOUND,
                f"Chain '{chain.chain_id}' has no programmes.",
                {"chainId": chain.chain_id},
            )
        current = progs[0]
        comparison_id = _resolve_comparison_dataset_id(provider, payload)
        if comparison_id is None and len(progs) > 1:
            comparison_id = progs[1].dataset_id
        return _ResolvedView(
            facts=provider.get_facts_for_dataset(current.dataset_id),
            currency=current.edm.currency,
            combination_method=None,
            base_dataset_id=current.dataset_id,
            comparison_dataset_id=comparison_id,
        )

    # chainIds[] — office-level multi-chain combination. Each chain contributes
    # its latest programme; combined with MAX_ACROSS_PERILS_AT_VIEW_GRAIN.
    chain_ids = list(getattr(payload, "chain_ids", []) or [])
    if chain_ids:
        chains: list[ProgrammeChain] = []
        for cid in chain_ids:
            ch = provider.get_chain(cid)
            if ch is None:
                raise _not_found(
                    ErrorCode.DATASET_NOT_FOUND,
                    f"Programme chain '{cid}' was not found.",
                    {"chainId": cid},
                )
            chains.append(ch)
        facts: list[ExposureFactNormalized] = []
        currencies: set[str] = set()
        for ch in chains:
            progs = sorted(ch.programmes, key=lambda p: p.treaty_year, reverse=True)
            if not progs:
                continue
            current = progs[0]
            facts.extend(provider.get_facts_for_dataset(current.dataset_id))
            currencies.add(current.edm.currency)
        warnings: list[Warning] = []
        if len(currencies) > 1:
            warnings.append(make_warning(WarningCode.WARN_CURRENCY_MISMATCH))
        currency = next(iter(currencies)) if len(currencies) == 1 else "MIXED"
        method = (
            CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN if len(chains) > 1 else None
        )
        if method is not None:
            warnings.append(make_warning(WarningCode.WARN_DATASET_GROUP_MAX_ACROSS_PERILS))
        return _ResolvedView(
            facts=facts,
            currency=currency,
            combination_method=method,
            base_dataset_id=None,
            comparison_dataset_id=None,
            warnings=warnings,
        )

    # cedentId — combine all chains' latest programmes (group-like).
    if getattr(payload, "cedent_id", None):
        cedent = provider.get_cedent(payload.cedent_id)  # type: ignore[arg-type]
        if cedent is None:
            raise _not_found(
                ErrorCode.DATASET_NOT_FOUND,
                f"Cedent '{payload.cedent_id}' was not found.",
                {"cedentId": payload.cedent_id},
            )
        facts: list[ExposureFactNormalized] = []
        currencies: set[str] = set()
        for chain in cedent.chains:
            progs = sorted(chain.programmes, key=lambda p: p.treaty_year, reverse=True)
            if not progs:
                continue
            current = progs[0]
            facts.extend(provider.get_facts_for_dataset(current.dataset_id))
            currencies.add(current.edm.currency)
        warnings: list[Warning] = []
        if len(currencies) > 1:
            warnings.append(make_warning(WarningCode.WARN_CURRENCY_MISMATCH))
        currency = next(iter(currencies)) if len(currencies) == 1 else "MIXED"
        # Multi-chain cedent view uses MAX_ACROSS_PERILS at the requested grain.
        method = (
            CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN
            if len(cedent.chains) > 1
            else None
        )
        if method is not None:
            warnings.append(make_warning(WarningCode.WARN_DATASET_GROUP_MAX_ACROSS_PERILS))
        return _ResolvedView(
            facts=facts,
            currency=currency,
            combination_method=method,
            base_dataset_id=None,
            comparison_dataset_id=None,  # cedent-level YoY needs prior chain mapping; v2
            warnings=warnings,
        )

    # datasetId — legacy single-dataset path (deprecated).
    if getattr(payload, "dataset_id", None):
        prog = provider.get_programme_by_dataset_id(payload.dataset_id)  # type: ignore[arg-type]
        if prog is None:
            raise _not_found(
                ErrorCode.DATASET_NOT_FOUND,
                f"Dataset '{payload.dataset_id}' was not found.",
                {"datasetId": payload.dataset_id},
            )
        return _ResolvedView(
            facts=provider.get_facts_for_dataset(prog.dataset_id),
            currency=prog.edm.currency,
            combination_method=None,
            base_dataset_id=prog.dataset_id,
            comparison_dataset_id=_resolve_comparison_dataset_id(provider, payload),
        )

    # datasetGroupId — ad-hoc combination.
    assert getattr(payload, "dataset_group_id", None) is not None
    group = provider.get_dataset_group(payload.dataset_group_id)  # type: ignore[arg-type]
    if group is None:
        raise _not_found(
            ErrorCode.DATASET_GROUP_NOT_FOUND,
            f"Dataset group '{payload.dataset_group_id}' was not found.",
            {"datasetGroupId": payload.dataset_group_id},
        )
    facts = []
    for member in group.members:
        facts.extend(provider.get_facts_for_dataset(member.dataset_id))
    base = group.members[0].dataset_id if group.members else None
    return _ResolvedView(
        facts=facts,
        currency=group.currency,
        combination_method=group.combination_method,
        base_dataset_id=base,
        comparison_dataset_id=_resolve_comparison_dataset_id(provider, payload),
    )


def _resolve_comparison_dataset_id(
    provider: ExposureDataProvider,
    payload: "MapRequest | DetailRequest | PivotRequest",
) -> str | None:
    """Translate `comparison_programme_id` → dataset_id; else honor the legacy field."""
    cmp_prog_id = getattr(payload, "comparison_programme_id", None)
    if cmp_prog_id:
        prog = provider.get_programme(cmp_prog_id)
        if prog is None:
            raise _not_found(
                ErrorCode.PRIOR_DB_NOT_FOUND,
                "Prior programme was not found.",
                {"comparisonProgrammeId": cmp_prog_id},
            )
        return prog.dataset_id
    return getattr(payload, "comparison_dataset_id", None)


def _apply_peril_filter(
    facts: list[ExposureFactNormalized],
    perils: list[Peril],
) -> list[ExposureFactNormalized]:
    """Top-of-page peril multi-select. Empty / contains ALL → pass-through."""
    if not perils or Peril.ALL in perils:
        return facts
    wanted = {p.value if hasattr(p, "value") else str(p) for p in perils}
    return [f for f in facts if f.peril in wanted]


def _county_fallback_if_needed(
    facts: list[ExposureFactNormalized],
    level: AggregationLevel,
) -> tuple[list[ExposureFactNormalized], bool]:
    """If COUNTY view but some state has no county rows, fall back to STATE.

    Per CLAUDE.md rule 11 (graceful degradation, never fabrication). Returns
    ``(facts_used, county_fallback_applied)``.

    The fallback adds STATE-level rows for any state that has zero COUNTY-level
    rows. COUNTY rows for states with data are kept as-is.
    """
    if level != AggregationLevel.COUNTY:
        return filter_to_geography_level(facts, level), False

    county_rows = filter_to_geography_level(facts, AggregationLevel.COUNTY)
    states_with_counties = {f.statecode for f in county_rows if f.statecode}
    all_state_rows = filter_to_geography_level(facts, AggregationLevel.STATE)
    fallback_rows = [
        f for f in all_state_rows if f.statecode and f.statecode not in states_with_counties
    ]
    return county_rows + fallback_rows, bool(fallback_rows)


def _attach_geometry_warnings(
    features: Sequence[MapFeature],
    available: set[str],
) -> None:
    """Mark each feature without geometry + add a per-feature warning."""
    for feature in features:
        if feature.geography_id not in available:
            feature.has_geometry = False
            feature.warnings.append(
                make_warning(
                    WarningCode.WARN_MAP_GEOMETRY_MISSING,
                    context={"geographyId": feature.geography_id},
                )
            )


def _geography_name_for(
    geography_id: str,
    facts: Sequence[ExposureFactNormalized],
    level: AggregationLevel,
) -> str | None:
    """Pick a display name from facts (first match wins).

    Detects the row's actual level from the matched fact rather than trusting the
    requested level — county-fallback rows live in a COUNTY response but carry a
    state-grain geographyId ("US-NC"), and we want "NORTH CAROLINA" not None.
    """
    for f in facts:
        if f.geography_id != geography_id:
            continue
        # Pick the most-specific attribute that has a value.
        for attr in ("county_name", "cresta_name", "state_name", "country_name"):
            name = getattr(f, attr, None)
            if name:
                return name
    return None


def _segment_for_market_share(facts: Sequence[ExposureFactNormalized]) -> OccupancySegment | None:
    """Resolve a single occupancy segment for IED lookup, else ``None`` (= ALL).

    `use_enum_values=True` on the Pydantic config means `fact.occupancy_segment`
    is a raw string at runtime, not an OccupancySegment instance. Coerce back to
    the enum here so callers can rely on `.value` and `==` against enum members.
    """
    raw = {f.occupancy_segment for f in facts if f.occupancy_segment}
    segments: set[OccupancySegment] = set()
    for value in raw:
        try:
            segments.add(OccupancySegment(value))
        except ValueError:
            continue  # unrecognized segment string — treat as ambiguous
    if len(segments) == 1:
        only = next(iter(segments))
        if only != OccupancySegment.UNKNOWN:
            return only
    return None


# ───────────────────────────── /map ─────────────────────────────


@router.post("/map", response_model=MapResponse)
def exposures_map(
    payload: MapRequest,
    provider: ExposureDataProvider = Depends(get_provider),
) -> MapResponse:
    """Compute the map view (API_SPEC.md `POST /api/exposures/map`)."""
    _require_exactly_one_target(payload)

    resolved = _resolve_view(provider, payload)
    raw_facts = _apply_peril_filter(resolved.facts, payload.perils)
    currency = resolved.currency
    combination_method = resolved.combination_method
    base_dataset_id = resolved.base_dataset_id

    level = payload.aggregation_level
    facts_at_level, county_fallback = _county_fallback_if_needed(raw_facts, level)

    geo_attr = _LEVEL_TO_ATTR[level]
    grain: tuple[str, ...] = ("geography_id",)

    deal_facts = apply_filters(facts_at_level, payload.filters)
    top_warnings: list[Warning] = list(resolved.warnings)

    if county_fallback:
        top_warnings.append(make_warning(WarningCode.WARN_COUNTY_DATA_UNAVAILABLE))

    if not deal_facts:
        top_warnings.append(make_warning(WarningCode.WARN_FILTERS_RETURN_NO_ROWS))
        return MapResponse(
            aggregation_level=level,
            metric=payload.metric,
            currency=currency,
            features=[],
            warnings=top_warnings,
        )

    # ─── Deal-side TIV / location-count (group-aware) ───
    if combination_method is not None and combination_method != CombinationMethod.KEEP_PERILS_SEPARATE:
        try:
            deal_tiv_by_geo = combine_at_grain(
                deal_facts,
                grain,
                combination_method,
                distinct_segments_confirmed=True,  # group already gated at creation
                base_dataset_id=base_dataset_id,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": ErrorCode.VALIDATION_ERROR.value,
                    "message": str(exc),
                },
            ) from exc
        if combination_method == CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN:
            deal_loc_by_geo = location_count_at_max_peril(deal_facts, grain)
        else:
            deal_loc_by_geo = aggregate_location_count(deal_facts, grain)
    else:
        deal_tiv_by_geo = aggregate_tiv(deal_facts, grain)
        deal_loc_by_geo = aggregate_location_count(deal_facts, grain)

    # ─── Portfolio denominators (geo-only) ───
    portfolio_facts = provider.get_portfolio_facts()
    portfolio_at_level, _ = _county_fallback_if_needed(portfolio_facts, level)
    portfolio_tiv_by_geo = aggregate_tiv(portfolio_at_level, grain)
    total_portfolio_tiv = sum(portfolio_tiv_by_geo.values())
    total_deal_tiv = sum(deal_tiv_by_geo.values())

    # ─── YoY (optional) ───
    prior_tiv_by_geo: dict[tuple, float] = {}
    prior_loc_by_geo: dict[tuple, int] = {}
    prior_total_deal_tiv: float = 0.0
    comparison_dataset_id = resolved.comparison_dataset_id
    if comparison_dataset_id:
        prior_prog = provider.get_programme_by_dataset_id(comparison_dataset_id)
        if prior_prog is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": ErrorCode.PRIOR_DB_NOT_FOUND.value,
                    "message": (
                        "Prior-year database was not found. Check the server/database "
                        "name or select another prior-year dataset."
                    ),
                    "details": {"datasetId": comparison_dataset_id},
                },
            )
        prior_raw = _apply_peril_filter(
            provider.get_facts_for_dataset(comparison_dataset_id), payload.perils
        )
        prior_at_level, _ = _county_fallback_if_needed(prior_raw, level)
        prior_filtered = apply_filters(prior_at_level, payload.filters)
        prior_tiv_by_geo = aggregate_tiv(prior_filtered, grain)
        prior_loc_by_geo = aggregate_location_count(prior_filtered, grain)
        prior_total_deal_tiv = sum(prior_tiv_by_geo.values())
    else:
        top_warnings.append(make_warning(WarningCode.WARN_PRIOR_DATASET_NOT_SELECTED))

    # ─── IED industry rows for market share ───
    ied_rows = provider.get_ied_industry()
    segment = _segment_for_market_share(deal_facts)

    # ─── Assemble features ───
    features: list[MapFeature] = []
    for (geography_id,), deal_tiv in deal_tiv_by_geo.items():
        feature_warnings: list[Warning] = []
        loc_count = int(deal_loc_by_geo.get((geography_id,), 0))
        portfolio_geo_tiv = portfolio_tiv_by_geo.get((geography_id,), 0.0)

        deal_share = deal_share_of_portfolio_in_geography(deal_tiv, portfolio_geo_tiv)
        geo_share = geography_share_of_total_portfolio(portfolio_geo_tiv, total_portfolio_tiv)
        concentration = selected_deal_geography_concentration(deal_tiv, total_deal_tiv)

        industry_tiv = lookup_industry_tiv(ied_rows, geography_id, segment)
        share, share_warning = client_market_share(deal_tiv, industry_tiv)
        if share_warning is not None:
            share_warning_with_ctx = make_warning(
                share_warning.code,
                context={"geographyId": geography_id, "segment": segment.value if segment else "ALL"},
            )
            feature_warnings.append(share_warning_with_ctx)

        yoy_value: float | None = None
        yoy_st: YoyStatus | None = None
        if comparison_dataset_id:
            prior_geo_tiv = prior_tiv_by_geo.get((geography_id,))
            yoy_value, yoy_st = yoy_change(deal_tiv, prior_geo_tiv)

        metric_value = _metric_value_for(
            payload.metric,
            tiv=deal_tiv,
            location_count=loc_count,
            deal_share=deal_share,
            geo_share=geo_share,
            concentration=concentration,
            market_share=share,
            yoy=yoy_value,
        )

        # Always compute the prior-period metric value when a comparison dataset
        # is set — feeds both the YoY view-mode override AND the prior-vs-current
        # mini-table the tooltip renders. For ratio metrics, the prior-period
        # denominator uses the CURRENT portfolio (no prior portfolio in v1) —
        # approximation documented in OPEN_QUESTIONS. TIV/LOCATION_COUNT exact.
        prior_metric_value: float | None = None
        if comparison_dataset_id:
            prior_geo_tiv = prior_tiv_by_geo.get((geography_id,))
            prior_geo_loc = prior_loc_by_geo.get((geography_id,))
            prior_industry = lookup_industry_tiv(ied_rows, geography_id, segment)
            prior_metric_value = _metric_value_for(
                payload.metric,
                tiv=prior_geo_tiv,
                location_count=prior_geo_loc,
                deal_share=deal_share_of_portfolio_in_geography(
                    prior_geo_tiv, portfolio_geo_tiv
                ),
                geo_share=geo_share,
                concentration=selected_deal_geography_concentration(
                    prior_geo_tiv, prior_total_deal_tiv
                ),
                market_share=client_market_share(prior_geo_tiv, prior_industry)[0],
                yoy=None,
            )
            if payload.yoy_mode:
                metric_value, _ = yoy_change(metric_value, prior_metric_value)

        features.append(
            MapFeature(
                geography_id=geography_id,
                geography_name=_geography_name_for(geography_id, deal_facts, level),
                metric_value=metric_value,
                prior_metric_value=prior_metric_value,
                tiv=deal_tiv,
                location_count=loc_count,
                deal_share_of_portfolio_in_geography=deal_share,
                geography_share_of_total_portfolio=geo_share,
                selected_deal_geography_concentration=concentration,
                client_market_share=share,
                yoy_change=yoy_value,
                yoy_status=yoy_st,
                has_geometry=True,
                warnings=feature_warnings,
            )
        )

    # ─── Add features for prior-only geographies (REMOVED) when YoY is on ───
    if comparison_dataset_id:
        for (geography_id,), prior_tiv in prior_tiv_by_geo.items():
            if (geography_id,) in deal_tiv_by_geo:
                continue
            yoy_value, yoy_st = yoy_change(None, prior_tiv)
            features.append(
                MapFeature(
                    geography_id=geography_id,
                    geography_name=None,
                    metric_value=None if payload.metric != MetricKey.TIV else 0.0,
                    tiv=0.0,
                    location_count=0,
                    yoy_change=yoy_value,
                    yoy_status=yoy_st,
                )
            )

    geometry_available = provider.get_geometry_availability()
    _attach_geometry_warnings(features, geometry_available)

    return MapResponse(
        aggregation_level=level,
        metric=payload.metric,
        currency=currency,
        features=features,
        warnings=top_warnings,
    )


def _metric_value_for(
    metric: MetricKey,
    *,
    tiv: float | None,
    location_count: int | None,
    deal_share: float | None,
    geo_share: float | None,
    concentration: float | None,
    market_share: float | None,
    yoy: float | None,
) -> float | None:
    """Mirror the requested metric into ``metricValue`` (API_SPEC.md note)."""
    mapping: dict[MetricKey, float | int | None] = {
        MetricKey.TIV: tiv,
        MetricKey.LOCATION_COUNT: location_count,
        MetricKey.DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY: deal_share,
        MetricKey.GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO: geo_share,
        MetricKey.SELECTED_DEAL_GEOGRAPHY_CONCENTRATION: concentration,
        MetricKey.CLIENT_MARKET_SHARE: market_share,
        MetricKey.YOY_CHANGE: yoy,
    }
    value = mapping.get(metric)
    return float(value) if value is not None else None


# ───────────────────────────── /detail ─────────────────────────────


@router.post("/detail", response_model=DetailResponse)
def exposures_detail(
    payload: DetailRequest,
    provider: ExposureDataProvider = Depends(get_provider),
) -> DetailResponse:
    """Side-panel detail for one geography (API_SPEC.md `POST /api/exposures/detail`)."""
    _require_exactly_one_target(payload)

    resolved = _resolve_view(provider, payload)
    raw_facts = _apply_peril_filter(resolved.facts, payload.perils)
    currency = resolved.currency
    combination_method = resolved.combination_method
    base_dataset_id = resolved.base_dataset_id

    level = payload.aggregation_level
    facts_at_level, county_fallback = _county_fallback_if_needed(raw_facts, level)
    deal_facts = apply_filters(facts_at_level, payload.filters)

    geo_id = payload.geography_id
    geo_facts = [f for f in deal_facts if f.geography_id == geo_id]

    top_warnings: list[Warning] = list(resolved.warnings)
    if county_fallback:
        top_warnings.append(make_warning(WarningCode.WARN_COUNTY_DATA_UNAVAILABLE))
    if not deal_facts:
        top_warnings.append(make_warning(WarningCode.WARN_FILTERS_RETURN_NO_ROWS))

    grain: tuple[str, ...] = ("geography_id",)

    # Deal TIV / loc-count (group-aware)
    if combination_method is not None and combination_method != CombinationMethod.KEEP_PERILS_SEPARATE:
        deal_tiv_by_geo = combine_at_grain(
            deal_facts,
            grain,
            combination_method,
            distinct_segments_confirmed=True,
            base_dataset_id=base_dataset_id,
        )
        if combination_method == CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN:
            deal_loc_by_geo = location_count_at_max_peril(deal_facts, grain)
        else:
            deal_loc_by_geo = aggregate_location_count(deal_facts, grain)
    else:
        deal_tiv_by_geo = aggregate_tiv(deal_facts, grain)
        deal_loc_by_geo = aggregate_location_count(deal_facts, grain)

    deal_tiv = deal_tiv_by_geo.get((geo_id,), 0.0)
    loc_count = int(deal_loc_by_geo.get((geo_id,), 0))
    total_deal_tiv = sum(deal_tiv_by_geo.values())

    portfolio_facts = provider.get_portfolio_facts()
    portfolio_at_level, _ = _county_fallback_if_needed(portfolio_facts, level)
    portfolio_tiv_by_geo = aggregate_tiv(portfolio_at_level, grain)
    portfolio_geo_tiv = portfolio_tiv_by_geo.get((geo_id,), 0.0)
    total_portfolio_tiv = sum(portfolio_tiv_by_geo.values())

    deal_share = deal_share_of_portfolio_in_geography(deal_tiv, portfolio_geo_tiv)
    geo_share = geography_share_of_total_portfolio(portfolio_geo_tiv, total_portfolio_tiv)
    concentration = selected_deal_geography_concentration(deal_tiv, total_deal_tiv)

    segment = _segment_for_market_share(geo_facts)
    industry_tiv = lookup_industry_tiv(provider.get_ied_industry(), geo_id, segment)
    share, share_warning = client_market_share(deal_tiv, industry_tiv)

    feature_warnings: list[Warning] = []
    if share_warning is not None:
        feature_warnings.append(
            make_warning(
                share_warning.code,
                context={"geographyId": geo_id, "segment": segment.value if segment else "ALL"},
            )
        )

    yoy_value: float | None = None
    yoy_st: YoyStatus = YoyStatus.NA
    prior_geo_tiv: float | None = None
    comparison_dataset_id = resolved.comparison_dataset_id
    if comparison_dataset_id:
        prior_prog = provider.get_programme_by_dataset_id(comparison_dataset_id)
        if prior_prog is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": ErrorCode.PRIOR_DB_NOT_FOUND.value,
                    "message": "Prior-year database was not found.",
                    "details": {"datasetId": comparison_dataset_id},
                },
            )
        prior_raw = _apply_peril_filter(
            provider.get_facts_for_dataset(comparison_dataset_id), payload.perils
        )
        prior_at_level, _ = _county_fallback_if_needed(prior_raw, level)
        prior_filtered = apply_filters(prior_at_level, payload.filters)
        prior_tiv_by_geo = aggregate_tiv(prior_filtered, grain)
        prior_geo_tiv = prior_tiv_by_geo.get((geo_id,))
        yoy_value, yoy_st = yoy_change(deal_tiv if deal_tiv != 0 else None, prior_geo_tiv)
    else:
        top_warnings.append(make_warning(WarningCode.WARN_PRIOR_DATASET_NOT_SELECTED))

    # ─── Breakdowns (within the selected geography) ───
    breakdowns = DetailBreakdowns(
        peril=_breakdown_rows(geo_facts, "peril"),
        occupancy=_breakdown_rows(geo_facts, "occupancy_segment"),
        distance_to_coast=_breakdown_rows(geo_facts, "distance_to_coast"),
        geocoding=_breakdown_rows(geo_facts, "geocoding_quality"),
        stories=_breakdown_rows(geo_facts, "number_of_stories"),
        construction=_breakdown_rows(geo_facts, "construction"),
    )

    return DetailResponse(
        geography_id=geo_id,
        geography_name=_geography_name_for(geo_id, geo_facts or deal_facts, level),
        aggregation_level=level,
        currency=currency,
        summary=DetailSummary(
            tiv=deal_tiv,
            location_count=loc_count,
            deal_share_of_portfolio_in_geography=deal_share,
            geography_share_of_total_portfolio=geo_share,
            selected_deal_geography_concentration=concentration,
            client_market_share=share,
            yoy_change=yoy_value,
            yoy_status=yoy_st,
        ),
        deal_vs_portfolio=DealVsPortfolio(
            deal_tiv=deal_tiv,
            portfolio_tiv=portfolio_geo_tiv,
        ),
        market_share=MarketShareDetail(
            client_tiv=deal_tiv if industry_tiv is not None else None,
            industry_tiv=industry_tiv,
            share=share,
            segment=(segment.value if segment else "ALL"),
        ),
        yoy=YoyDetail(
            current_tiv=deal_tiv,
            prior_tiv=prior_geo_tiv,
            change=yoy_value,
            status=yoy_st,
        ),
        breakdowns=breakdowns,
        active_filters=payload.filters.model_dump(by_alias=True),
        warnings=top_warnings + feature_warnings,
    )


def _breakdown_rows(
    facts: Sequence[ExposureFactNormalized],
    attr: str,
) -> list[BreakdownRow]:
    """Group facts by ``attr`` and emit TIV + loc count per key."""
    tiv: dict[str, float] = defaultdict(float)
    loc: dict[str, int] = defaultdict(int)
    for f in facts:
        raw = getattr(f, attr, None)
        if raw is None or raw == "":
            continue
        key = raw.value if hasattr(raw, "value") else str(raw)
        tiv[key] += float(f.tiv or 0.0)
        loc[key] += int(f.location_count or 0)
    return [
        BreakdownRow(key=k, tiv=tiv[k], location_count=loc[k])
        for k in sorted(tiv.keys())
    ]


# ───────────────────────────── /pivot ─────────────────────────────


@router.post("/pivot", response_model=PivotResponse)
def exposures_pivot(
    payload: PivotRequest,
    provider: ExposureDataProvider = Depends(get_provider),
) -> PivotResponse:
    """Compute a pivot grid (API_SPEC.md `POST /api/exposures/pivot`)."""
    _require_exactly_one_target(payload)

    resolved = _resolve_view(provider, payload)
    raw_facts = _apply_peril_filter(resolved.facts, payload.perils)
    currency = resolved.currency
    combination_method = resolved.combination_method
    base_dataset_id = resolved.base_dataset_id

    # The pivot view doesn't pin to a single AggregationLevel — pick the finest
    # geography level mentioned in rows+columns, else default to the data as-is.
    geo_levels = [
        AggregationLevel(dim)
        for dim in [*payload.rows, *payload.columns]
        if dim in AggregationLevel.__members__
    ]
    if geo_levels:
        # finest mentioned (COUNTY > STATE > COUNTRY by enum order in CONTRACTS.md §2)
        order = {
            AggregationLevel.COUNTRY: 0,
            AggregationLevel.STATE: 1,
            AggregationLevel.COUNTY: 2,
            AggregationLevel.CRESTA: 1,  # CRESTA is mid-level; treat as STATE-ish
        }
        level = max(geo_levels, key=lambda lvl: order.get(lvl, 0))
        facts_at_level, county_fallback = _county_fallback_if_needed(raw_facts, level)
    else:
        facts_at_level = raw_facts
        county_fallback = False

    deal_facts = apply_filters(facts_at_level, payload.filters)

    top_warnings: list[Warning] = list(resolved.warnings)
    if county_fallback:
        top_warnings.append(make_warning(WarningCode.WARN_COUNTY_DATA_UNAVAILABLE))

    method = payload.combination_method or combination_method
    if method is not None:
        if method == CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN:
            top_warnings.append(
                make_warning(WarningCode.WARN_DATASET_GROUP_MAX_ACROSS_PERILS)
            )
        elif method == CombinationMethod.SUM_DISTINCT_SEGMENTS:
            top_warnings.append(make_warning(WarningCode.WARN_DATASET_GROUP_SUMMED))

    if not deal_facts:
        top_warnings.append(make_warning(WarningCode.WARN_FILTERS_RETURN_NO_ROWS))
        return PivotResponse(
            rows=payload.rows,
            columns=payload.columns,
            measures=payload.measures,
            currency=currency,
            cells=[],
            grand_total={m.value: 0 for m in payload.measures},
            warnings=top_warnings,
        )

    # Translate dimension names → fact attributes for the grain key.
    def _to_attrs(dims: Sequence[str]) -> list[str]:
        out: list[str] = []
        for d in dims:
            attr = _PIVOT_DIM_TO_ATTR.get(d)
            if attr is None:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": ErrorCode.VALIDATION_ERROR.value,
                        "message": f"Unknown pivot dimension: {d!r}",
                        "details": {"dimension": d},
                    },
                )
            out.append(attr)
        return out

    row_attrs = _to_attrs(payload.rows)
    col_attrs = _to_attrs(payload.columns)
    grain_attrs = row_attrs + col_attrs

    # ─── Per-measure aggregations ───
    # NB: `payload.measures` arrives as plain `str` values (the model uses
    # `use_enum_values=True`); coerce back into the enum for comparisons that
    # need it, and key cells by the canonical wire string.
    cell_values: dict[tuple[tuple, tuple], dict[str, float | int]] = defaultdict(dict)

    for measure in payload.measures:
        measure_enum = Measure(measure) if not isinstance(measure, Measure) else measure
        measure_key = measure_enum.value
        if (
            measure_enum == Measure.TIV
            and method == CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN
        ):
            grained = combine_at_grain(
                deal_facts, grain_attrs, method, distinct_segments_confirmed=True
            )
        elif measure_enum == Measure.TIV and method == CombinationMethod.SUM_DISTINCT_SEGMENTS:
            grained = combine_at_grain(
                deal_facts, grain_attrs, method, distinct_segments_confirmed=True
            )
        elif (
            measure_enum == Measure.LOCATION_COUNT
            and method == CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN
        ):
            grained = location_count_at_max_peril(deal_facts, grain_attrs)
        else:
            grained = aggregate_measure(deal_facts, measure_enum, grain_attrs)

        for key, value in grained.items():
            row_key = key[: len(row_attrs)]
            col_key = key[len(row_attrs) :]
            cell_values[(row_key, col_key)][measure_key] = value

    cells: list[PivotCell] = []
    grand: dict[str, float | int] = {
        (m if isinstance(m, str) else m.value): 0 for m in payload.measures
    }
    for (row_key, col_key), values in cell_values.items():
        cells.append(
            PivotCell(
                row_key=[_stringify(v) for v in row_key],
                col_key=[_stringify(v) for v in col_key],
                values={k: (v if v is not None else None) for k, v in values.items()},
            )
        )
        for k, v in values.items():
            if v is None:
                continue
            grand[k] = grand.get(k, 0) + v

    return PivotResponse(
        rows=payload.rows,
        columns=payload.columns,
        measures=payload.measures,
        currency=currency,
        cells=cells,
        grand_total=grand,
        warnings=top_warnings,
    )


def _stringify(value: object) -> str:
    """Pivot keys go on the wire as strings; coerce enums + None safely."""
    if value is None:
        return ""
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)


__all__ = ["router"]
