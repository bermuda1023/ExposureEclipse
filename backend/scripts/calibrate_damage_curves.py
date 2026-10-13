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

from app.services.curve_fit import FitOptions, Observation, fit_with_holdout
from app.services.damage_curves import (
    BAND_MPH_LO,
    DEFAULT_SIGMA_COUNTY,
    DEFAULT_SIGMA_EVENT,
    curves_dir,
    load_curve_sets,
)
from app.services.event_loss import resolve_storm, storm_impacts
from app.services.industry_losses import LOSS_SEGMENTS, load_actuals, tiv_for_year
from app.services.loss_calibration import implied_dr_by_band, match_event

MIN_OBS_PER_SEGMENT = 5
SIGMA_COUNTY_FLOOR = 0.25
SIGMA_EVENT_FLOOR = 0.15


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
    parser.add_argument("--multiplier", type=float, default=2.5)
    parser.add_argument("--id", help="curve set id (default calibrated-YYYYMMDD)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    actuals = load_actuals()
    wanted = [e.upper() for e in args.events] if args.events else sorted(actuals)
    if not wanted:
        raise SystemExit("No events in mockdata/industry_losses/. Add a CSV first.")
    prior = load_curve_sets()[args.prior]

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
        impacts = storm_impacts(storm, source, args.multiplier)
        matched = match_event(act, impacts, tiv)
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
            "footprintMissLoss": miss,
            "exposureGapLoss": gap,
            "countiesMatched": {seg: len(matched.observations[seg]) for seg in LOSS_SEGMENTS},
        }
        event_meta.append(meta)
        print(
            f"{storm_id} {storm.name} {storm.year}: actual {act.total():,.0f} {act.currency}; "
            f"matched {meta['countiesMatched']}; outside wind field {miss:,.0f}; no TIV {gap:,.0f}"
        )

    opts = FitOptions(alpha_event=args.alpha_event, ridge=args.ridge)
    segments: dict[str, list[float]] = {}
    fit_meta: dict[str, dict] = {}
    county_sig: list[tuple[float, int]] = []
    event_errs: list[float] = []
    for seg in LOSS_SEGMENTS:
        prior_curve = prior.segments[seg]
        if len(obs[seg]) < MIN_OBS_PER_SEGMENT:
            segments[seg] = list(prior_curve)
            fit_meta[seg] = {"status": "prior", "nObs": len(obs[seg])}
            print(f"  {seg}: {len(obs[seg])} counties, keeping the {args.prior} prior")
            continue
        res = fit_with_holdout(obs[seg], prior_curve, opts)
        segments[seg] = res.curve
        sigma = res.oos_county_sigma if res.oos_county_sigma is not None else res.county_sigma
        if sigma is not None:
            county_sig.append((sigma, res.n_obs))
        errs = res.oos_event_errors or res.event_errors
        event_errs.extend(errs.values())
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
        print("    mph   prior%    fit%   weight")
        for lo, p, f, w in zip(BAND_MPH_LO, prior_curve, res.curve, res.band_weight):
            print(f"    {lo:>3}  {p * 100:7.2f} {f * 100:7.2f}   {w:.3f}")
        for ev, e in errs.items():
            tag = "holdout" if res.oos_event_errors else "in-sample"
            print(f"    {ev} event total x{math.exp(e):.2f} ({tag})")

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

    now = datetime.now(UTC)
    curve_id = args.id or f"calibrated-{now:%Y%m%d}"
    payload = {
        "id": curve_id,
        "label": f"Calibrated {now:%Y-%m-%d} ({len(wanted)} events)",
        "kind": "calibrated",
        "createdAt": now.isoformat(timespec="seconds"),
        "bandsMphLo": list(BAND_MPH_LO),
        "segments": {seg: [round(v, 6) for v in vals] for seg, vals in segments.items()},
        "sigmaLogCounty": round(sigma_county, 4),
        "sigmaLogEvent": round(sigma_event, 4),
        "fit": {
            "prior": args.prior,
            "ridge": args.ridge,
            "alphaEvent": args.alpha_event,
            "multiplier": args.multiplier,
            "events": event_meta,
            "segments": fit_meta,
        },
    }
    print(f"sigma county {sigma_county:.3f}, sigma event {sigma_event:.3f}")
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
