/**
 * FIPS state code (2-digit string) → USPS postal abbreviation.
 *
 * Mirrors `backend/scripts/build_geo.py:STATE_FIPS_TO_USPS`. Used to derive our
 * canonical `geographyId` ("US-FL", "US-FL-12086") from the FIPS-keyed properties
 * baked into the Mapbox vector tilesets.
 */
export const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
  "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
  "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
  "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY",
};

/** Build a state `geographyId` ("US-FL") from a 2-digit state FIPS string. */
export function stateGeographyIdFromFips(fips: string | number | undefined | null): string | null {
  if (fips === undefined || fips === null) return null;
  const s = String(fips).padStart(2, "0");
  const usps = FIPS_TO_USPS[s];
  return usps ? `US-${usps}` : null;
}

/** Build a county `geographyId` ("US-FL-12086") from a 5-digit county GEOID string. */
export function countyGeographyIdFromGeoid(geoid: string | number | undefined | null): string | null {
  if (geoid === undefined || geoid === null) return null;
  const g = String(geoid).padStart(5, "0");
  const usps = FIPS_TO_USPS[g.slice(0, 2)];
  return usps ? `US-${usps}-${g}` : null;
}

/** Inverse — split our canonical id into the parts the tilesets are keyed by. */
export function partsFromGeographyId(id: string): {
  level: "state" | "county" | null;
  stateUsps: string | null;
  stateFips: string | null;
  countyGeoid: string | null;
} {
  const parts = id.split("-");
  if (parts.length === 2 && parts[0] === "US") {
    const usps = parts[1]!;
    const fips =
      Object.entries(FIPS_TO_USPS).find(([, u]) => u === usps)?.[0] ?? null;
    return { level: "state", stateUsps: usps, stateFips: fips, countyGeoid: null };
  }
  if (parts.length === 3 && parts[0] === "US") {
    const usps = parts[1]!;
    const geoid = parts[2]!;
    return { level: "county", stateUsps: usps, stateFips: geoid.slice(0, 2), countyGeoid: geoid };
  }
  return { level: null, stateUsps: null, stateFips: null, countyGeoid: null };
}
