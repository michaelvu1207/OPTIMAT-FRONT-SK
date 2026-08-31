<script>
  import { onDestroy, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { Map, TileLayer, GeoJSON } from 'sveaflet';
  import { serviceZoneManager, visibleServiceZones } from '../lib/serviceZoneManager.js';
  import PageShell from '$lib/components/PageShell.svelte';
  import * as Resizable from '$lib/components/ui/resizable/index.js';
  import { getAllProviders } from '$lib/api';
  import { NO_KEY_MAP_STYLES } from '$lib/mapStyles';
  import {
    formatBooking,
    formatEligibilityReqs,
    formatFare,
    isFixedRouteProvider,
    formatRoutingType,
    formatScheduleType,
    formatServiceAreaSummary,
  } from '$lib/providers/providerFields';

  let mounted = false;
  let providers = [];
  let loading = true;
  let error = null;
  let selectedProvider = null;
  let activeProviderGroupId = 'fixed-route';

  let mapCenter = [37.9020731, -122.0618702];
  let mapZoom = 10;
  let mapKey = 'initial';

  const mapStyles = NO_KEY_MAP_STYLES;
  let currentMapStyleId = mapStyles[0].id;
  $: currentMapStyle = mapStyles.find((style) => style.id === currentMapStyleId) || mapStyles[0];

  const providerGroups = [
    { id: 'fixed-route', label: 'fixed-route', matches: (type) => normalizeProviderType(type).includes('fixed route') },
    { id: 'ada-paratransit', label: 'ADA paratransit', matches: (type) => normalizeProviderType(type) === 'ada paratransit' },
    { id: 'non-ada-paratransit', label: 'non-ADA paratransit', matches: (type) => normalizeProviderType(type) === 'non-ada paratransit' },
    { id: 'volunteer-driver-tnc', label: 'volunteer-driver and TNC', matches: (type) => {
      const normalized = normalizeProviderType(type);
      return normalized.includes('volunteer driver') || normalized.includes('tnc');
    } }
  ];
  $: activeProviderGroup = providerGroups.find((group) => group.id === activeProviderGroupId) || providerGroups[0];
  $: providerGroupCounts = Object.fromEntries(
    providerGroups.map((group) => [
      group.id,
      providers.filter((provider) => group.matches(provider.provider_type)).length
    ])
  );
  $: providerGroupTotal = providerGroups.reduce(
    (total, group) => total + (providerGroupCounts[group.id] ?? 0),
    0
  );
  $: filteredProviders = providers.filter((provider) => activeProviderGroup.matches(provider.provider_type));

  onMount(async () => {
    mounted = true;
    const savedStyleId = localStorage.getItem('optimat-map-style');
    const savedStyle = mapStyles.find((style) => style.id === savedStyleId);
    if (savedStyle) currentMapStyleId = savedStyle.id;
    await loadProviders();
  });

  onDestroy(() => {
    serviceZoneManager.clearAllServiceZones();
  });

  async function loadProviders() {
    loading = true;
    error = null;
    try {
      const { data, error: apiError } = await getAllProviders();
      if (apiError) throw apiError;
      providers = data || [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      providers = [];
    } finally {
      loading = false;
    }
  }

  function changeMapStyle(id) {
    const style = mapStyles.find((item) => item.id === id);
    if (!style) return;
    currentMapStyleId = style.id;
    localStorage.setItem('optimat-map-style', style.id);
    mapKey = Date.now().toString();
  }

  function selectProvider(provider) {
    const providerId = provider.provider_id || provider.id;
    const selectedId = selectedProvider?.provider_id || selectedProvider?.id;

    if (selectedId === providerId) {
      selectedProvider = null;
      serviceZoneManager.clearAllServiceZones();
      return;
    }

    selectedProvider = provider;
    showProviderZoneOnMap(provider);
  }

  function showProviderZoneOnMap(provider) {
    if (!provider) return;
    const providerId = provider.provider_id || provider.id;
    serviceZoneManager.clearAllServiceZones();

    if (!provider.service_zone) return;

    try {
      const geoJson = typeof provider.service_zone === 'string'
        ? JSON.parse(provider.service_zone)
        : provider.service_zone;

      serviceZoneManager.addServiceZone({
        type: 'provider',
        geoJson,
        label: provider.provider_name,
        description: `${provider.provider_name} service area`,
        metadata: { providerId, provider },
        config: { color: '#2563eb', fillOpacity: 0.18, weight: 2 }
      }, true);
    } catch (e) {
      console.error('Error parsing provider service zone:', e);
    }
  }

  function getProviderTypeColor(type) {
    if (type?.includes('paratransit') || type?.includes('ADA')) return 'bg-purple-100 text-purple-700 border-purple-200';
    if (type?.toLowerCase().includes('fixed')) return 'bg-blue-100 text-blue-700 border-blue-200';
    if (type?.toLowerCase().includes('dial')) return 'bg-green-100 text-green-700 border-green-200';
    return 'bg-gray-100 text-gray-700 border-gray-200';
  }

  function normalizeProviderType(type) {
    return String(type ?? '').trim().toLowerCase();
  }

  function selectProviderGroup(groupId) {
    activeProviderGroupId = groupId;
    selectedProvider = null;
    serviceZoneManager.clearAllServiceZones();
  }

  function formatText(value) {
    const text = String(value ?? '').trim();
    return text || '-';
  }

  function formatBoolean(value) {
    if (value === true) return 'Yes';
    if (value === false) return 'No';
    return '-';
  }
</script>

{#if mounted}
  <PageShell title="Providers Info" description="View transportation providers" appMode={true}>
    <Resizable.PaneGroup direction="horizontal" class="flex-1 h-full">
      <Resizable.Pane defaultSize={55} minSize={35} class="relative">
        <Resizable.PaneGroup direction="vertical" class="h-full">
          <Resizable.Pane defaultSize={55} minSize={30} class="relative">
            <div class="absolute top-2 left-2 z-10 rounded-md border border-border/50 bg-background/95 backdrop-blur px-2 py-1.5 shadow-sm">
              <select
                class="bg-transparent text-xs border-0 focus:ring-0 cursor-pointer"
                bind:value={currentMapStyleId}
                onchange={(e) => changeMapStyle(e.target.value)}
                aria-label="Map style"
              >
                {#each mapStyles as style}
                  <option value={style.id}>{style.name}</option>
                {/each}
              </select>
            </div>

            <div class="absolute inset-0" in:fade={{ duration: 400 }}>
              {#key mapKey}
                <Map options={{ center: mapCenter, zoom: mapZoom }}>
                  <TileLayer url={currentMapStyle.url} options={{ attribution: currentMapStyle.attribution, maxZoom: 19 }} />

                  {#each $visibleServiceZones as zone (zone.id)}
                    {#if zone.geoJson}
                      <GeoJSON
                        json={zone.geoJson}
                        options={{
                          style: () => zone.config,
                          onEachFeature: (feature, layer) => {
                            layer.on({
                              mouseover: (e) => {
                                const activeLayer = e.target;
                                activeLayer.setStyle({
                                  weight: (zone.config.weight || 2) + 1,
                                  opacity: Math.min((zone.config.opacity || 0.8) + 0.2, 1),
                                  fillOpacity: Math.min((zone.config.fillOpacity || 0.2) + 0.2, 0.6)
                                });
                                activeLayer.bringToFront();
                              },
                              mouseout: (e) => {
                                e.target.setStyle(zone.config);
                              },
                              click: () => serviceZoneManager.focusOnServiceZone(zone.id)
                            });
                            layer.bindPopup(`
                              <div class="service-zone-popup">
                                <div class="zone-popup-header"><strong>${zone.label}</strong></div>
                                ${zone.description ? `<div class="zone-popup-description">${zone.description}</div>` : ''}
                              </div>
                            `);
                          }
                        }}
                      />
                    {/if}
                  {/each}
                </Map>
              {/key}
            </div>
          </Resizable.Pane>

          <Resizable.Handle withHandle />

          <Resizable.Pane defaultSize={45} minSize={25} class="flex flex-col overflow-hidden bg-card border-t border-border/40">
            <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Providers ({providerGroupTotal})
                  </span>
                  <div class="flex max-w-full flex-wrap items-center gap-1" role="tablist" aria-label="Provider service groups">
                    {#each providerGroups as group}
                      {@const isActiveGroup = activeProviderGroupId === group.id}
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActiveGroup}
                        class="rounded-md border px-2 py-1 text-[11px] font-medium leading-none transition {
                          isActiveGroup
                            ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                            : 'border-border/60 bg-background text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground'
                        }"
                        onclick={() => selectProviderGroup(group.id)}
                      >
                        {group.label}
                        <span class="ml-1 opacity-70">{providerGroupCounts[group.id] ?? 0}</span>
                      </button>
                    {/each}
                  </div>
                </div>
                <button
                  class="text-xs text-primary hover:text-primary/80 transition"
                  onclick={loadProviders}
                  disabled={loading}
                >
                  {loading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div class="flex-1 overflow-y-auto p-2">
              {#if loading}
                <div class="flex items-center justify-center h-32">
                  <div class="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent"></div>
                </div>
              {:else if error}
                <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              {:else if providers.length === 0}
                <div class="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  No providers found
                </div>
              {:else if filteredProviders.length === 0}
                <div class="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  No providers found for {activeProviderGroup.label}
                </div>
              {:else}
                <div class="space-y-2">
                  {#each filteredProviders as provider (provider.provider_id || provider.id)}
                    {@const providerId = provider.provider_id || provider.id}
                    {@const isSelected = (selectedProvider?.provider_id || selectedProvider?.id) === providerId}
                    <button
                      class="w-full text-left rounded-lg border p-3 transition {
                        isSelected
                          ? 'bg-primary/10 border-primary shadow-md ring-1 ring-primary/50'
                          : 'bg-card border-border/60 hover:bg-muted/50 hover:border-border'
                      }"
                      onclick={() => selectProvider(provider)}
                    >
                      <div class="flex items-center gap-2 mb-1">
                        <span class="font-semibold text-sm text-foreground truncate">{provider.provider_name}</span>
                      </div>
                      <div class="flex items-center gap-2 text-xs text-muted-foreground">
                        <span class="px-1.5 py-0.5 rounded border {getProviderTypeColor(provider.provider_type)}">
                          {provider.provider_type || 'Unknown'}
                        </span>
                        {#if provider.routing_type}
                          <span class="truncate">{formatRoutingType(provider.routing_type)}</span>
                        {/if}
                      </div>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </Resizable.Pane>
        </Resizable.PaneGroup>
      </Resizable.Pane>

      <Resizable.Handle withHandle />

      <Resizable.Pane defaultSize={45} minSize={30} class="bg-card border-l border-border/40 flex flex-col overflow-hidden">
        <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Provider Details
          </span>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          {#if !selectedProvider}
            <div class="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <svg class="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p class="text-sm">Select a provider to view details</p>
            </div>
          {:else}
            <div class="space-y-4">
              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Provider ID</div>
                <div class="text-sm text-foreground font-mono bg-muted/30 rounded px-2 py-1">{selectedProvider.provider_id || '-'}</div>
              </div>

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Provider name</div>
                <div class="text-sm font-semibold text-foreground">{selectedProvider.provider_name || '-'}</div>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Service category</div>
                  <div class="text-sm text-foreground bg-muted/50 rounded p-2">{formatText(selectedProvider.provider_type)}</div>
                </div>
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Service style</div>
                  <div class="text-sm text-foreground bg-muted/50 rounded p-2">{formatRoutingType(selectedProvider.routing_type) || '-'}</div>
                </div>
              </div>

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Schedule</div>
                <div class="text-sm text-foreground bg-muted/50 rounded p-2">
                  {formatScheduleType(selectedProvider.schedule_type) || '-'}
                </div>
              </div>

              {#if !isFixedRouteProvider(selectedProvider)}
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Eligibility</div>
                  <div class="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-28 overflow-y-auto">
                    {formatEligibilityReqs(selectedProvider.eligibility_reqs) || '-'}
                  </div>
                </div>
              {/if}

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Booking</div>
                <div class="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-28 overflow-y-auto">
                  {formatBooking(selectedProvider.booking) || '-'}
                </div>
              </div>

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Fare</div>
                <div class="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-28 overflow-y-auto">
                  {formatFare(selectedProvider.fare) || '-'}
                </div>
              </div>

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Service area</div>
                <div class="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-32 overflow-y-auto">
                  {formatServiceAreaSummary(selectedProvider) || '-'}
                </div>
              </div>

              {#if selectedProvider.service_area_notes}
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Service area notes</div>
                  <div class="text-sm text-foreground whitespace-pre-wrap bg-muted/50 rounded p-2">
                    {selectedProvider.service_area_notes}
                  </div>
                </div>
              {/if}

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Round trip booking</div>
                  <div class="text-sm text-foreground bg-muted/50 rounded p-2">{formatBoolean(selectedProvider.round_trip_booking)}</div>
                </div>
                <div>
                  <div class="text-xs font-medium text-muted-foreground mb-1">Provider software</div>
                  <div class="text-sm text-foreground bg-muted/50 rounded p-2">{formatText(selectedProvider.provider_software)}</div>
                </div>
              </div>

              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Website</div>
                {#if selectedProvider.website}
                  <a
                    href={selectedProvider.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm text-primary hover:underline break-all"
                  >
                    {selectedProvider.website}
                  </a>
                {:else}
                  <div class="text-sm text-foreground">-</div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      </Resizable.Pane>
    </Resizable.PaneGroup>
  </PageShell>
{/if}

<style>
  :global(.leaflet-container) {
    height: 100% !important;
    width: 100% !important;
  }

  :global(.service-zone-popup) {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 250px;
  }

  :global(.zone-popup-header) {
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #e5e7eb;
  }

  :global(.zone-popup-description) {
    font-size: 13px;
    color: #4b5563;
    margin-bottom: 4px;
  }
</style>
