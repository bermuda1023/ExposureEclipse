"""Fit damage curves per segment from supplied industry losses.

Reads every event in ``mockdata/industry_losses/``, runs the same wind field
the app uses (IBTrACS), matches counties to the industry TIV vintage for that
storm year, and fits one monotone damage curve per segment (residential,
commercial, auto). With two or more events each event is also scored
unseen (fit on the others), which is the honest accuracy figure.

Writes ``mockdata/damage_curves/calibrated-<YYYYMMDD>.json``. The API picks
the newest calibrated set as the default.

Run from the repo root:
  python backend/scripts/calibrate_damage_curves.py
  python backend/scripts/calibrate_damage_curves.py --events AL092022 AL142018 --dry-run

Post-event evidence (``scripts/build_event_evidence.py``) can separate hazard
error from vulnerability:
  --wind-correction evidence   scale each event's wind by its ASOS observed /
                               modelled ratio relative to the all-event median,
                               so the curve does not learn one storm's
                               too-strong (or too-weak) wind field
  --exclude-flood              drop tropical-storm-wind counties (modelled
                               peak < 64 kt, no ASOS reading >= 34 kt) with
                               flood reports or riverine high-water marks:
                               PCS includes private flood there and no wind
                               curve should chase it
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.curve_fit import FitOptions, Observation, fit_with_holdout, panel_sigma, predict
from app.services.damage_curves import (
    BAND_MID,
    BAND_MPH_LO,
    DEFAULT_SIGMA_COUNTY,
    DEFAULT_SIGMA_EVENT,
    curves_dir,
    insured_prior,
    load_curve_sets,
)
from app.services.event_evidence import county_evidence, load_evidence
from app.services.event_loss import resolve_storm, storm_impacts
from app.services.industry_losses import LOSS_SEGMENTS, load_actuals, tiv_for_year
from app.services.loss_calibration import implied_dr_by_band, match_event
from app.services.onlevel import onlevel_actuals
from app.services.wind_calibration import county_multipliers, fit_land_shape
from app.services.damage_curves import land_mph

MIN_OBS_PER_SEGMENT = 5
SIGMA_COUNTY_FLOOR = 0.25
SIGMA_EVENT_FLOOR = 0.15
# ASSUMPTION: an event's ASOS wind bias counts only with 20+ usable stations;
# the >50 kt subset is preferred once it has 10. The relative correction is
# clamped so one odd station network cannot swing a storm's wind by > 30%.
MIN_BIAS_STATIONS = 20
MIN_STRONG_STATIONS = 10
WIND_CORRECTION_CLAMP = (0.7, 1.3)
FLOOD_SIGNAL_MIN = 2


def event_wind_bias(storm_id: str) -> float | None:
    doc = load_evidence(storm_id)
    b = (doc or {}).get("windBias") or {}
    if (b.get("nModelAbove50Kt") or 0) >= MIN_STRONG_STATIONS and b.get("medianObsOverModelAbove50Kt"):
        return float(b["medianObsOverModelAbove50Kt"])
    if (b.get("n") or 0) >= MIN_BIAS_STATIONS and b.get("medianObsOverModel"):
        return float(b["medianObsOverModel"])
    return None


def flood_dominated(storm_id: str, geography_id: str, peak_wind_kt: int) -> bool:
    if peak_wind_kt >= 64:
        return False
    ev = county_evidence(load_evidence(storm_id), geography_id)
    if not ev or (ev["asosMaxSustainedKt"] or 0) >= 34:
        return False
    return ev["floodReports"] + ev["hwmRiverine"] >= FLOOD_SIGNAL_MIN


def _rms(values: list[float]) -> float | None:
    if not values:
        return None
    return math.sqrt(sum(v * v for v in values) / len(values))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--events", nargs="*", help="ATCF storm ids (default: every supplied event)")
    parser.add_argument("--prior", default="kcc", help="curve set used as the prior (default kcc)")
    parser.add_argument("--ridge", type=float, default=FitOptions().ridge)
    parser.add_argument("--alpha-event", type=float, default=FitOptions().alpha_event)
    # ASSUMPTION: picked by leave-one-event-out error (docs/CALCULATIONS.md):
    # all-segment holdout log RMS 0.969 at 0, 0.940 at 0.5, 0.922 at 2 and 5.
    parser.add_argument("--smooth", type=float, default=2.0,
                        help="penalty on the second difference of log DR")
    # ASSUMPTION: under 0.05% of the exposure (a band ~120 mph land and up)
    # cannot pin a band; those follow the insured prior's shape.
    parser.add_argument("--tail-min-weight", type=float, default=5e-4,
                        help="bands above the last one with this exposure share follow the prior shape")
    parser.add_argument("--multiplier", type=float, default=2.5)
    parser.add_argument(
        "--wind-factor", type=float, default=None,
        help="marine-to-land wind factor (default: the prior set's)",
    )
    parser.add_argument("--id", help="curve set id (default calibrated-YYYYMMDD)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-onlevel", action="store_true",
                        help="fit on reported losses without scaling them to the TIV valuation date")
    parser.add_argument("--wind-correction", choices=("none", "evidence"), default="none",
                        help="flat wind model only: scale each event by its ASOS bias")
    parser.add_argument(
        "--wind-model", choices=("observed", "flat"), default="observed",
        help="observed (default): land-wind shape fitted to every ASOS station; "
             "flat: windFactor only",
    )
    parser.add_argument("--exclude-flood", action="store_true")
    parser.add_argument("--county-wind-strength", type=float, default=1.0,
                        help="observed wind model: scale on each county's log wind correction")
    parser.add_argument("--county-wind", action="store_true",
                        help="observed wind model: also apply each storm's per-county station correction")
    args = parser.parse_args()

    actuals = load_actuals()
    wanted = [e.upper() for e in args.events] if args.events else sorted(actuals)
    if not wanted:
        raise SystemExit("No events in mockdata/industry_losses/. Add a CSV first.")
    prior = load_curve_sets()[args.prior]
    wind_factor = args.wind_factor if args.wind_factor is not None else prior.wind_factor

    shape = None
    wind_exponent = wind_floor = 0.0
    if args.wind_model == "observed":
        stations = [s for sid in sorted(actuals) for s in ((load_evidence(sid) or {}).get("stations") or [])]
        shape = fit_land_shape(stations)
        wind_exponent, wind_floor = shape.exponent, shape.floor
        print(f"Observed-wind shape from {shape.n_stations} stations: observed / modelled "
              f"{shape.ratio_at_ref:.3f} at 64 kt, exponent {shape.exponent:.3f}, "
              f"floor {shape.floor_ratio:.2f} (curve shape floor {shape.floor:.3f})")
        if args.wind_correction != "none":
            raise SystemExit("--wind-correction is for --wind-model flat")

    def land(mph: float) -> float:
        return land_mph(mph, wind_factor, wind_exponent, wind_floor)

    biases = {sid: event_wind_bias(sid) for sid in wanted} if args.wind_correction == "evidence" else {}
    known = sorted(b for b in biases.values() if b)
    bias_ref = known[len(known) // 2] if known else None

    obs: dict[str, list[Observation]] = {seg: [] for seg in LOSS_SEGMENTS}
    event_meta: list[dict] = []
    for storm_id in wanted:
        act = actuals.get(storm_id)
        if act is None:
            raise SystemExit(f"{storm_id}: no supplied losses")
        found = resolve_storm(storm_id)
        if found is None:
            raise SystemExit(f"{storm_id}: storm not found in IBTrACS")
        storm, source = found
        tiv = tiv_for_year(storm.year)
        if tiv.currency != act.currency:
            raise SystemExit(f"{storm_id}: actuals {act.currency} vs TIV {tiv.currency}")
        reported_total = act.total()
        on_level = None
        if not args.no_onlevel:
            act, on_level = onlevel_actuals(act, tiv.as_of)
        impacts = storm_impacts(storm, source, args.multiplier)
        rel = 1.0
        if bias_ref and biases.get(storm_id):
            lo, hi = WIND_CORRECTION_CLAMP
            rel = min(hi, max(lo, biases[storm_id] / bias_ref))
        mult = (county_multipliers(storm_id, impacts, shape, args.county_wind_strength)
                if shape and args.county_wind else {})
        if rel != 1.0:
            mult = {imp.geography_id: rel for imp in impacts}
        matched = match_event(act, impacts, tiv, land, mult)
        obs_mult = sorted(mult.values()) if shape else []
        flood_dropped = 0.0
        if args.exclude_flood:
            peak = {imp.geography_id: imp.max_wind_kt for imp in impacts}
            for seg in LOSS_SEGMENTS:
                keep = []
                for o in matched.observations[seg]:
                    if flood_dominated(storm_id, o.geography_id, peak.get(o.geography_id, 0)):
                        flood_dropped += o.actual
                    else:
                        keep.append(o)
                matched.observations[seg] = keep
        for seg in LOSS_SEGMENTS:
            obs[seg].extend(matched.observations[seg])
        miss = sum(a for _g, _s, a in matched.footprint_miss)
        gap = sum(a for _g, _s, a in matched.exposure_gap)
        meta = {
            "stormId": storm_id,
            "name": storm.name,
            "year": storm.year,
            "tiv": {"kind": tiv.kind, "year": tiv.year, "file": tiv.file},
            "actualTotal": act.total(),
            "reportedTotal": reported_total,
            "onLevelFactor": on_level["factor"] if on_level else None,
            "onLevelTarget": on_level["targetDate"] if on_level else None,
            "footprintMissLoss": miss,
            "exposureGapLoss": gap,
            "countiesMatched": {seg: len(matched.observations[seg]) for seg in LOSS_SEGMENTS},
            "windBias": biases.get(storm_id),
            "windCorrection": rel,
            "observedWindMultiplier": (
                {"median": obs_mult[len(obs_mult) // 2], "min": obs_mult[0], "max": obs_mult[-1]}
                if obs_mult else None
            ),
            "floodExcludedLoss": flood_dropped,
        }
        event_meta.append(meta)
        print(
            f"{storm_id} {storm.name} {storm.year}: actual {act.total():,.0f} {act.currency}"
            + (f" (reported x{on_level['factor']:.2f} on-level)" if on_level else "") + "; "
            f"matched {meta['countiesMatched']}; outside wind field {miss:,.0f}; no TIV {gap:,.0f}"
            + (f"; wind x{rel:.2f}" if rel != 1.0 else "")
            + (f"; flood-dominated dropped {flood_dropped:,.0f}" if flood_dropped else "")
        )

    opts = FitOptions(
        alpha_event=args.alpha_event, ridge=args.ridge, smooth=args.smooth,
        tail_min_weight=args.tail_min_weight,
    )
    segments: dict[str, list[float]] = {}
    fit_meta: dict[str, dict] = {}
    county_sig: list[tuple[float, int]] = []
    event_errs: list[float] = []
    weighted_errs: list[tuple[float, float]] = []
    # event -> [reported in field, holdout model, in-sample model], all segments
    holdout_totals: dict[str, list[float]] = {}
    for seg in LOSS_SEGMENTS:
        prior_curve = insured_prior(prior, seg)
        if len(obs[seg]) < MIN_OBS_PER_SEGMENT:
            segments[seg] = list(prior_curve)
            fit_meta[seg] = {"status": "prior", "nObs": len(obs[seg])}
            print(f"  {seg}: {len(obs[seg])} counties, keeping the {args.prior} prior")
            continue
        res = fit_with_holdout(obs[seg], prior_curve, opts)
        segments[seg] = res.curve
        for o in obs[seg]:
            cell = holdout_totals.setdefault(o.event, [0.0, 0.0, 0.0])
            cell[0] += o.actual
            cell[1] += predict(o, res.oos_curves.get(o.event, res.curve))
            cell[2] += predict(o, res.curve)
        sigma = res.oos_county_sigma if res.oos_county_sigma is not None else res.county_sigma
        if sigma is not None:
            county_sig.append((sigma, res.n_obs))
        errs = res.oos_event_errors or res.event_errors
        event_errs.extend(errs.values())
        seg_actual: dict[str, float] = {}
        for o in obs[seg]:
            seg_actual[o.event] = seg_actual.get(o.event, 0.0) + o.actual
        weighted_errs.extend((math.sqrt(seg_actual.get(ev, 0.0)), e) for ev, e in errs.items())
        fit_meta[seg] = {
            "status": "fitted",
            "nObs": res.n_obs,
            "events": res.events,
            "iterations": res.iterations,
            "objective": res.objective,
            "countyLogRmsInSample": res.county_sigma,
            "countyLogRmsHoldout": res.oos_county_sigma,
            "eventLogErrorInSample": res.event_errors,
            "eventLogErrorHoldout": res.oos_event_errors,
            "bandWeight": [round(w, 4) for w in res.band_weight],
            "impliedDrByBand": implied_dr_by_band(obs[seg]),
        }
        print(f"  {seg}: {res.n_obs} counties, {res.iterations} iterations")
        print("    land mph   prior%    fit%   weight")
        for mid, p, f, w in zip(BAND_MID, prior_curve, res.curve, res.band_weight):
            print(f"    {mid:>8.1f}  {p * 100:7.2f} {f * 100:7.2f}   {w:.3f}")
        for ev, e in errs.items():
            tag = "holdout" if res.oos_event_errors else "in-sample"
            print(f"    {ev} event total x{math.exp(e):.2f} ({tag})")

    names = {m["stormId"]: m["name"] for m in event_meta}
    print("All segments, counties in the wind field (reported $B, model $B unseen / in-sample):")
    tot_err: list[tuple[float, float]] = []
    for ev, (a, m_oos, m_in) in sorted(holdout_totals.items(), key=lambda kv: -kv[1][0]):
        if a > 0 and m_oos > 0:
            tot_err.append((math.sqrt(a), math.log(m_oos / a)))
            print(f"  {names.get(ev, ev):<10} {a / 1e9:6.1f}  {m_oos / 1e9:6.1f} x{m_oos / a:5.2f}"
                  f"   {m_in / 1e9:6.1f} x{m_in / a:5.2f}")
    if tot_err:
        w = sum(x for x, _ in tot_err)
        print(f"  all-segment holdout log RMS {math.sqrt(sum(e * e for _, e in tot_err) / len(tot_err)):.3f},"
              f" sqrt(loss)-weighted {math.sqrt(sum(x * e * e for x, e in tot_err) / w):.3f}")

    if county_sig:
        total_n = sum(n for _s, n in county_sig)
        sigma_county = math.sqrt(sum(s * s * n for s, n in county_sig) / total_n)
        sigma_county = max(SIGMA_COUNTY_FLOOR, sigma_county)
    else:
        sigma_county = DEFAULT_SIGMA_COUNTY
    # ASSUMPTION: an event spread from fewer than three events is noise, so
    # keep the default until there are three.
    ev_rms = _rms(event_errs)
    if ev_rms is not None and len(wanted) >= 3:
        sigma_event = max(SIGMA_EVENT_FLOOR, ev_rms)
    else:
        sigma_event = DEFAULT_SIGMA_EVENT

    wsum = sum(w for w, _ in weighted_errs) or 1.0
    sigma_event_weighted = math.sqrt(sum(w * e * e for w, e in weighted_errs) / wsum)

    # Panel band only. See curve_fit.panel_sigma.
    sigma_panel = panel_sigma([(a, m) for a, m, _ in holdout_totals.values()])

    book = tiv_for_year(datetime.now(UTC).year)
    seg_tiv = {seg: sum(v.get(seg, 0.0) for v in book.county.values()) for seg in LOSS_SEGMENTS}
    book_total = sum(seg_tiv.values()) or 1.0

    now = datetime.now(UTC)
    curve_id = args.id or f"calibrated-{now:%Y%m%d}"
    payload = {
        "id": curve_id,
        "label": f"Calibrated {now:%Y-%m-%d} ({len(wanted)} events)",
        "kind": "calibrated",
        "createdAt": now.isoformat(timespec="seconds"),
        "bandsMphLo": list(BAND_MPH_LO),
        "segments": {seg: [round(v, 6) for v in vals] for seg, vals in segments.items()},
        "windFactor": wind_factor,
        "windExponent": round(wind_exponent, 4),
        "windFloor": round(wind_floor, 4),
        "deductible": {},
        "sigmaLogCounty": round(sigma_county, 4),
        "sigmaLogEvent": round(sigma_event, 4),
        "sigmaLogEventWeighted": round(sigma_event_weighted, 4),
        "fit": {
            "prior": args.prior,
            "target": "insured loss (deductible learned in the curve)",
            "ridge": args.ridge,
            "alphaEvent": args.alpha_event,
            "smooth": args.smooth,
            "tailMinWeight": args.tail_min_weight,
            "multiplier": args.multiplier,
            # TIV share by segment in the industry book: the impact panel blends
            # the segment curves with it for a client's bundled TIV.
            "bookMix": {seg: round(v / book_total, 4) for seg, v in seg_tiv.items()},
            # Spread the impact panel shows. The all-storm sigma stays on
            # sigmaLogEvent for the industry-loss P10–P90.
            "sigmaLogPanel": None if sigma_panel is None else round(sigma_panel, 4),
            "windCorrection": args.wind_correction,
            "windModel": args.wind_model,
            "countyWind": args.county_wind,
            "windShape": (
                {"ratioAtRef": round(shape.ratio_at_ref, 4), "exponent": round(shape.exponent, 4),
                 "floorRatio": shape.floor_ratio, "nStations": shape.n_stations}
                if shape else None
            ),
            "windBiasReference": bias_ref,
            "excludeFlood": args.exclude_flood,
            "events": event_meta,
            "segments": fit_meta,
        },
    }
    print(f"sigma county {sigma_county:.3f}, sigma event {sigma_event:.3f}, "
          f"sigma event sqrt(loss)-weighted {sigma_event_weighted:.3f}")
    if args.dry_run:
        print("Dry run, nothing written.")
        return
    out_dir = curves_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{curve_id}.json"
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
