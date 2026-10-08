/**
 * Collapsed by default. Opening it resolves a network-address position
 * and loads a 5-day GFS and ECMWF card. The map dot follows that flag.
 */

import { useEffect, useState } from "react";
import { fetchDailyForecast, type DailyDay } from "../../api/live";
import { lookupIpLocation } from "../../api/ipLocation";
import { useLiveStormStore } from "../../state/liveStorm";

function compass(deg: number | null): string {
  if (deg == null || Number.isNaN(deg)) return "";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return dirs[i];
}

function weatherLabel(code: number | null): string {
  if (code == null) return "—";
  if (code === 0) return "Clear";
  if (code <= 3) return "Clouds";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunder";
  return "Mix";
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function modelName(model: string): string {
  if (model === "gfs") return "GFS";
  if (model === "ecmwf") return "ECMWF";
  return model;
}

function DayLine({ name, day }: { name: string; day: DailyDay | undefined }) {
  if (!day) {
    return (
      <div style={{ color: "var(--ink-500)" }}>{name}: no day from this model</div>
    );
  }
  const hi = day.tempMaxF == null ? "—" : Math.round(day.tempMaxF);
  const lo = day.tempMinF == null ? "—" : Math.round(day.tempMinF);
  const rain = day.precipIn == null ? "—" : `${day.precipIn.toFixed(2)} in`;
  const wind = day.windMaxKt == null ? "—" : `${Math.round(day.windMaxKt)} kt`;
  const gust = day.gustMaxKt == null ? "" : ` gust ${Math.round(day.gustMaxKt)}`;
  const dir = compass(day.windDirDeg);
  return (
    <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
      <span style={{ fontWeight: 700, width: 52, flexShrink: 0 }}>{name}</span>
      <span style={{ flex: 1 }}>
        {weatherLabel(day.weatherCode)} · {hi}/{lo}°F · {rain} · {wind}{gust} {dir}
      </span>
    </div>
  );
}

export function MyLocationSection() {
  const show = useLiveStormStore((s) => s.showMyLocation);
  const place = useLiveStormStore((s) => s.myPlace);
  const placeStatus = useLiveStormStore((s) => s.myPlaceStatus);
  const forecast = useLiveStormStore((s) => s.dailyForecast);
  const forecastStatus = useLiveStormStore((s) => s.dailyForecastStatus);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!show) return;
    const cur = useLiveStormStore.getState();
    if (cur.myPlace || cur.myPlaceStatus === "loading") return;
    let cancelled = false;
    cur.setMyPlaceStatus("loading");
    void lookupIpLocation()
      .then((found) => {
        if (cancelled) return;
        const st = useLiveStormStore.getState();
        if (!found) {
          st.setMyPlaceStatus("error");
          return;
        }
        st.setMyPlace(found);
        st.setMyPlaceStatus("ok");
      })
      .catch(() => {
        if (!cancelled) useLiveStormStore.getState().setMyPlaceStatus("error");
      });
    return () => {
      cancelled = true;
      const st = useLiveStormStore.getState();
      if (!st.myPlace && st.myPlaceStatus === "loading") st.setMyPlaceStatus("idle");
    };
  }, [show, retry]);

  useEffect(() => {
    if (!show || !place) return;
    let cancelled = false;
    useLiveStormStore.getState().setDailyForecastStatus("loading");
    void fetchDailyForecast(place.lat, place.lon)
      .then((fc) => {
        if (cancelled) return;
        const st = useLiveStormStore.getState();
        st.setDailyForecast(fc);
        const any = fc.models.some((m) => m.days.length > 0);
        st.setDailyForecastStatus(any ? "ok" : "empty");
      })
      .catch(() => {
        if (!cancelled) {
          useLiveStormStore.getState().setDailyForecast(null);
          useLiveStormStore.getState().setDailyForecastStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [show, place]);

  const dates = forecast
    ? Array.from(new Set(forecast.models.flatMap((m) => m.days.map((d) => d.date))))
    : [];

  return (
    <details
      open={show}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next !== useLiveStormStore.getState().showMyLocation) {
          useLiveStormStore.getState().setShowMyLocation(next);
        }
      }}
      style={{
        borderTop: "1px solid var(--ink-200)",
        paddingTop: 8,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: "0.68rem",
          fontWeight: 700,
          color: "var(--ink-600)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        My location
      </summary>
      <div style={{ display: "grid", gap: 6, paddingTop: 8 }}>
        <div style={{ fontSize: "0.66rem", color: "var(--ink-500)", lineHeight: 1.4 }}>
          Approximate position from the network address of this browser. Not GPS.
          The address is not stored. The dot is hidden until this section is open.
        </div>
        {placeStatus === "loading" && (
          <div style={{ color: "var(--ink-500)" }}>Finding this network…</div>
        )}
        {placeStatus === "error" && (
          <div style={{ color: "var(--error-700)" }}>
            Could not resolve a position from this network.
            <button
              type="button"
              onClick={() => {
                const st = useLiveStormStore.getState();
                st.setMyPlace(null);
                st.setMyPlaceStatus("idle");
                st.setDailyForecast(null);
                st.setDailyForecastStatus("idle");
                setRetry((n) => n + 1);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                marginLeft: 6,
                textDecoration: "underline",
                color: "var(--ink-700)",
              }}
            >
              Try again
            </button>
          </div>
        )}
        {place && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{place.label}</div>
              <div style={{ fontSize: "0.66rem", color: "var(--ink-500)" }}>
                {place.lat.toFixed(2)}, {place.lon.toFixed(2)}
                {forecast?.timezone ? ` · ${forecast.timezone}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => useLiveStormStore.getState().requestMyLocationFocus()}
              style={{
                all: "unset",
                cursor: "pointer",
                fontSize: "0.66rem",
                fontWeight: 700,
                color: "#5b21b6",
                border: "1px solid #c4b5fd",
                borderRadius: 3,
                padding: "3px 6px",
                alignSelf: "start",
              }}
            >
              Center map
            </button>
          </div>
        )}
        {forecastStatus === "loading" && (
          <div style={{ color: "var(--ink-500)" }}>Loading GFS and ECMWF…</div>
        )}
        {forecastStatus === "error" && (
          <div style={{ color: "var(--error-700)" }}>
            The 5-day forecast did not load.
          </div>
        )}
        {forecastStatus === "empty" && (
          <div style={{ color: "var(--ink-600)" }}>
            Both models were unreachable for this point.
          </div>
        )}
        {forecastStatus === "ok" && dates.map((date) => (
          <div key={date} style={{ display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 700, color: "var(--ink-800)" }}>{dayLabel(date)}</div>
            {forecast!.models.map((m) => (
              <DayLine
                key={m.model}
                name={modelName(m.model)}
                day={m.days.find((d) => d.date === date)}
              />
            ))}
          </div>
        ))}
        {forecastStatus === "ok" && (
          <div style={{ fontSize: "0.62rem", color: "var(--ink-500)", lineHeight: 1.35 }}>
            Daily high and low, rain, and the daily maximum wind. GFS and ECMWF
            through Open-Meteo. Not the hourly wind on a map click, and not a
            landfall forecast.
          </div>
        )}
      </div>
    </details>
  );
}
