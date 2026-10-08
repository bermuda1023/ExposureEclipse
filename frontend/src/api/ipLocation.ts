/**
 * Approximate position from the browser's public address.
 *
 * Called from the browser on purpose. A lookup on the API server would
 * place the server, and localhost has nothing to geocode. This is not a
 * GPS prompt. The address itself is not kept.
 */

export interface IpPlace {
  lat: number;
  lon: number;
  label: string;
}

interface IpWhoBody {
  success?: boolean;
  city?: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export async function lookupIpLocation(): Promise<IpPlace | null> {
  const res = await fetch("https://ipwho.is/");
  if (!res.ok) return null;
  const body = (await res.json()) as IpWhoBody;
  if (
    body.success === false
    || typeof body.latitude !== "number"
    || typeof body.longitude !== "number"
    || Number.isNaN(body.latitude)
    || Number.isNaN(body.longitude)
  ) {
    return null;
  }
  const parts = [body.city, body.region].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const label = parts.length > 0
    ? parts.join(", ")
    : (body.country && body.country.length > 0 ? body.country : "Approximate location");
  return { lat: body.latitude, lon: body.longitude, label };
}
