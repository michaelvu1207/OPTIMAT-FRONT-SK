<script>
  import { Map, TileLayer, Polyline, CircleMarker } from 'sveaflet';
  export let mapKey = 'trip-map';
  export let center = [37.989, -121.835];
  export let zoom = 11;
  export let overlayMode = 'segments';
  export let overlaySegments = [];
  export let drivingRoutes = [];
  export let transitRoutes = [];
  export let routeCoordinates = [];
  export let routeMode = 'standard';
  export let selectedTripId = null;
  export let heatPoints = [];
</script>

{#key mapKey}
  <Map
    options={{ center, zoom, zoomControl: true }}
    style="height: 100vh; width: 100%; border-radius: 0; overflow: hidden;"
  >
    <TileLayer
      url={'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'}
      options={{
        attribution:
          "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>"
      }}
    />

    {#if overlayMode === 'segments'}
      {#each overlaySegments as segment, i (`${segment.id ?? 'segment'}-${i}`)}
        {@const isSelected = selectedTripId === segment.id}
        {@const baseColor = segment.color ?? '#6366f1'}
        <Polyline
          latLngs={[segment.origin, segment.destination]}
          options={{
            color: isSelected ? '#2563eb' : baseColor,
            weight: isSelected ? 4 : 2,
            opacity: isSelected ? 0.85 : 0.28,
            lineCap: 'round'
          }}
        />
      {/each}
    {:else if overlayMode === 'driving'}
      {#each drivingRoutes as route, i (`${route.trip_id ?? 'route'}-${i}`)}
        <Polyline
          latLngs={route.coordinates}
          options={{
            color: '#0ea5e9',
            weight: 7,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round'
          }}
        />
        {#if route.coordinates.length}
          <CircleMarker
            latLng={route.coordinates[0]}
            options={{ radius: 6, color: '#0ea5e9', weight: 2, fillColor: '#0ea5e9', fillOpacity: 0.9 }}
          />
          <CircleMarker
            latLng={route.coordinates[route.coordinates.length - 1]}
            options={{ radius: 6, color: '#10b981', weight: 2, fillColor: '#10b981', fillOpacity: 0.9 }}
          />
        {/if}
      {/each}
    {:else if overlayMode === 'heat'}
      {#each heatPoints as pt, i}
        <CircleMarker
          latLng={pt.latLng ?? pt}
          options={{
            radius: pt.radius ?? 8,
            color: pt.fillColor ?? '#ef4444',
            weight: 1,
            opacity: 0.2,
            fillColor: pt.fillColor ?? '#ef4444',
            fillOpacity: pt.fillOpacity ?? 0.55
          }}
        />
      {/each}
    {:else if overlayMode === 'transit'}
      {#each transitRoutes as route, i (`${route.trip_id ?? 'route'}-${i}`)}
        <Polyline
          latLngs={route.coordinates}
          options={{
            color: '#f97316',
            weight: 4,
            opacity: 0.18,
            dashArray: '4, 6',
            lineCap: 'round',
            lineJoin: 'round'
          }}
        />
      {/each}
    {/if}

    {#if routeCoordinates.length > 0}
      <Polyline
        latLngs={routeCoordinates}
        options={{
          color: routeMode === 'transit' ? '#f97316' : routeMode === 'selected' ? '#ef4444' : '#22c55e',
          weight: routeMode === 'transit' ? 6 : 7,
          opacity: 0.95,
          dashArray: routeMode === 'transit' ? '4, 6' : null
        }}
      />
    {/if}
  </Map>
{/key}
