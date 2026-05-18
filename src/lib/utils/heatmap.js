const HEAT_COLORS = {
  origins: '#2563eb',
  destinations: '#ea580c',
  combined: '#7c3aed',
};

function isValidCoordinate(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Math.abs(Number(value[0])) <= 90
    && Math.abs(Number(value[1])) <= 180;
}

function bucketCoordinate(coordinate, binSize) {
  const lat = Number(coordinate[0]);
  const lng = Number(coordinate[1]);
  return [
    Math.round(lat / binSize) * binSize,
    Math.round(lng / binSize) * binSize,
  ];
}

function addPoint(bins, coordinate, kind, binSize) {
  if (!isValidCoordinate(coordinate)) return;
  const [lat, lng] = bucketCoordinate(coordinate, binSize);
  const key = `${kind}:${lat.toFixed(6)}:${lng.toFixed(6)}`;
  const existing = bins.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  bins.set(key, { latLng: [lat, lng], count: 1, kind });
}

export function buildDemandHeatPoints(trips, options = {}) {
  const mode = options.mode ?? 'combined';
  const binSize = Number(options.binSize ?? 0.015);
  const minRadius = Number(options.minRadius ?? 7);
  const maxRadius = Number(options.maxRadius ?? 30);
  const bins = new Map();

  for (const trip of trips ?? []) {
    if (!trip) continue;
    if (mode === 'origins' || mode === 'combined') {
      addPoint(bins, trip.origin, mode === 'combined' ? 'combined' : 'origins', binSize);
    }
    if (mode === 'destinations' || mode === 'combined') {
      addPoint(bins, trip.destination, mode === 'combined' ? 'combined' : 'destinations', binSize);
    }
  }

  const points = Array.from(bins.values());
  const maxCount = points.reduce((max, point) => Math.max(max, point.count), 0) || 1;

  return points
    .map((point) => {
      const strength = point.count / maxCount;
      const radius = minRadius + (maxRadius - minRadius) * Math.sqrt(strength);
      return {
        ...point,
        radius: Number(radius.toFixed(2)),
        fillColor: HEAT_COLORS[point.kind] ?? HEAT_COLORS.combined,
        fillOpacity: Number((0.28 + 0.42 * strength).toFixed(2)),
      };
    })
    .sort((a, b) => a.count - b.count);
}
