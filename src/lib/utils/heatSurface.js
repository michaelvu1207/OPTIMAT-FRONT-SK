// Geographic Gaussian smoothing of published coarse cells, never city centroids.
const R = 6371000;
const cos = Math.cos(38 * Math.PI / 180);
export const projectHeat = (lat, lng) => [lng * Math.PI / 180 * R * cos, lat * Math.PI / 180 * R];
export function heatSamples(cells) {
  return cells.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.count > 0)
    .map(p => ({ xy: projectHeat(p.lat, p.lng), weight: p.count }));
}
export function densityAt(x, y, samples) {
  let sum = 0;
  for (const p of samples) {
    const d2 = (x - p.xy[0]) ** 2 + (y - p.xy[1]) ** 2;
    if (d2 <= 9000000) sum += p.weight * Math.exp(-d2 / 2000000);
  }
  return sum;
}
export function heatReference(samples) {
  return Math.max(1, ...samples.map(p => densityAt(...p.xy, samples)));
}
export function heatColor(value) {
  if (!(value > 0.001)) return [0, 0, 0, 0];
  const stops = [[55,165,218],[51,190,110],[213,230,62],[255,193,36],[245,96,32],[198,35,45]];
  const v = Math.min(1, Math.sqrt(value));
  const pos = v * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(pos)), f = pos - i;
  return [...stops[i].map((c, j) => Math.round(c + f * (stops[i + 1][j] - c))), Math.round(210 * Math.min(1, v * 4))];
}
