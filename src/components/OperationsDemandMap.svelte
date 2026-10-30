<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map as LeafletMap, LayerGroup } from 'leaflet';
  import { DEFAULT_MAP_STYLE } from '$lib/mapStyles';
  import { buildOperationClusters, MAX_CLUSTER_ZOOM, type ActivityPoint, type ActivityCluster } from '$lib/utils/operationClusters';

  export let points: ActivityPoint[] = [];
  export let color = '#7c3aed';
  export let focusedCity = '';
  export let paired = false;
  let container: HTMLDivElement;
  let map: LeafletMap | undefined;
  let layers: LayerGroup | undefined;
  let leaflet: typeof import('leaflet') | undefined;
  let zoom = 10;
  let groups = 0;
  let levels: ActivityCluster[][] = [];
  $: levels = buildOperationClusters(points);
  $: if (map && layers && leaflet) render(levels, color, paired);
  $: if (map && focusedCity) focusCity(focusedCity);

  function focusCity(city: string) {
    const point = points.find(p => p.city === city);
    if (point) map?.setView([point.lat, point.lng], 13);
  }

  function render(hierarchy: ActivityCluster[][], fill: string, showRoles: boolean) {
    if (!map || !layers || !leaflet) return;
    zoom = Math.max(0, Math.min(MAX_CLUSTER_ZOOM, Math.round(map.getZoom())));
    const clusters = hierarchy[zoom] ?? [];
    groups = clusters.length;
    layers.clearLayers();
    for (const group of clusters) {
      const label = group.count.toLocaleString('en-US');
      const combined = group.members.length > 1;
      const home = group.members.reduce((sum, p) => sum + (p.home_count ?? 0), 0);
      const activity = group.members.reduce((sum, p) => sum + (p.activity_count ?? 0), 0);
      const roles = showRoles ? ` Home (inferred): ${home.toLocaleString('en-US')}; activity: ${activity.toLocaleString('en-US')}.` : '';
      const description = (combined
        ? `${label} endpoint events across ${group.members.length} cities. Zoom in for detail.`
        : `${group.members[0].city}: ${label} endpoint events. City-level location.`) + roles;
      const badge = document.createElement('span');
      badge.className = 'activity-count';
      badge.textContent = label;
      badge.style.backgroundColor = fill;
      if (showRoles) {
        const split = home / group.count * 100;
        badge.style.background = `conic-gradient(#2563eb 0% ${split}%, #ea580c ${split}% 100%)`;
        badge.style.textShadow = '0 1px 3px #0f172a, 0 0 4px #0f172a';
      }
      const size = label.length > 5 ? 66 : 56;
      const marker = leaflet.marker([group.lat, group.lng], {
        icon: leaflet.divIcon({ className: 'activity-marker', html: badge, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        title: description, alt: description, keyboard: true,
      }).addTo(layers);
      const element = marker.getElement();
      element?.setAttribute('aria-label', description);
      const popup = document.createElement('div');
      popup.className = 'activity-popup';
      const title = document.createElement('strong');
      title.textContent = `${label} endpoint events.${roles}`;
      popup.append(title);
      for (const point of group.members) {
        const row = document.createElement('div');
        row.textContent = `${point.city}: ${point.count.toLocaleString('en-US')}` + (showRoles
          ? ` · Home ${point.home_count?.toLocaleString('en-US') ?? 0} · Activity ${point.activity_count?.toLocaleString('en-US') ?? 0}` : '');
        popup.append(row);
      }
      const note = document.createElement('p');
      note.textContent = 'City reference points. Street-level locations are not available.';
      popup.append(note);
      if (combined && zoom < MAX_CLUSTER_ZOOM) {
        marker.on('click', () => {
          if (!map || !leaflet) return;
          const memberSet = new Set(group.members);
          // Skip levels that keep this group intact, including colocated points.
          let nextZoom = zoom + 1;
          while (nextZoom < MAX_CLUSTER_ZOOM && hierarchy[nextZoom].some(g => g.members.length === memberSet.size && g.members.every(p => memberSet.has(p)))) nextZoom++;
          map.setView([group.lat, group.lng], nextZoom);
        });
      } else {
        marker.bindPopup(popup, { maxWidth: 300 });
      }
    }
  }

  onMount(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import('leaflet').then(module => {
      if (disposed) return;
      leaflet = module;
      map = module.map(container, { center: [37.96, -122.03], zoom: 10, minZoom: 3, maxZoom: MAX_CLUSTER_ZOOM });
      module.tileLayer(DEFAULT_MAP_STYLE.url, { attribution: DEFAULT_MAP_STYLE.attribution, maxZoom: MAX_CLUSTER_ZOOM }).addTo(map);
      layers = module.layerGroup().addTo(map);
      if (points.length) map.fitBounds(module.latLngBounds(points.map(p => [p.lat, p.lng])), { padding: [48, 48], maxZoom: 11 });
      map.on('zoomend', () => render(levels, color, paired));
      observer = new ResizeObserver(() => map?.invalidateSize());
      observer.observe(container);
      render(levels, color, paired);
      if (focusedCity) focusCity(focusedCity);
    });
    return () => { disposed = true; observer?.disconnect(); map?.remove(); map = undefined; };
  });
</script>

<div class="demand-map" bind:this={container} aria-label="City activity map with numbered clusters"></div>
<div class="map-key" aria-live="polite">
  <strong>{points.reduce((sum, p) => sum + p.count, 0).toLocaleString('en-US')} mapped endpoint events</strong>
  <span>{groups} {groups === 1 ? 'group' : 'groups'} across {points.length} cities · Zoom {zoom}</span>
  <span>Zoom in or select a group to split counts. City-level detail.</span>
  {#if paired}<span class="role-legend"><i class="home"></i> Home (inferred) <i class="activity"></i> Activity</span>{/if}
</div>

<style>
  .demand-map { width:100%; height:100%; }
  .map-key { position:absolute; bottom:24px; left:12px; z-index:500; max-width:calc(100% - 24px); display:grid; gap:3px; padding:10px 12px; border:1px solid #dbe3ef; border-radius:8px; background:#fffffff2; color:#334155; font-size:12px; box-shadow:0 2px 8px #0001; pointer-events:none; }
  .map-key span:last-child { font-size:11px; }
  .role-legend { display:flex; gap:6px; align-items:center; }
  .role-legend i { width:10px; height:10px; border-radius:50%; }
  .home { background:#2563eb; }
  .activity { background:#ea580c; margin-left:6px; }
  .demand-map :global(.activity-marker) { background:none; border:none; }
  .demand-map :global(.activity-count) { display:flex; align-items:center; justify-content:center; width:100%; height:100%; border:2px solid white; border-radius:50%; color:white; font-size:13px; font-weight:750; font-variant-numeric:tabular-nums; box-shadow:0 2px 8px #0004; }
  .demand-map :global(.activity-marker:hover .activity-count), .demand-map :global(.activity-marker:focus .activity-count) { outline:3px solid #0f172a; outline-offset:2px; }
  .demand-map :global(.activity-popup) { display:grid; gap:6px; max-height:240px; overflow:auto; }
  .demand-map :global(.activity-popup p) { margin:4px 0 0; color:#64748b; }
</style>
