"""Admin endpoints — programme treaty metadata + EDM linkage."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request

from ..models.common import CamelModel
from ..providers import ExposureDataProvider, get_provider
from ..services.treaty_metadata import (
    EDMLink,
    TreatyView,
    joined_view,
    load_linkage,
    load_treaty_rows,
    parse_csv,
    save_linkage,
    save_treaty_rows,
)

router = APIRouter(prefix="/admin", tags=["admin"])


# ─────────────────────────── wire types ───────────────────────────


class TreatyRowOut(CamelModel):
    fs_display_id: str
    reinsured_name: str
    broker_name: str
    broker_office: str | None
    layer_number: int
    inception_date: str
    layer_status: str
    risk_id: str
    currency: str
    weighted_share_pct: float
    signed_line_pct: float
    risk_location: str
    tji: str | None
    cob1: str | None
    cob2: str | None
    cob3: str | None
    event_limit_usd: float
    deductible_usd: float
    rol_pct: float
    gul_pct: float


class TreatyViewOut(CamelModel):
    treaty: TreatyRowOut
    server_name: str | None
    edm_database_name: str | None
    status: str  # "mapped" | "unmapped"
    suggested_server: str | None
    suggested_edm: str | None


class ProgrammesListResponse(CamelModel):
    rows: list[TreatyViewOut]
    mapped_count: int
    unmapped_count: int


class EDMLinkInput(CamelModel):
    server_name: str | None = None
    edm_database_name: str | None = None


class BulkLinkInput(CamelModel):
    """Bulk save — full replace of the linkage map."""

    links: dict[str, EDMLinkInput]


class ImportResponse(CamelModel):
    parsed_count: int
    rows: list[TreatyViewOut]


# ─────────────────────────── helpers ───────────────────────────


def _cedents_index(provider: ExposureDataProvider) -> dict:
    """Return a dict shaped like cedents.json — used for auto-suggest."""
    out_c: list[dict] = []
    for c in provider.list_cedents():
        d = c.model_dump(by_alias=True)
        out_c.append(d)
    return {"cedents": out_c}


def _view_to_out(v: TreatyView) -> TreatyViewOut:
    r = v.treaty
    return TreatyViewOut(
        treaty=TreatyRowOut(
            fs_display_id=r.fs_display_id,
            reinsured_name=r.reinsured_name,
            broker_name=r.broker_name,
            broker_office=r.broker_office,
            layer_number=r.layer_number,
            inception_date=r.inception_date,
            layer_status=r.layer_status,
            risk_id=r.risk_id,
            currency=r.currency,
            weighted_share_pct=r.weighted_share_pct,
            signed_line_pct=r.signed_line_pct,
            risk_location=r.risk_location,
            tji=r.tji,
            cob1=r.cob1,
            cob2=r.cob2,
            cob3=r.cob3,
            event_limit_usd=r.event_limit_usd,
            deductible_usd=r.deductible_usd,
            rol_pct=r.rol_pct,
            gul_pct=r.gul_pct,
        ),
        server_name=v.link.server_name,
        edm_database_name=v.link.edm_database_name,
        status=v.status,
        suggested_server=v.suggested_server,
        suggested_edm=v.suggested_edm,
    )


# ─────────────────────────── endpoints ───────────────────────────


@router.get("/programmes", response_model=ProgrammesListResponse)
def list_programmes(
    provider: ExposureDataProvider = Depends(get_provider),
) -> ProgrammesListResponse:
    rows = joined_view(cedents_index=_cedents_index(provider))
    mapped = sum(1 for r in rows if r.status == "mapped")
    unmapped = len(rows) - mapped
    return ProgrammesListResponse(
        rows=[_view_to_out(r) for r in rows],
        mapped_count=mapped,
        unmapped_count=unmapped,
    )


@router.put("/programmes/{fs_display_id}/edm-link", response_model=TreatyViewOut)
def update_link(
    fs_display_id: str,
    payload: EDMLinkInput,
    provider: ExposureDataProvider = Depends(get_provider),
) -> TreatyViewOut:
    """Update one programme's EDM linkage."""
    rows = load_treaty_rows()
    if not any(r.fs_display_id == fs_display_id for r in rows):
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DATASET_NOT_FOUND",
                "message": f"Treaty '{fs_display_id}' not found.",
            },
        )
    links = load_linkage()
    if payload.server_name or payload.edm_database_name:
        links[fs_display_id] = EDMLink(
            fs_display_id=fs_display_id,
            server_name=payload.server_name,
            edm_database_name=payload.edm_database_name,
        )
    else:
        links.pop(fs_display_id, None)
    save_linkage(links)
    rows = joined_view(cedents_index=_cedents_index(provider))
    match = next(r for r in rows if r.treaty.fs_display_id == fs_display_id)
    return _view_to_out(match)


@router.post("/programmes/edm-links", response_model=ProgrammesListResponse)
def bulk_save_links(
    payload: BulkLinkInput,
    provider: ExposureDataProvider = Depends(get_provider),
) -> ProgrammesListResponse:
    """Replace the entire EDM linkage map in one call."""
    links: dict[str, EDMLink] = {}
    for fs_id, lk in payload.links.items():
        if not (lk.server_name or lk.edm_database_name):
            continue
        links[fs_id] = EDMLink(
            fs_display_id=fs_id,
            server_name=lk.server_name,
            edm_database_name=lk.edm_database_name,
        )
    save_linkage(links)
    return list_programmes(provider=provider)


@router.post("/programmes/import", response_model=ImportResponse)
async def import_csv(
    request: Request,
    provider: ExposureDataProvider = Depends(get_provider),
) -> ImportResponse:
    """Accept a CSV body (text/csv or text/plain), parse, persist as the
    new treaty list, and return the joined view for preview/confirmation."""
    raw = (await request.body()).decode("utf-8", errors="replace")
    if not raw.strip():
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "Empty CSV body."},
        )
    parsed = parse_csv(raw)
    if not parsed:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "No rows parsed. Expected columns include FS display, Reinsured, Broker, Layer, Inception, Event limit USD, Deductible USD, etc.",
            },
        )
    save_treaty_rows(parsed)
    rows = joined_view(cedents_index=_cedents_index(provider))
    return ImportResponse(
        parsed_count=len(parsed),
        rows=[_view_to_out(r) for r in rows],
    )


# Suppress lint about unused import — kept for downstream callers.
_ = json


__all__ = ["router"]
