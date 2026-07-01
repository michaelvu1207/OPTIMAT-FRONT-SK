<script lang="ts">
	  import { onMount } from 'svelte';
	  import { fade } from 'svelte/transition';
	  import PageShell from '$lib/components/PageShell.svelte';
	  import TripRouteMap from '../components/TripRouteMap.svelte';
	  import { getAllProviders, getDirections, isApiConfigured, type Provider as ApiProvider } from '$lib/api';
	  import { decodePolyline, type LatLng } from '$lib/utils/decodePolyline';
	  import { buildDemandHeatPoints } from '$lib/utils/heatmap.js';
	  import { Button } from '$lib/components/ui/button';
	  import * as Resizable from '$lib/components/ui/resizable/index.js';
	  import { providerPortalNavItems } from '$lib/providerPortalNav';

  type Provider = {
    id: string;
    name: string;
    center: [number, number];
    color: string;
  };

	  type Trip = {
	    id: string;
	    providerId: string;
	    providerName: string;
	    date: string;
	    origin: [number, number];
	    destination: [number, number];
	    distanceMiles: number;
	  };

	  type DemandMapMode = 'combined' | 'origins' | 'destinations' | 'selected-route';

	  const baseProviders: Provider[] = [
	    { id: 'delta', name: 'Delta Transit', center: [37.975, -121.816], color: '#0ea5e9' },
	    { id: 'bay-access', name: 'Bay Access Mobility', center: [37.915, -121.998], color: '#22c55e' },
	    { id: 'solano-link', name: 'Solano Link', center: [38.055, -121.915], color: '#f97316' },
	    { id: 'tri-valley', name: 'Tri Valley Connect', center: [37.885, -121.765], color: '#6366f1' },
	    { id: 'sierra-care', name: 'Sierra Care', center: [38.005, -121.715], color: '#14b8a6' },
	    { id: 'contra-ride', name: 'Contra Ride', center: [37.945, -121.705], color: '#e11d48' },
	    { id: 'east-bay-shuttle', name: 'East Bay Shuttle', center: [37.925, -121.86], color: '#a855f7' },
	    { id: 'valley-ride', name: 'Valley Ride', center: [38.02, -121.88], color: '#facc15' }
	  ];

	  const GOOGLE_ROUTES_CONCURRENCY = 4;

	  const defaultCenter: [number, number] = [37.965, -121.84];
	  const defaultZoom = 11;

	  let providers: Provider[] = baseProviders;
	  let providerLookup: Map<string, Provider> = new Map();
	  let providerLoadError: string | null = null;

	  let trips: Trip[] = [];
	  let availableDates: string[] = [];
	  let selectedProvider = 'all';
	  let selectedDate = 'all';
	  let demandMapMode: DemandMapMode = 'combined';
	  let selectedTripId: string | null = null;
	  let mapKey = 'universal-service-map';
	  let dataVersion = Date.now();
	  let googleRoutesLoading = false;
	  let googleRoutesError: string | null = null;
	  let googleRouteCoordinatesByTripId: Record<string, LatLng[]> = {};
	  let googleRouteErrorsByTripId: Record<string, string> = {};
	  let googleRoutesRequestKey = '';
	  let googleRoutesRequestToken = 0;

	  $: providerLookup = new Map(providers.map((provider) => [provider.id, provider]));

	  onMount(() => {
	    void initialize();
	  });

	  async function initialize() {
	    await loadRandomProviderNames();
	    regenerateTrips();
	  }

	  function shuffleInPlace<T>(items: T[]) {
	    for (let i = items.length - 1; i > 0; i -= 1) {
	      const j = Math.floor(Math.random() * (i + 1));
	      const tmp = items[i];
	      items[i] = items[j];
	      items[j] = tmp;
	    }
	    return items;
	  }

	  async function loadRandomProviderNames() {
	    providerLoadError = null;

	    const { data, error } = await getAllProviders();
	    if (error) {
	      providerLoadError = error.message;
	      return;
	    }

	    const allProviderNames = Array.from(
	      new Set(
	        (data ?? [])
	          .map((provider: ApiProvider) => provider.provider_name)
	          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
	      )
	    );

	    if (!allProviderNames.length) {
	      providerLoadError = 'No providers found.';
	      return;
	    }

	    shuffleInPlace(allProviderNames);
	    const selectedNames = allProviderNames.slice(0, providers.length);

	      providers = providers.map((provider, index) => ({
	        ...provider,
	        name: selectedNames[index] ?? provider.name
	      }));
	  }

	  function randomInt(min: number, max: number) {
	    return Math.floor(Math.random() * (max - min + 1)) + min;
	  }

  function randomOffset(maxDelta: number) {
    return (Math.random() - 0.5) * maxDelta * 2;
  }

  function randomCoordinate(center: [number, number], spread = 0.12) {
    return [center[0] + randomOffset(spread), center[1] + randomOffset(spread)] as [number, number];
  }

  function randomDateWithinDays(days: number) {
    const now = new Date();
    const offset = randomInt(0, days);
    const target = new Date(now);
    target.setDate(now.getDate() - offset);
    return target.toISOString().slice(0, 10);
  }

  function generateTrips() {
    const nextTrips: Trip[] = [];
    let tripCounter = 1;

    providers.forEach((provider) => {
      const tripCount = randomInt(12, 22);
      for (let i = 0; i < tripCount; i += 1) {
        const origin = randomCoordinate(provider.center, 0.14);
        const destination = randomCoordinate(provider.center, 0.14);
        const date = randomDateWithinDays(90);
        const distanceMiles = Number((Math.random() * 12 + 1.5).toFixed(1));

        nextTrips.push({
          id: `${provider.id}-${tripCounter}`,
          providerId: provider.id,
          providerName: provider.name,
          date,
          origin,
          destination,
          distanceMiles
        });

        tripCounter += 1;
      }
    });

    return nextTrips;
  }

  function buildAvailableDates(nextTrips: Trip[]) {
    const unique = new Set(nextTrips.map((trip) => trip.date));
    return Array.from(unique).sort((a, b) => (a < b ? 1 : -1));
  }

	  function regenerateTrips() {
	    const nextTrips = generateTrips();
	    trips = nextTrips;
	    availableDates = buildAvailableDates(nextTrips);
	    selectedProvider = 'all';
	    selectedDate = 'all';
	    demandMapMode = 'combined';
	    selectedTripId = null;
	    dataVersion = Date.now();
	    googleRoutesLoading = false;
	    googleRoutesError = null;
	    googleRouteCoordinatesByTripId = {};
	    googleRouteErrorsByTripId = {};
	    googleRoutesRequestKey = '';
	  }

  function averageDistance(data: Trip[]) {
    if (!data.length) return null;
    const total = data.reduce((sum, trip) => sum + trip.distanceMiles, 0);
    return Number((total / data.length).toFixed(1));
  }

  function dateRange(data: Trip[]) {
    if (!data.length) return 'No dates';
    const dates = data.map((trip) => trip.date).sort();
    const start = dates[0];
    const end = dates[dates.length - 1];
    return start === end ? start : `${start} to ${end}`;
  }

  $: dateFilteredTrips = trips.filter((trip) => selectedDate === 'all' || trip.date === selectedDate);
  $: filteredTrips = dateFilteredTrips.filter((trip) => selectedProvider === 'all' || trip.providerId === selectedProvider);
	  $: selectedTrip = selectedTripId
	    ? filteredTrips.find((trip) => trip.id === selectedTripId) || null
	    : null;

  $: providerSummaries = providers.map((provider) => ({
    ...provider,
    count: dateFilteredTrips.filter((trip) => trip.providerId === provider.id).length
  }));

	  $: selectedRouteCoordinates = selectedTripId ? googleRouteCoordinatesByTripId[selectedTripId] ?? [] : [];
	  $: heatPointMode = demandMapMode === 'selected-route' ? 'combined' : demandMapMode;
	  $: heatPoints = buildDemandHeatPoints(filteredTrips, { mode: heatPointMode, binSize: 0.015 });

  $: providerCount = new Set(filteredTrips.map((trip) => trip.providerId)).size;
  $: avgDistanceMiles = averageDistance(filteredTrips);
  $: mapCenter = (() => {
    if (selectedTrip) {
      return [
        (selectedTrip.origin[0] + selectedTrip.destination[0]) / 2,
        (selectedTrip.origin[1] + selectedTrip.destination[1]) / 2
      ] as [number, number];
    }
    if (!filteredTrips.length) return defaultCenter;
    let lat = 0;
    let lng = 0;
    let points = 0;
    filteredTrips.forEach((trip) => {
      lat += trip.origin[0] + trip.destination[0];
      lng += trip.origin[1] + trip.destination[1];
      points += 2;
    });
    return [lat / points, lng / points] as [number, number];
  })();
	  $: mapZoom = selectedTrip ? 13 : defaultZoom;

	  $: if (trips.length) {
	    mapKey = `universal-${dataVersion}-${selectedProvider}-${selectedDate}-${filteredTrips.length}`;
	  }

	  $: {
	    const nextKey = `google-${dataVersion}-${selectedProvider}-${selectedDate}-${filteredTrips.length}-${selectedTripId ?? 'none'}`;
	    if (nextKey !== googleRoutesRequestKey) {
	      googleRoutesRequestKey = nextKey;
	      void hydrateGoogleRoutes();
	    }
	  }

	  function handleProviderFilter(event: Event) {
	    selectedProvider = (event.target as HTMLSelectElement).value;
	    selectedTripId = null;
	    if (demandMapMode === 'selected-route') demandMapMode = 'combined';
	  }

  function handleDateFilter(event: Event) {
    selectedDate = (event.target as HTMLSelectElement).value;
    selectedTripId = null;
    if (demandMapMode === 'selected-route') demandMapMode = 'combined';
  }

  function selectTrip(tripId: string) {
    selectedTripId = tripId;
    demandMapMode = 'selected-route';
  }

  function setDemandMapMode(mode: DemandMapMode) {
    if (mode === 'selected-route' && !selectedTrip) return;
    demandMapMode = mode;
    if (mode !== 'selected-route') {
      selectedTripId = null;
    }
  }

  function selectProviderFromList(providerId: string) {
    selectedProvider = providerId;
    selectedTripId = null;
  }

  function providerLabel() {
    if (selectedProvider === 'all') return 'All providers';
    return providerLookup.get(selectedProvider)?.name ?? 'Provider';
  }

	  function dateLabel() {
	    return selectedDate === 'all' ? 'All dates' : selectedDate;
	  }

	  async function hydrateGoogleRoutes() {
	    const candidates: Trip[] = selectedTrip ? [selectedTrip] : [];
	    if (!candidates.length) {
	      googleRoutesLoading = false;
	      googleRoutesError = null;
	      return;
	    }

	    if (!isApiConfigured()) {
	      googleRoutesLoading = false;
	      googleRoutesError = 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.';
	      return;
	    }

	    const missingTrips = candidates.filter((trip) => {
	      const hasCoords = Object.prototype.hasOwnProperty.call(googleRouteCoordinatesByTripId, trip.id);
	      const hasError = Object.prototype.hasOwnProperty.call(googleRouteErrorsByTripId, trip.id);
	      return !hasCoords && !hasError;
	    });

	    if (!missingTrips.length) return;

	    googleRoutesLoading = true;
	    googleRoutesError = null;
	    const token = (googleRoutesRequestToken += 1);

	    try {
	      for (let i = 0; i < missingTrips.length; i += GOOGLE_ROUTES_CONCURRENCY) {
	        if (token !== googleRoutesRequestToken) return;

	        const batch = missingTrips.slice(i, i + GOOGLE_ROUTES_CONCURRENCY);
	        const results = await Promise.allSettled(
	          batch.map(async (trip) => {
	            const origin = `${trip.origin[0]},${trip.origin[1]}`;
	            const destination = `${trip.destination[0]},${trip.destination[1]}`;
	            const { data, error } = await getDirections({ origin, destination, mode: 'driving' });
	            if (error) throw error;
	            if (!data?.success) throw new Error(data?.error ?? 'Directions lookup failed.');
	            if (!data.polyline) throw new Error('Directions response missing polyline.');

	            return decodePolyline(data.polyline);
	          })
	        );

	        const nextCoordinatesByTripId = { ...googleRouteCoordinatesByTripId };
	        const nextErrorsByTripId = { ...googleRouteErrorsByTripId };

	        results.forEach((result, idx) => {
	          const trip = batch[idx];
	          if (result.status === 'fulfilled') {
	            nextCoordinatesByTripId[trip.id] = result.value;
	          } else {
	            nextErrorsByTripId[trip.id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
	          }
	        });

	        googleRouteCoordinatesByTripId = nextCoordinatesByTripId;
	        googleRouteErrorsByTripId = nextErrorsByTripId;
	      }
	    } catch (err) {
	      googleRoutesError = err instanceof Error ? err.message : String(err);
	    } finally {
	      if (token === googleRoutesRequestToken) {
	        googleRoutesLoading = false;
	      }
	    }
	  }
	</script>

<PageShell
  title="Universal Service Dashboard"
  description="Mock origin and destination demand across providers for the last three months."
  appMode={true}
  navItems={providerPortalNavItems}
>
  <Resizable.PaneGroup direction="horizontal" class="flex-1 h-full">
    <Resizable.Pane defaultSize={65} minSize={40} class="relative">
	      <Resizable.PaneGroup direction="vertical" class="h-full">
	        <Resizable.Pane defaultSize={62} minSize={40} class="relative">
	          <div class="absolute inset-0" in:fade={{ duration: 400 }}>
	            <div class="absolute top-4 left-4 z-10 rounded-xl border border-border/70 bg-background/90 px-4 py-3 shadow">
	              <div class="text-xs uppercase tracking-wide text-muted-foreground">Demand heat map</div>
	              <div class="text-sm font-semibold">
	                {filteredTrips.length} trips across {providerCount || 0} providers
	              </div>
	              <div class="mt-1 text-xs text-muted-foreground">{providerLabel()} - {dateLabel()}</div>
	              <div class="mt-2 text-xs text-muted-foreground">
	                {heatPoints.length} demand cells
	                {#if selectedTrip && googleRoutesLoading}
	                  · Loading selected route…
	                {/if}
	                {#if googleRoutesError}
	                  <div class="mt-1 text-xs text-destructive">{googleRoutesError}</div>
	                {/if}
	              </div>
	            </div>
	            {#if filteredTrips.length === 0}
	              <div class="flex h-full items-center justify-center text-sm text-muted-foreground">No trips match the current filters.</div>
	            {:else}
	              <TripRouteMap
	                mapKey={mapKey}
	                center={mapCenter}
	                zoom={mapZoom}
	                overlayMode="heat"
	                overlaySegments={[]}
	                drivingRoutes={[]}
	                transitRoutes={[]}
	                routeCoordinates={selectedRouteCoordinates}
	                routeMode="selected"
	                selectedTripId={selectedTripId}
	                heatPoints={heatPoints}
	              />
	            {/if}
	          </div>
	        </Resizable.Pane>

        <Resizable.Handle withHandle />

        <Resizable.Pane defaultSize={38} minSize={20} class="flex flex-col overflow-hidden bg-card border-t border-border/40">
          <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Service summary</span>
                <p class="text-xs text-muted-foreground">{dateRange(filteredTrips)}</p>
              </div>
              <div class="text-xs rounded-full bg-muted px-2 py-1 text-muted-foreground">{filteredTrips.length} trips</div>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto p-3">
            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
                <p class="text-xs text-muted-foreground mb-1">Active providers</p>
                <div class="text-base font-semibold">{providerCount || 0}</div>
              </div>
              <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
                <p class="text-xs text-muted-foreground mb-1">Average distance</p>
                <div class="text-base font-semibold">{avgDistanceMiles ?? 'N/A'} mi</div>
              </div>
              <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
                <p class="text-xs text-muted-foreground mb-1">Total trips</p>
                <div class="text-base font-semibold">{filteredTrips.length}</div>
              </div>
              <div class="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
                <p class="text-xs text-muted-foreground mb-1">Date scope</p>
                <div class="text-base font-semibold">{dateLabel()}</div>
              </div>
            </div>
          </div>
        </Resizable.Pane>
      </Resizable.PaneGroup>
    </Resizable.Pane>

    <Resizable.Handle withHandle />

    <Resizable.Pane defaultSize={35} minSize={25} class="bg-card border-l border-border/40 flex flex-col overflow-hidden">
      <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Routes</span>
            <p class="text-xs text-muted-foreground">Filter mock trip data</p>
          </div>
          <Button variant="outline" size="sm" onclick={regenerateTrips}>Regenerate</Button>
        </div>
      </div>

      <div class="flex-shrink-0 px-3 pt-3 pb-2 border-b border-border/40">
        <div class="grid gap-3">
          <div>
            <label for="service-dashboard-provider" class="text-xs font-medium text-muted-foreground">Provider</label>
            <select
              id="service-dashboard-provider"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              onchange={handleProviderFilter}
              bind:value={selectedProvider}
            >
              <option value="all">All providers</option>
              {#each providers as provider}
                <option value={provider.id}>{provider.name}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="service-dashboard-date" class="text-xs font-medium text-muted-foreground">Trip date</label>
            <select
              id="service-dashboard-date"
              class="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              onchange={handleDateFilter}
              bind:value={selectedDate}
            >
              <option value="all">All dates</option>
              {#each availableDates as date}
                <option value={date}>{date}</option>
              {/each}
            </select>
          </div>
          <div>
            <div class="text-xs font-medium text-muted-foreground">Map layer</div>
            <div class="mt-1 grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1">
              <button
                class={`rounded px-2 py-1 text-xs ${demandMapMode === 'combined' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onclick={() => setDemandMapMode('combined')}
              >
                Both
              </button>
              <button
                class={`rounded px-2 py-1 text-xs ${demandMapMode === 'origins' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onclick={() => setDemandMapMode('origins')}
              >
                Origins
              </button>
              <button
                class={`rounded px-2 py-1 text-xs ${demandMapMode === 'destinations' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onclick={() => setDemandMapMode('destinations')}
              >
                Destinations
              </button>
              <button
                class={`rounded px-2 py-1 text-xs ${demandMapMode === 'selected-route' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onclick={() => setDemandMapMode('selected-route')}
                disabled={!selectedTrip}
              >
                Selected
              </button>
            </div>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-between rounded-md border border-border bg-secondary px-3 py-2 text-sm">
          <span class="font-medium text-foreground">{filteredTrips.length} trips total</span>
          <div class="flex gap-2 text-xs text-muted-foreground">
            <span class="rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">{providerCount || 0} providers</span>
            <span class="rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-amber-700 dark:text-amber-400">{avgDistanceMiles ?? 'N/A'} mi avg</span>
          </div>
        </div>
      </div>

	      <div class="flex-shrink-0 px-3 pt-3">
	        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Provider legend</div>
	        {#if providerLoadError}
	          <div class="mt-2 text-xs text-destructive">{providerLoadError}</div>
	        {/if}
	        <div class="mt-2 flex flex-wrap gap-2">
	          {#each providerSummaries as provider}
	            <button
	              class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition ${selectedProvider === provider.id ? 'border-primary bg-primary/10' : 'border-border/70 hover:border-primary/50'}`}
	              onclick={() => selectProviderFromList(provider.id)}
	            >
              <span class="h-2 w-2 rounded-full" style={`background:${provider.color}`}></span>
              <span>{provider.name}</span>
              <span class="text-muted-foreground">{provider.count}</span>
            </button>
          {/each}
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-3 pb-3 space-y-2 mt-3">
        {#if filteredTrips.length === 0}
          <div class="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            No trips match the current filters.
          </div>
        {:else}
          {#each filteredTrips as trip}
            <button
              class={`w-full rounded-lg border px-3 py-3 text-left shadow-sm transition hover:border-primary/60 ${selectedTripId === trip.id ? 'border-primary/60 bg-primary/5' : 'border-border/70 bg-card'}`}
              onclick={() => selectTrip(trip.id)}
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full" style={`background:${providerLookup.get(trip.providerId)?.color ?? '#6366f1'}`}></span>
                  <span class="text-sm font-semibold">{trip.providerName}</span>
                </div>
                <span class="text-xs text-muted-foreground">{trip.date}</span>
              </div>
              <div class="mt-2 text-xs text-muted-foreground">
                {trip.origin[0].toFixed(3)}, {trip.origin[1].toFixed(3)}
                -> {trip.destination[0].toFixed(3)}, {trip.destination[1].toFixed(3)}
              </div>
              <div class="mt-1 text-xs text-muted-foreground">Distance: {trip.distanceMiles} mi</div>
            </button>
          {/each}
        {/if}
      </div>
    </Resizable.Pane>
  </Resizable.PaneGroup>
</PageShell>
