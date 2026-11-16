<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map as LeafletMap, LayerGroup } from 'leaflet';
  import { buildOperationClusters, type ActivityPoint } from '$lib/utils/operationClusters';
  import { DEFAULT_MAP_STYLE } from '$lib/mapStyles';
  import { heatSamples, heatReference, heatColor } from '$lib/utils/heatSurface';
  import type { OperationsResult } from '$lib/operationsApi';
  export let analysis: NonNullable<OperationsResult['spatial_analysis']>;
  export let points: ActivityPoint[] = [];
  export let focusedCity = '';
  let showCounts = true;
  let leaflet: typeof import('leaflet') | undefined;
  let markers: LayerGroup | undefined;
  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let map: LeafletMap | undefined;
  let frame = 0;
  $: levels = buildOperationClusters(points);
  $: if (map && markers && leaflet) renderCounts(levels, showCounts);
  $: if (map && focusedCity) focusCity(focusedCity);
  $: samples = heatSamples(analysis.cells);
  $: reference = heatReference(samples);
  $: if (map && canvas && samples) schedule();
  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }
  function focusCity(city: string) {
    const point = points.find(p => p.city === city);
    if (point) map?.setView([point.lat,point.lng],13);
  }
  function renderCounts(hierarchy: ReturnType<typeof buildOperationClusters>, visible: boolean) {
    if (!map || !markers || !leaflet) return;
    markers.clearLayers();
    if (!visible) return;
    const zoom = Math.round(map.getZoom());
    for (const group of hierarchy[zoom] ?? []) {
      const label = group.count.toLocaleString('en-US');
      const badge = document.createElement('span');
      badge.className = 'city-count'; badge.textContent = label;
      const description = `${label} city endpoint events across ${group.members.length} ${group.members.length === 1 ? 'city' : 'cities'}. Select to zoom and view counts.`;
      const marker = leaflet.marker([group.lat,group.lng], {
        icon: leaflet.divIcon({className:'city-count-marker',html:badge,iconSize:[60,60],iconAnchor:[30,30]}),
        title:description,alt:description,keyboard:true
      }).addTo(markers);
      marker.on('click', () => {
        if (!map || !leaflet) return;
        if (group.members.length > 1 && zoom < 13) {
          const members = new Set(group.members);
          let nextZoom = zoom + 1;
          while (nextZoom < 13 && hierarchy[nextZoom].some(g => g.members.length === members.size && g.members.every(p => members.has(p)))) nextZoom++;
          map.setView([group.lat,group.lng],nextZoom);
          return;
        }
        map.setView([group.lat,group.lng],Math.min(13,Math.max(zoom,12)));
        const content = document.createElement('div');
        const heading = document.createElement('strong'); heading.textContent = 'City endpoint counts'; content.append(heading);
        for (const p of group.members) {
          const row = document.createElement('div'); row.textContent = `${p.city}: ${p.count.toLocaleString('en-US')}`; content.append(row);
        }
        const note = document.createElement('p'); note.textContent = 'City totals include events without address-based heatmap coverage. These are not counts for a local hotspot.'; content.append(note);
        leaflet.popup({maxWidth:280}).setLatLng([group.lat,group.lng]).setContent(content).openOn(map);
      });
    }
  }
  function draw() {
    if (!map || !canvas) return;
    const size = map.getSize(), scale = 4;
    leaflet?.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0,0]));
    canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
    canvas.width = Math.ceil(size.x / scale); canvas.height = Math.ceil(size.y / scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const field = new Float32Array(canvas.width * canvas.height);
    const center = map.getCenter();
    const pixelsPerKm = Math.abs(map.latLngToContainerPoint([center.lat + 1000 / 6371000 * 180 / Math.PI, center.lng]).y - size.y / 2) / scale;
    const sigma = Math.max(0.5, pixelsPerKm), radius = Math.ceil(3 * sigma);
    for (const p of analysis.cells) {
      const loc = map.latLngToContainerPoint([p.lat, p.lng]), cx = loc.x / scale, cy = loc.y / scale;
      for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(canvas.height - 1, Math.ceil(cy + radius)); y++) {
        for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(canvas.width - 1, Math.ceil(cx + radius)); x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2;
          if (d2 <= radius * radius) field[y * canvas.width + x] += p.count * Math.exp(-d2 / (2 * sigma * sigma));
        }
      }
    }
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < field.length; i++) pixels.data.set(heatColor(field[i] / reference), i * 4);
    ctx.putImageData(pixels, 0, 0);
  }
  onMount(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import('leaflet').then(L => {
      if (disposed) return;
      leaflet = L;
      map = L.map(container, { center: [37.96,-122.03], zoom: 10, minZoom: 7, maxZoom: 13, zoomAnimation: false });
      const pane = map.createPane('demandHeat'); pane.style.zIndex = '350'; pane.style.pointerEvents = 'none'; pane.appendChild(canvas);
      L.tileLayer(DEFAULT_MAP_STYLE.url, { attribution: DEFAULT_MAP_STYLE.attribution, maxZoom: 13 }).addTo(map);
      markers = L.layerGroup().addTo(map);
      const bounds = [...analysis.cells,...points];
      if (bounds.length) map.fitBounds(L.latLngBounds(bounds.map(p => [p.lat,p.lng])), { padding: [40,40], maxZoom: 11 });
      map.on('move zoom resize', schedule);
      map.on('zoomend', () => renderCounts(levels,showCounts));
      renderCounts(levels,showCounts);
      if (focusedCity) focusCity(focusedCity);
      observer = new ResizeObserver(() => { map?.invalidateSize(); schedule(); });
      observer.observe(container); schedule();
    });
    return () => { disposed = true; cancelAnimationFrame(frame); observer?.disconnect(); map?.remove(); map = undefined; markers = undefined; };
  });
</script>

<div class="heat-map">
  <div bind:this={container} class="tiles" aria-label="Aggregated service demand map"></div>
  <canvas bind:this={canvas} aria-label="Continuous relative demand intensity, from lower blue to higher red"></canvas>
  <label class="count-toggle"><input type="checkbox" bind:checked={showCounts} /> Show city counts</label>
  {#if !analysis.cells.length}<div class="empty">No address-based cells meet the privacy thresholds for this selection. City counts remain available.</div>{/if}
  <div class="legend"><strong>Service demand · Relative intensity</strong><div class="gradient"></div><div class="ends"><span>Lower</span><span>Higher</span></div><small>Circles: city endpoint totals · Click to zoom</small><details><summary>Coverage and precision</summary><small>1 km cells · 1 km smoothing · Colors rescale with filters</small><small>{analysis.geocoded_events.toLocaleString('en-US')} / {analysis.total_events.toLocaleString('en-US')} endpoints geocoded. Sparse cells withheld; heat weights rounded down.</small><small>City totals include events outside heatmap coverage.</small></details></div>
</div>

<style>
  .heat-map { position:relative; height:100%; min-height:400px; isolation:isolate; }
  .tiles { position:absolute; inset:0; z-index:0; }
  canvas { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:400; }
  .count-toggle { position:absolute; top:12px; right:12px; z-index:500; display:flex; align-items:center; gap:7px; padding:9px 12px; background:#fffffff2; border:1px solid #cbd5e1; border-radius:8px; font-size:12px; color:#334155; }
  .tiles :global(.city-count-marker) { background:none; border:0; }
  .tiles :global(.city-count) { display:flex; justify-content:center; align-items:center; width:60px; height:60px; border-radius:50%; background:#fffffff0; border:2px solid #475569; color:#0f172a; font-size:13px; font-weight:750; box-shadow:0 2px 6px #0003; }
  .tiles :global(.city-count-marker:focus .city-count), .tiles :global(.city-count-marker:hover .city-count) { outline:3px solid #2563eb; outline-offset:2px; }
  .legend { position:absolute; bottom:26px; left:14px; z-index:500; background:#fffffff0; padding:12px 14px; border:1px solid #dbe3ef; border-radius:10px; width:min(330px,85%); font-size:12px; color:#334155; pointer-events:none; }
  .gradient { height:9px; border-radius:5px; margin-top:8px; background:linear-gradient(90deg,#37a5da,#33be6e,#d5e63e,#ffc124,#f56020,#c6232d); }
  .ends { display:flex; justify-content:space-between; margin-top:3px; }
  details { pointer-events:auto; margin-top:5px; font-size:11px; } summary { cursor:pointer; }
  small { display:block; margin-top:5px; line-height:1.5; }
  .empty { position:absolute; z-index:500; top:20px; left:15%; right:15%; padding:14px; background:white; border-radius:10px; font-size:13px; }
</style>
