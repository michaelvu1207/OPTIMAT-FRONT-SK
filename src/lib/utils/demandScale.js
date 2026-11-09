// Fixed bands reflect the observed long-tailed distribution (1–77,759 events
// per city). Keep them stable across filters and zoom levels for comparison.
export const DEMAND_BANDS = [
  { min: 1, label: '1–99', color: '#2563eb', textColor: '#ffffff' },
  { min: 100, label: '100–999', color: '#0f766e', textColor: '#ffffff' },
  { min: 1000, label: '1,000–9,999', color: '#facc15', textColor: '#422006' },
  { min: 10000, label: '10,000–49,999', color: '#f97316', textColor: '#431407' },
  { min: 50000, label: '50,000+', color: '#b91c1c', textColor: '#ffffff' },
];

export function demandStyle(count) {
  const value = Number.isFinite(count) ? Math.max(1, count) : 1;
  const band = DEMAND_BANDS.findLast(b => value >= b.min) ?? DEMAND_BANDS[0];
  // Logarithmic diameters keep small counts readable without allowing the
  // largest clusters to cover the map. Color continues to encode absolute count.
  const size = Math.round(36 + 48 * Math.min(1, Math.log10(value) / 5));
  return { ...band, size };
}
