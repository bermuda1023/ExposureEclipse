import { apiPost } from "./client";
import type {
  DetailRequest,
  DetailResponse,
  MapRequest,
  MapResponse,
  PivotRequest,
  PivotResponse,
} from "./types";

export const fetchMap = (req: MapRequest, signal?: AbortSignal) =>
  apiPost<MapResponse>("/exposures/map", req, signal);

export const fetchDetail = (req: DetailRequest, signal?: AbortSignal) =>
  apiPost<DetailResponse>("/exposures/detail", req, signal);

export const fetchPivot = (req: PivotRequest, signal?: AbortSignal) =>
  apiPost<PivotResponse>("/exposures/pivot", req, signal);
