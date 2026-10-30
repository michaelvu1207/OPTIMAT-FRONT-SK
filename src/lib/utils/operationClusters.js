export const MAX_CLUSTER_ZOOM = 18;

/** @typedef {{ city: string, lat: number, lng: number, count: number }} ActivityPoint */
/** @typedef {{ x: number, y: number, lat: number, lng: number, count: number, members: ActivityPoint[] }} ActivityCluster */

function project(lat, lng) {
  const sine = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI) };
}

function cluster(x, y, count, members) {
  return { x, y, count, members, lng: x * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI };
}

/**
 * Build a stable hierarchy in Web Mercator pixels. Each lower zoom combines
 * whole children, so zooming in only splits groups and preserves event totals.
 * Counts are event weights, not the number of city reference points.
 * @param {ActivityPoint[]} points
 * @param {number} radius
 * @returns {ActivityCluster[][]}
 */
export function buildOperationClusters(points, radius = 76) {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Cluster radius must be positive.');
  const valid = points.filter(p => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
    && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180 && Number.isSafeInteger(p.count) && p.count > 0);
  let children = valid.map(p => {
    const { x, y } = project(p.lat, p.lng);
    return cluster(x, y, p.count, [p]);
  });
  const levels = [];
  for (let zoom = MAX_CLUSTER_ZOOM; zoom >= 0; zoom--) {
    const scale = 256 * 2 ** zoom;
    const remaining = [...children].sort((a, b) => b.count - a.count || a.x - b.x || a.y - b.y
      || a.members[0].city.localeCompare(b.members[0].city));
    const groups = [];
    while (remaining.length) {
      const seed = remaining.shift();
      const joined = [seed];
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (Math.hypot(remaining[i].x - seed.x, remaining[i].y - seed.y) * scale <= radius) {
          joined.push(...remaining.splice(i, 1));
        }
      }
      const count = joined.reduce((sum, node) => sum + node.count, 0);
      const members = joined.flatMap(node => node.members).sort((a, b) => a.city.localeCompare(b.city));
      groups.push(cluster(joined.reduce((sum, node) => sum + node.x * node.count, 0) / count,
        joined.reduce((sum, node) => sum + node.y * node.count, 0) / count, count, members));
    }
    levels[zoom] = groups;
    children = groups;
  }
  return levels;
}
