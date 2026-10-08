/** Break a track where one step crosses the antimeridian.

A segment from 179°E to 179°W is a short step on the globe and a line
across the whole Pacific if it is drawn as-is. */
export function segmentsAvoidingAntimeridian<T extends { lon: number }>(
  coords: T[],
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const point of coords) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(point.lon - prev.lon) > 180) {
      if (cur.length >= 2) out.push(cur);
      cur = [point];
    } else {
      cur.push(point);
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}
