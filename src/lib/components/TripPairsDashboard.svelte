<script>
  import { onMount } from 'svelte';
	  import { fade } from 'svelte/transition';
	  import TripRouteMap from '../../components/TripRouteMap.svelte';
	  import { getTripRecordPairsGrouped } from '$lib/api';
	  import { decodePolyline } from '$lib/utils/decodePolyline';
	  import * as Resizable from '$lib/components/ui/resizable/index.js';

  export let providerId = null;
  export let mockEnabled = false;

  const DEFAULT_CENTER = [37.99, -121.85];
  const DEFAULT_ZOOM = 11;

  let mounted = false;
  let lastProviderId = null;
  let lastMockEnabled = null;

  let pairs = [];
  let selectedDate = 'All trips';
  let selectedPairIndex = null;
  let loadingPairs = false;
  let pairsError = null;
  let mapKey = 'map-default';
  let viewMode = 'routes'; // 'routes' | 'heat'

  onMount(() => {
    mounted = true;
    lastProviderId = providerId;
    lastMockEnabled = mockEnabled;
    loadPairs();
  });

  $: if (mounted) {
    const shouldReload = providerId !== lastProviderId || mockEnabled !== lastMockEnabled;
    if (shouldReload) {
      lastProviderId = providerId;
      lastMockEnabled = mockEnabled;
      loadPairs();
    }
  }

  async function loadPairs() {
    loadingPairs = true;
    pairsError = null;
    pairs = [];
    selectedPairIndex = null;
    try {
      const { data, error } = await getTripRecordPairsGrouped({
        providerId,
        mock: mockEnabled,
      });
      if (error) throw error;
      pairs = Array.isArray(data) ? data : [];
      selectedPairIndex = null;
      mapKey = `all-${Date.now()}`;
    } catch (err) {
      pairsError = err?.message ?? 'Unable to load trip pairs.';
      pairs = [];
    } finally {
      loadingPairs = false;
    }
  }

  function selectDate(label) {
    selectedDate = label;
    selectedPairIndex = null;
    mapKey = `all-${Date.now()}`;
  }

  function selectPair(index) {
    selectedPairIndex = index;
    mapKey = `pair-${index}-${Date.now()}`;
  }

  function setViewMode(mode) {
    viewMode = mode;
    mapKey = `${mode}-${Date.now()}`;
  }

  function formatDateLabel(dateString) {
    return dateString;
  }

  function pairKey(pair, index) {
    const outboundId = pair?.outbound?.trip_id ?? 'outbound';
    const returnId = pair?.return_leg?.trip_id ?? 'none';
    return `${outboundId}-${returnId}-${index}`;
  }

  const formatTime = (value) => (value ? value.slice(0, 5) : '—');
  const formatMinutes = (value) =>
    value == null || Number.isNaN(Number(value)) ? '—' : `${Number(value).toFixed(1)} min`;

	  function mapCenterForSelection(groupedPairs) {
	    const allCoords = groupedPairs
	      .flatMap(getRoutesFromPair)
	      .flatMap((r) => r.coordinates);
    if (allCoords.length === 0) return DEFAULT_CENTER;
    return centerFromCoords(allCoords);
  }

  // Helper to get routes from a pair (defined before usage in reactive)
  function getRoutesFromPair(pair) {
    const routes = [];
    if (pair.outbound?.route_polyline) {
      routes.push({
        trip_id: pair.outbound.trip_id,
        coordinates: decodePolyline(pair.outbound.route_polyline),
        type: 'outbound'
      });
    }
    if (pair.return_leg?.route_polyline) {
      routes.push({
        trip_id: pair.return_leg.trip_id,
        coordinates: decodePolyline(pair.return_leg.route_polyline),
        type: 'return'
      });
    }
    return routes;
  }

  function centerFromCoords(coords) {
    if (!coords || coords.length === 0) return DEFAULT_CENTER;
    const lats = coords.map((c) => c[0]);
    const lngs = coords.map((c) => c[1]);
    return [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lngs) + Math.max(...lngs)) / 2,
    ];
  }

  const toMinutes = (timeStr) => {
    if (!timeStr) return null;
    const [h, m, s] = timeStr.split(':').map(Number);
    if ([h, m].some((n) => Number.isNaN(n))) return null;
    return h * 60 + m + (Number.isNaN(s) ? 0 : s / 60);
  };

  // Extract all legs (outbound + return) from grouped pairs for stats
  function getAllLegs(groupedPairs) {
    const legs = [];
    for (const pair of groupedPairs) {
      if (pair.outbound) legs.push(pair.outbound);
      if (pair.return_leg) legs.push(pair.return_leg);
    }
    return legs;
  }

  function buildStats(groupedPairs) {
    const allLegs = getAllLegs(groupedPairs);
    const distanceMeters = allLegs.map((t) => Number(t.route_distance_meters)).filter((n) => Number.isFinite(n) && n > 0);
    const durationSeconds = allLegs.map((t) => Number(t.route_duration_seconds)).filter((n) => Number.isFinite(n) && n > 0);
    const returnGaps = groupedPairs
      .map((p) => Number(p.gap_minutes))
      .filter((n) => Number.isFinite(n));
    const pickups = allLegs.map((t) => toMinutes(t.pick_time)).filter((n) => n != null);
    const drops = allLegs.map((t) => toMinutes(t.drop_time)).filter((n) => n != null);
    const passengers = allLegs
      .map((t) => Number(t.passengers_on_board))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0);

    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const safeAvg = (arr) => (arr.length ? sum(arr) / arr.length : null);

    const totalMeters = sum(distanceMeters);
    const totalSeconds = sum(durationSeconds);

    const avgSpeedMph = totalSeconds > 0 ? (totalMeters / 1609.344) / (totalSeconds / 3600) : null;

    const formatClock = (mins) => {
      if (mins == null) return '—';
      const h = Math.floor(mins / 60) % 24;
      const m = Math.round(mins % 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const avgDistance = safeAvg(distanceMeters);
    const avgDuration = safeAvg(durationSeconds);

    const roundTripCount = groupedPairs.filter((p) => p.is_round_trip).length;
    const oneWayCount = groupedPairs.length - roundTripCount;

    return {
      pairCount: groupedPairs.length,
      roundTripCount,
      oneWayCount,
      legCount: allLegs.length,
      routedCount: distanceMeters.length,
      distancesKm: distanceMeters.map((m) => m / 1000),
      durationsMin: durationSeconds.map((s) => s / 60),
      avgDistanceKm: avgDistance == null ? null : avgDistance / 1000,
      avgDurationMin: avgDuration == null ? null : avgDuration / 60,
      avgSpeedMph,
      avgReturnGapMin: safeAvg(returnGaps),
      earliestPickup: formatClock(pickups.length ? Math.min(...pickups) : null),
      latestDrop: formatClock(drops.length ? Math.max(...drops) : null),
      passengers,
    };
  }

  const formatNumber = (value, unit, digits = 1) =>
    value == null || Number.isNaN(value) ? '—' : `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;

  const buildBins = (values, edges) => {
    const counts = new Array(edges.length + 1).fill(0);
    values.forEach((v) => {
      const idx = edges.findIndex((edge) => v <= edge);
      counts[idx === -1 ? edges.length : idx] += 1;
    });
    return counts.map((count, i) => {
      const label = i === 0
        ? `≤${edges[0]}`
        : i === edges.length
          ? `>${edges[edges.length - 1]}`
          : `${edges[i - 1]}–${edges[i]}`;
      return { label, count };
    });
  };

  $: selectedPair = selectedPairIndex !== null ? pairs[selectedPairIndex] : null;
  $: visiblePairs = selectedPairIndex !== null ? [pairs[selectedPairIndex]] : pairs;
  $: drivingRoutes = visiblePairs.flatMap(getRoutesFromPair);
  $: hasMappable = drivingRoutes.length > 0;
  $: stats = buildStats(visiblePairs);
  $: mapCenter = (() => {
    if (selectedPair) {
      const routes = getRoutesFromPair(selectedPair);
      if (routes.length > 0) {
        const allCoords = routes.flatMap((r) => r.coordinates);
        return centerFromCoords(allCoords);
      }
    }
    return mapCenterForSelection(pairs);
  })();
  $: focusRoute = drivingRoutes.length ? drivingRoutes[0].coordinates : [];
  $: heatPoints = (() => {
    const pts = [];
    drivingRoutes.forEach((r) => {
      r.coordinates.forEach((c, idx) => {
        if (idx === 0 || idx === r.coordinates.length - 1 || idx % 5 === 0) {
          pts.push(c);
        }
      });
    });
    return pts;
  })();
</script>

<!-- Main horizontal layout: Left (Map + Stats) | Right (Trips full height) -->
<Resizable.PaneGroup direction="horizontal" class="flex-1 h-full">
  <!-- Left: Nested vertical panels (Map top, Stats bottom) -->
  <Resizable.Pane defaultSize={65} minSize={40} class="relative">
    <Resizable.PaneGroup direction="vertical" class="h-full">
      <!-- Top: Map Panel -->
      <Resizable.Pane defaultSize={60} minSize={40} class="relative">
        <div class="absolute inset-0" in:fade={{ duration: 400 }}>
          <div class="absolute top-4 left-4 z-10 rounded-xl border border-border/70 bg-background/90 px-4 py-3 shadow">
            <div class="text-xs uppercase tracking-wide text-muted-foreground">Map view</div>
            <div class="text-sm font-semibold">
              {#if loadingPairs && pairs.length === 0}
                Loading map…
              {:else if !hasMappable}
                No mappable trip pairs for this selection
              {:else}
                {visiblePairs.length} pairs ({drivingRoutes.length} routes)
              {/if}
            </div>
            <div class="mt-1 text-xs text-muted-foreground">{viewMode === 'heat' ? 'Heatmap layer' : 'Route layer'}</div>
          </div>
          {#if loadingPairs && pairs.length === 0}
            <div class="flex h-full items-center justify-center text-sm text-muted-foreground">Loading map…</div>
          {:else if !hasMappable}
            <div class="flex h-full items-center justify-center text-sm text-muted-foreground">No mappable trips for this selection.</div>
          {:else}
            <TripRouteMap
              mapKey={mapKey}
              center={mapCenter}
              zoom={selectedPair ? 13 : DEFAULT_ZOOM}
              overlayMode={viewMode === 'heat' ? 'heat' : 'driving'}
              overlaySegments={[]}
              drivingRoutes={drivingRoutes}
              transitRoutes={[]}
              routeCoordinates={focusRoute}
              routeMode={viewMode === 'heat' ? 'selected' : 'selected'}
              selectedTripId={selectedPair?.outbound?.trip_id ?? null}
              heatPoints={heatPoints}
            />
          {/if}
        </div>
      </Resizable.Pane>

      <Resizable.Handle withHandle />

      <!-- Bottom: Stats/Analysis Panel -->
      <Resizable.Pane defaultSize={40} minSize={20} class="flex flex-col overflow-hidden bg-card border-t border-border/40">
        <!-- Stats Header -->
        <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Daily Analysis</span>
              <p class="text-xs text-muted-foreground">Stats for {formatDateLabel(selectedDate)}</p>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-muted-foreground">Map layer</span>
              <div class="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1" aria-label="Map layer">
                <button
                  type="button"
                  class={`rounded px-2 py-1 text-xs transition ${viewMode === 'routes' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onclick={() => setViewMode('routes')}
                >
                  Routes
                </button>
                <button
                  type="button"
                  class={`rounded px-2 py-1 text-xs transition ${viewMode === 'heat' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onclick={() => setViewMode('heat')}
                >
                  Heatmap
                </button>
              </div>
            </div>
            <div class="text-xs rounded-full bg-muted px-2 py-1 text-muted-foreground">{stats.pairCount} pairs · {stats.legCount} legs</div>
          </div>
        </div>
        <!-- Stats Content -->
        <div class="flex-1 overflow-y-auto p-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Avg distance per trip</p>
              <div class="text-base font-semibold">{formatNumber(stats.avgDistanceKm, 'km')}</div>
              <div class="mt-2 space-y-1">
                {#each buildBins(stats.distancesKm ?? [], [5, 10, 20, 40]) as bin}
                  <div class="flex items-center gap-2 text-xs">
                    <div class="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                      <div class="h-full bg-primary/60" style={`width:${Math.min(100, (bin.count / Math.max(1, stats.legCount)) * 100)}%`}></div>
                    </div>
                    <span class="text-muted-foreground w-16">{bin.label}</span>
                    <span class="font-medium w-8 text-right">{bin.count}</span>
                  </div>
                {/each}
              </div>
            </div>
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Avg duration per leg</p>
              <div class="text-base font-semibold">{formatNumber(stats.avgDurationMin, 'min')}</div>
              <div class="mt-2 space-y-1">
                {#each buildBins(stats.durationsMin ?? [], [10, 20, 40, 60]) as bin}
                  <div class="flex items-center gap-2 text-xs">
                    <div class="flex-1 h-5 rounded-full bg-muted overflow-hidden">
                      <div class="h-full bg-primary/60" style={`width:${Math.min(100, (bin.count / Math.max(1, stats.legCount)) * 100)}%`}></div>
                    </div>
                    <span class="text-muted-foreground w-16">{bin.label}</span>
                    <span class="font-medium w-8 text-right">{bin.count}</span>
                  </div>
                {/each}
              </div>
            </div>
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Avg return gap</p>
              <div class="text-base font-semibold">{formatNumber(stats.avgReturnGapMin, 'min')}</div>
            </div>
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Earliest pickup</p>
              <div class="text-base font-semibold">{stats.earliestPickup}</div>
            </div>
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Latest drop</p>
              <div class="text-base font-semibold">{stats.latestDrop}</div>
            </div>
            <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Passengers moved</p>
              <div class="text-base font-semibold">{stats.passengers}</div>
            </div>
            <div class="col-span-2 rounded-lg border border-border/70 bg-card p-3 shadow-sm">
              <p class="text-xs text-muted-foreground mb-1">Avg speed (all routed trips)</p>
              <div class="text-base font-semibold">{formatNumber(stats.avgSpeedMph, 'mph')}</div>
            </div>
          </div>
        </div>
      </Resizable.Pane>
    </Resizable.PaneGroup>
  </Resizable.Pane>

  <Resizable.Handle withHandle />

  <!-- Right: Trip Pairs List Panel (full height) -->
  <Resizable.Pane defaultSize={35} minSize={25} class="bg-card border-l border-border/40 flex flex-col overflow-hidden">
    <!-- Pairs Header -->
    <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
      <div class="flex items-center justify-between">
        <div>
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Trip Pairs</span>
          <p class="text-xs text-muted-foreground">Outbound + return grouped</p>
        </div>
        <div class="text-xs rounded-full bg-muted px-2 py-1 text-muted-foreground">{visiblePairs.length} showing</div>
      </div>
    </div>
    <!-- Summary Stats -->
    <div class="flex-shrink-0 px-3 pt-2 pb-1">
      <div class="flex items-center justify-between rounded-md border border-border bg-secondary px-3 py-2 text-sm">
        <span class="font-medium text-foreground">{pairs.length} pairs total</span>
        <div class="flex gap-2 text-xs text-muted-foreground">
          <span class="rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">{stats.roundTripCount} round-trip</span>
          <span class="rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-amber-700 dark:text-amber-400">{stats.oneWayCount} one-way</span>
        </div>
      </div>
    </div>
    <!-- Pairs Content -->
    <div class="flex-1 overflow-y-auto px-3 pb-3 space-y-2 mt-2">
      {#if pairsError}
        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{pairsError}</div>
      {:else if loadingPairs}
        <div class="flex flex-col items-center gap-2 text-sm text-muted-foreground">
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          <p>Loading trip pairs…</p>
        </div>
      {:else if pairs.length === 0}
        <p class="text-sm text-muted-foreground">No trip pairs loaded.</p>
      {:else}
        {#each pairs as pair, index (pairKey(pair, index))}
          <button
            class={`w-full rounded-lg border px-3 py-3 text-left shadow-sm transition hover:border-primary/60 ${index === selectedPairIndex ? 'border-primary/60 bg-primary/5' : 'border-border/70 bg-card'}`}
            onclick={() => selectPair(index)}
          >
            <!-- Pair Header -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold">#{pair.outbound.trip_id}</span>
                {#if pair.is_round_trip}
                  <span class="text-xs text-muted-foreground">↔</span>
                  <span class="text-sm font-semibold">#{pair.return_leg.trip_id}</span>
                {/if}
              </div>
              <span class={`rounded-full px-2 py-0.5 text-xs ${pair.is_round_trip ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'}`}>
                {pair.is_round_trip ? 'Round trip' : 'One way'}
              </span>
            </div>

            <!-- Outbound Leg -->
            <div class="mt-2 pl-2 border-l-2 border-blue-400">
              <div class="text-xs font-medium text-blue-600 dark:text-blue-400 uppercase">Outbound</div>
              <div class="text-sm text-muted-foreground">
                {pair.outbound.pickup_city ?? '—'} → {pair.outbound.drop_city ?? '—'}
              </div>
              <div class="text-xs text-muted-foreground">
                {formatTime(pair.outbound.pick_time)} → {formatTime(pair.outbound.drop_time)} · {formatMinutes(pair.outbound.duration_minutes)}
              </div>
            </div>

            <!-- Return Leg (if exists) -->
            {#if pair.return_leg}
              <div class="mt-2 pl-2 border-l-2 border-green-400">
                <div class="text-xs font-medium text-green-600 dark:text-green-400 uppercase">Return</div>
                <div class="text-sm text-muted-foreground">
                  {pair.return_leg.pickup_city ?? '—'} → {pair.return_leg.drop_city ?? '—'}
                </div>
                <div class="text-xs text-muted-foreground">
                  {formatTime(pair.return_leg.pick_time)} → {formatTime(pair.return_leg.drop_time)} · {formatMinutes(pair.return_leg.duration_minutes)}
                </div>
              </div>

              <!-- Gap Info -->
              {#if pair.gap_minutes != null}
                <div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span class="rounded bg-muted px-1.5 py-0.5">Gap: {formatMinutes(pair.gap_minutes)}</span>
                  {#if pair.round_trip_duration_minutes != null}
                    <span class="rounded bg-muted px-1.5 py-0.5">Total: {formatMinutes(pair.round_trip_duration_minutes)}</span>
                  {/if}
                </div>
              {/if}
            {/if}

            <!-- Passengers -->
            <div class="mt-2 text-xs text-muted-foreground">
              {pair.outbound.passengers_on_board ?? 0}{#if pair.return_leg} + {pair.return_leg.passengers_on_board ?? 0}{/if} passengers
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </Resizable.Pane>
</Resizable.PaneGroup>
