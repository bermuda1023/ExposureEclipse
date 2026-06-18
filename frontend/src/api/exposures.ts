import { apiPost } from "./client";
import type {
  DetailRequest,
  DetailResponse,
  MapRequest,
  MapResponse,
  PivotRequest,
  PivotResponse,
} from "./types";

export const fetchMap = (req: MapRequest) =>
  apiPost<MapResponse>("/exposures/map", req);

export const fetchDetail = (req: DetailRequest) =>
  apiPost<DetailResponse>("/exposures/detail", req);

export const fetchPivot = (req: PivotRequest) =>
  apiPost<PivotResponse>("/exposures/pivot", req);
