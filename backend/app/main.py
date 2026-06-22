"""FastAPI app entry point.

Phase 1 wires the dataset / dataset-group / exposures / ert-jobs / exports
routers under ``/api`` and converts all unhandled errors to the canonical
:class:`~app.models.warnings.ErrorEnvelope` shape so the wire is consistent
(ERROR_HANDLING.md).

Domain outcomes (missing IED denominator, failed ERT job, county fallback) are
NOT errors — they ride in 200 responses as warnings (CLAUDE.md rule 11).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api import (
    admin,
    calc,
    cedents,
    counties,
    dataset_groups,
    ert_jobs,
    exports,
    exposures,
    hurricanes,
    live,
)
from .config import get_settings
from .models.enums import ErrorCode
from .models.warnings import ErrorEnvelope, ErrorEnvelopeBody

logger = logging.getLogger(__name__)

settings = get_settings()

app = FastAPI(
    title="Exposure Eclipse API",
    version="0.1.0",
    description="Property Cat exposure management workbench — backend API.",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@api.get("/health", tags=["meta"])
def health() -> dict[str, object]:
    """Liveness probe — see docs/API_SPEC.md table at line 318."""
    return {
        "status": "ok",
        "service": "exposure-eclipse-backend",
        "version": app.version,
        "dataProvider": settings.data_provider,
    }


app.include_router(api)
app.include_router(admin.router, prefix="/api")
app.include_router(calc.router, prefix="/api")
app.include_router(cedents.router, prefix="/api")
app.include_router(counties.router, prefix="/api")
app.include_router(dataset_groups.router, prefix="/api")
app.include_router(exposures.router, prefix="/api")
app.include_router(ert_jobs.router, prefix="/api")
app.include_router(exports.router, prefix="/api")
app.include_router(hurricanes.router, prefix="/api")
app.include_router(live.router, prefix="/api")


# ───────────────────────── Exception handlers ─────────────────────────


def _envelope(
    *,
    code: ErrorCode | str,
    message: str,
    status_code: int,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    """Wrap any error into the canonical :class:`ErrorEnvelope` JSON body."""
    code_str = code.value if isinstance(code, ErrorCode) else str(code)
    try:
        envelope_code = ErrorCode(code_str)
    except ValueError:
        envelope_code = ErrorCode.INTERNAL_ERROR
    body = ErrorEnvelope(
        error=ErrorEnvelopeBody(
            code=envelope_code,
            message=message,
            details=details,
            trace_id=str(uuid.uuid4()),
            timestamp=datetime.now(timezone.utc),
        )
    )
    return JSONResponse(status_code=status_code, content=body.model_dump(by_alias=True, mode="json"))


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Convert Pydantic/FastAPI validation errors → ``VALIDATION_ERROR`` 422 envelope."""
    return _envelope(
        code=ErrorCode.VALIDATION_ERROR,
        message="Request validation failed.",
        status_code=422,
        details={"errors": jsonable_encoder(exc.errors())},
    )


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    """Reshape ``HTTPException`` payloads into the canonical envelope."""
    detail = exc.detail
    if isinstance(detail, dict):
        code = detail.get("code", ErrorCode.INTERNAL_ERROR.value)
        message = detail.get("message", str(exc.detail))
        details = detail.get("details")
    else:
        code = ErrorCode.INTERNAL_ERROR.value
        message = str(detail) if detail else "Unexpected error."
        details = None
    return _envelope(
        code=code,
        message=message,
        status_code=exc.status_code,
        details=details,
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:  # pragma: no cover — last-resort guard
    logger.exception("Unhandled exception on %s", request.url.path)
    return _envelope(
        code=ErrorCode.INTERNAL_ERROR,
        message="An unexpected error occurred.",
        status_code=500,
        details={"type": exc.__class__.__name__},
    )
