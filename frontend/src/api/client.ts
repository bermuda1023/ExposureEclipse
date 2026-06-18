/**
 * Typed API client — the ONLY place in the frontend that talks to the backend.
 *
 * CLAUDE.md rule 1: no component outside src/api/ imports `fetch` against `/api`.
 * Handles the canonical ErrorEnvelope shape from ERROR_HANDLING.md so callers can
 * `throw` with structured error info.
 */

import type { ErrorCode, WarningCode, WarningSeverity } from "../types/contracts";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

export interface ApiWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  context?: Record<string, unknown>;
}

export interface ErrorEnvelopeBody {
  code: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
  timestamp?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details?: Record<string, unknown>;
  readonly traceId?: string;

  constructor(status: number, body: ErrorEnvelopeBody) {
    super(body.message || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.traceId = body.traceId;
  }
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = opts;
  const init: RequestInit = {
    ...rest,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(buildUrl(path, query), init);
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON body — leave json=null; error path below still produces an ApiError.
      json = null;
    }
  }

  if (!res.ok) {
    const envelope = (json as { error?: ErrorEnvelopeBody })?.error ?? {
      code: "INTERNAL_ERROR",
      message: res.statusText || text || "Request failed",
    };
    throw new ApiError(res.status, envelope);
  }

  return json as T;
}

/** Convenience helpers — most call sites use these directly. */
export const apiGet = <T>(path: string, query?: RequestOptions["query"]) =>
  request<T>(path, { method: "GET", query });

export const apiPost = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body });
