<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map as LeafletMap, LayerGroup } from 'leaflet';
  import { DEFAULT_MAP_STYLE } from '$lib/mapStyles';
  import { DEMAND_BANDS, demandStyle } from '$lib/utils/demandScale';
  import { buildOperationClusters, MAX_CLUSTER_ZOOM, type ActivityPoint, type ActivityCluster } from '$lib/utils/operationClusters';

  export let points: ActivityPoint[] = [];
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
  $: if (map && layers && leaflet) render(levels, paired);
  $: if (map && focusedCity) focusCity(focusedCity);

  function focusCity(city: string) {
    const point = points.find(p => p.city === city);
    if (point) map?.setView([point.lat, point.lng], 13);
  }

  function render(hierarchy: ActivityCluster[][], showRoles: boolean) {
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
      const demand = demandStyle(group.count);
      badge.style.backgroundColor = demand.color;
      badge.style.color = demand.textColor;
      const size = demand.size;
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
      // Filters replace this map while new records load. Avoid zoom transition
      // callbacks accessing panes after the previous provider's map is removed.
      map = module.map(container, { center: [37.96, -122.03], zoom: 10, minZoom: 3, maxZoom: MAX_CLUSTER_ZOOM,
        zoomAnimation: false, markerZoomAnimation: false });
      module.tileLayer(DEFAULT_MAP_STYLE.url, { attribution: DEFAULT_MAP_STYLE.attribution, maxZoom: MAX_CLUSTER_ZOOM }).addTo(map);
      layers = module.layerGroup().addTo(map);
      if (points.length) map.fitBounds(module.latLngBounds(points.map(p => [p.lat, p.lng])), { padding: [48, 48], maxZoom: 11 });
      map.on('zoomend', () => render(levels, paired));
      observer = new ResizeObserver(() => map?.invalidateSize());
      observer.observe(container);
      render(levels, paired);
      if (focusedCity) focusCity(focusedCity);
    });
    return () => { disposed = true; observer?.disconnect(); map?.remove(); map = undefined; };
  });
</script>

<div class="demand-map" bind:this={container} aria-label="City activity map with numbered clusters"></div>
<div class="map-key" aria-live="polite">
  <strong>{points.reduce((sum, p) => sum + p.count, 0).toLocaleString('en-US')} mapped endpoint events</strong>
  <span>{groups} {groups === 1 ? 'group' : 'groups'} across {points.length} cities · Zoom {zoom}</span>
  <strong class="legend-title">Demand · endpoint events per circle</strong>
  <div class="demand-legend" aria-label="Demand color scale, low to high">
    {#each DEMAND_BANDS as band}
      <span><i style:background-color={band.color}></i>{band.label}</span>
    {/each}
  </div>
  <span>Warmer / larger = more events · Fixed scale · Zoom in or select a group for city detail.</span>
  {#if paired}<span>Home (inferred) and activity counts are available in city details.</span>{/if}
</div>

<style>
  .demand-map { width:100%; flex:1; min-height:180px; }
  .map-key { flex-shrink:0; display:grid; gap:3px; padding:8px 12px; border-top:1px solid #dbe3ef; background:white; color:#334155; font-size:12px; }
  .map-key span:last-child { font-size:11px; }
  .legend-title { margin-top:5px; }
  .demand-legend { display:flex; flex-wrap:wrap; gap:5px 12px; }
  .demand-legend span { display:flex; gap:5px; align-items:center; font-size:11px; white-space:nowrap; }
  .demand-legend i { width:12px; height:12px; border-radius:50%; border:1px solid #0002; flex-shrink:0; }
  .demand-map :global(.activity-marker) { background:none; border:none; }
  .demand-map :global(.activity-count) { display:flex; align-items:center; justify-content:center; width:100%; height:100%; border:2px solid white; border-radius:50%; color:white; font-size:13px; font-weight:750; font-variant-numeric:tabular-nums; box-shadow:0 2px 8px #0004; }
  .demand-map :global(.activity-marker:hover .activity-count), .demand-map :global(.activity-marker:focus .activity-count) { outline:3px solid #0f172a; outline-offset:2px; }
  .demand-map :global(.activity-popup) { display:grid; gap:6px; max-height:240px; overflow:auto; }
  .demand-map :global(.activity-popup p) { margin:4px 0 0; color:#64748b; }
</style>
