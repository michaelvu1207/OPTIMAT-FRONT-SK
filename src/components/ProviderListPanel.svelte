<script>
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { serviceZoneManager } from '../lib/serviceZoneManager.js';
  import { getAllProviders } from '$lib/api';

  export let highlightedProviders = new Set(); // Provider IDs to highlight from chat results

  let providers = [];
  let filteredProviders = [];
  let loading = true;
  let error = null;
  let searchQuery = '';
  let expandedProviderId = null; // For showing details on click
  let hoveredProviderId = null; // For tooltip on hover
  let hoverTimeout = null;
  let tooltipPosition = { x: 0, y: 0 };

  // Service zone state
  let visibleZones = new Set();
  let loadingZones = new Set();

  // Fetch all providers on mount
  onMount(async () => {
    await fetchProviders();
  });

  async function fetchProviders() {
    loading = true;
    error = null;

    try {
      const { data, error: apiError } = await getAllProviders();

      if (apiError) {
        throw apiError;
      }

      providers = data || [];
      filteredProviders = providers;
      console.log(`Loaded ${providers.length} providers`);
    } catch (err) {
      error = err.message;
      console.error('Error fetching providers:', err);
    } finally {
      loading = false;
    }
  }
  
  // Filter and sort providers based on search query and highlighting
  $: {
    let filtered;
    if (searchQuery.trim() === '') {
      filtered = providers;
    } else {
      const query = searchQuery.toLowerCase();
      filtered = providers.filter(provider => 
        provider.provider_name?.toLowerCase().includes(query) ||
        provider.provider_org?.toLowerCase().includes(query) ||
        provider.provider_type?.toLowerCase().includes(query) ||
        provider.eligibility_req?.toLowerCase().includes(query)
      );
    }
    
    // Sort highlighted providers to the top
    filteredProviders = filtered.sort((a, b) => {
      const aHighlighted = highlightedProviders.has(a.provider_id);
      const bHighlighted = highlightedProviders.has(b.provider_id);
      
      if (aHighlighted && !bHighlighted) return -1;
      if (!aHighlighted && bHighlighted) return 1;
      
      // If both or neither are highlighted, sort by name
      return (a.provider_name || '').localeCompare(b.provider_name || '');
    });
  }
  
  // Check if a provider is highlighted from chat results
  function isHighlighted(providerId) {
    return highlightedProviders.has(providerId);
  }
  
  // Toggle service zone visibility
  async function toggleServiceZone(provider, event) {
    event.stopPropagation();
    const providerId = provider.provider_id;
    const isVisible = visibleZones.has(providerId);
    
    if (isVisible) {
      // Hide the zone
      serviceZoneManager.removeServiceZonesByProvider(providerId);
      visibleZones.delete(providerId);
      visibleZones = new Set(visibleZones); // Trigger reactivity
    } else {
      // Show the zone
      loadingZones.add(providerId);
      loadingZones = new Set(loadingZones); // Trigger reactivity
      
      try {
        if (provider.service_zone) {
          const zoneData = {
            type: 'provider',
            geoJson: typeof provider.service_zone === 'string' 
              ? JSON.parse(provider.service_zone) 
              : provider.service_zone,
            label: provider.provider_name,
            description: `${provider.provider_name} service area`,
            metadata: {
              providerId: providerId,
              provider: provider
            }
          };
          
          const zoneId = serviceZoneManager.addServiceZone(zoneData, false);
          if (zoneId) {
            visibleZones.add(providerId);
            visibleZones = new Set(visibleZones); // Trigger reactivity
            // Focus on this specific provider's zone
            serviceZoneManager.focusOnServiceZone(zoneId);
          }
        } else {
          // Try to fetch from API if no service zone data
          const response = await fetch(`${API_BASE}/providers/${providerId}/service-zone`);
          
          if (response.ok) {
            const zoneData = await response.json();
            if (zoneData.has_service_zone && zoneData.raw_data) {
              const serviceZoneData = {
                type: 'provider',
                geoJson: zoneData.raw_data,
                label: provider.provider_name,
                description: `${provider.provider_name} service area`,
                metadata: {
                  providerId: providerId,
                  provider: provider
                }
              };
              
              const zoneId = serviceZoneManager.addServiceZone(serviceZoneData, false);
              if (zoneId) {
                visibleZones.add(providerId);
                visibleZones = new Set(visibleZones); // Trigger reactivity
                // Focus on this specific provider's zone
                serviceZoneManager.focusOnServiceZone(zoneId);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error loading service zone:', error);
      } finally {
        loadingZones.delete(providerId);
        loadingZones = new Set(loadingZones); // Trigger reactivity
      }
    }
  }
  
  // Handle provider hover
  function handleProviderHover(provider, event) {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
    }
    
    hoverTimeout = setTimeout(() => {
      hoveredProviderId = provider.provider_id;
      const rect = event.currentTarget.getBoundingClientRect();
      tooltipPosition = {
        x: rect.right + 10,
        y: rect.top
      };
    }, 300); // Show tooltip after 300ms delay
  }
  
  function handleProviderLeave() {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
    }
    hoveredProviderId = null;
  }
  
  // Format service hours
  function formatServiceHours(serviceHours) {
    if (!serviceHours) return 'Not available';
    
    try {
      const hours = typeof serviceHours === 'string' ? JSON.parse(serviceHours) : serviceHours;
      
      if (hours.days_of_week && hours.start_time && hours.end_time) {
        const days = hours.days_of_week.join(', ');
        return `${days}: ${hours.start_time} - ${hours.end_time}`;
      }
      
      return 'Schedule varies';
    } catch (e) {
      return 'Not available';
    }
  }
  
</script>

<div class="provider-panel" in:fly={{ x: -50, duration: 600, delay: 200 }}>
  <div class="panel-header">
    <h3>Transportation Providers</h3>
    <div class="provider-count">
      {filteredProviders.length} of {providers.length} providers
    </div>
  </div>
  
  <div class="search-container">
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="Search providers..."
      class="search-input"
    />
    {#if searchQuery}
      <button
        class="clear-search"
        on:click={() => searchQuery = ''}
        aria-label="Clear search"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    {/if}
  </div>
  
  <div class="provider-list">
    {#if loading}
      <div class="loading-state">
        <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
        <span>Loading providers...</span>
      </div>
    {:else if error}
      <div class="error-state">
        <svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <span>{error}</span>
      </div>
    {:else if filteredProviders.length === 0}
      <div class="empty-state">
        {searchQuery ? 'No providers match your search' : 'No providers available'}
      </div>
    {:else}
      {#each filteredProviders as provider (provider.provider_id)}
        <div
          class="provider-item {isHighlighted(provider.provider_id) ? 'highlighted' : ''}"
          role="button"
          tabindex="0"
          on:mouseenter={(e) => handleProviderHover(provider, e)}
          on:mouseleave={handleProviderLeave}
          on:keydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleServiceZone(provider, e);
            }
          }}
          in:fade={{ duration: 200 }}
          animate:flip={{ duration: 300 }}
        >
          <div class="provider-info">
            <div class="provider-name">{provider.provider_name || 'Unnamed Provider'}</div>
            <div class="provider-meta">
              {#if provider.provider_type}
                <span class="provider-type">{provider.provider_type}</span>
              {/if}
              {#if provider.provider_org}
                <span class="provider-org">{provider.provider_org}</span>
              {/if}
            </div>
          </div>
          
          <button
            class="zone-button {visibleZones.has(provider.provider_id) ? 'active' : ''}"
            on:click={(e) => toggleServiceZone(provider, e)}
            disabled={loadingZones.has(provider.provider_id)}
            title="{visibleZones.has(provider.provider_id) ? 'Hide' : 'Show'} service area"
          >
            {#if loadingZones.has(provider.provider_id)}
              <div class="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
            {:else}
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                      d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
              </svg>
            {/if}
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<!-- Tooltip for hovered provider -->
{#if hoveredProviderId}
  {@const hoveredProvider = providers.find(p => p.provider_id === hoveredProviderId)}
  {#if hoveredProvider}
    <div 
      class="provider-tooltip"
      style="left: {tooltipPosition.x}px; top: {tooltipPosition.y}px;"
      in:fade={{ duration: 200 }}
    >
      <h4>{hoveredProvider.provider_name}</h4>
      
      <div class="tooltip-section">
        <strong>Type:</strong> {hoveredProvider.provider_type || 'N/A'}
      </div>
      
      {#if hoveredProvider.provider_org}
        <div class="tooltip-section">
          <strong>Organization:</strong> {hoveredProvider.provider_org}
        </div>
      {/if}
      
      {#if hoveredProvider.routing_type}
        <div class="tooltip-section">
          <strong>Routing:</strong> {hoveredProvider.routing_type}
        </div>
      {/if}
      
      {#if hoveredProvider.eligibility_req}
        <div class="tooltip-section">
          <strong>Eligibility:</strong> {hoveredProvider.eligibility_req}
        </div>
      {/if}
      
      <div class="tooltip-section">
        <strong>Service Hours:</strong>
        <div class="pre-wrap">{formatServiceHours(hoveredProvider.service_hours)}</div>
      </div>
      
      {#if hoveredProvider.website}
        <div class="tooltip-section">
          <strong>Website:</strong>
          <a href={hoveredProvider.website} target="_blank" rel="noopener noreferrer" class="link">
            Visit website
          </a>
        </div>
      {/if}
      
      {#if hoveredProvider.booking}
        <div class="tooltip-section">
          <strong>Booking:</strong> {hoveredProvider.booking.method || 'Contact provider'}
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .provider-panel {
    position: fixed;
    left: 1.5rem;
    top: 7rem; /* Below the back button */
    width: 320px;
    max-height: 50vh;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(8px);
    border-radius: 1rem;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(229, 231, 235, 0.8);
    display: flex;
    flex-direction: column;
    z-index: 30;
  }
  
  .panel-header {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }
  
  .panel-header h3 {
    font-size: 1.125rem;
    font-weight: 700;
    color: #111827;
    margin: 0;
  }
  
  .provider-count {
    font-size: 0.75rem;
    color: #6b7280;
    margin-top: 0.25rem;
  }
  
  .search-container {
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid #e5e7eb;
    position: relative;
    flex-shrink: 0;
  }
  
  .search-input {
    width: 100%;
    padding: 0.5rem 2.5rem 0.5rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    transition: all 0.2s;
  }
  
  .search-input:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  }
  
  .clear-search {
    position: absolute;
    right: 1.5rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #6b7280;
    padding: 0.25rem;
    cursor: pointer;
    transition: color 0.2s;
  }
  
  .clear-search:hover {
    color: #111827;
  }
  
  .provider-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }
  
  .provider-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    margin-bottom: 0.25rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    transition: all 0.2s;
    cursor: default;
  }
  
  .provider-item:hover {
    background: #f9fafb;
    border-color: #d1d5db;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  }
  
  .provider-item.highlighted {
    background: #fef3c7;
    border-color: #f59e0b;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
  }
  
  .provider-item.highlighted:hover {
    background: #fde68a;
  }
  
  .provider-info {
    flex: 1;
    min-width: 0;
  }
  
  .provider-name {
    font-weight: 600;
    color: #111827;
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .provider-meta {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.125rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  
  .provider-type, .provider-org {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .zone-button {
    flex-shrink: 0;
    padding: 0.375rem;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    color: #6b7280;
    transition: all 0.2s;
    cursor: pointer;
  }
  
  .zone-button:hover {
    background: #e5e7eb;
    color: #111827;
  }
  
  .zone-button.active {
    background: #6366f1;
    color: white;
    border-color: #6366f1;
  }
  
  .zone-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .loading-state, .error-state, .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1rem;
    color: #6b7280;
    font-size: 0.875rem;
  }
  
  .error-state {
    color: #dc2626;
  }
  
  /* Tooltip styles */
  .provider-tooltip {
    position: fixed;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    padding: 1rem;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
    max-width: 320px;
    z-index: 50;
    pointer-events: none;
  }
  
  .provider-tooltip h4 {
    font-size: 1rem;
    font-weight: 700;
    color: #111827;
    margin: 0 0 0.75rem 0;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }
  
  .tooltip-section {
    margin-bottom: 0.5rem;
    font-size: 0.813rem;
    color: #374151;
  }
  
  .tooltip-section:last-child {
    margin-bottom: 0;
  }
  
  .tooltip-section strong {
    font-weight: 600;
    color: #111827;
  }
  
  .pre-wrap {
    white-space: pre-wrap;
    margin-top: 0.125rem;
  }
  
  .link {
    color: #6366f1;
    text-decoration: none;
  }
  
  .link:hover {
    text-decoration: underline;
  }
  
  /* Scrollbar styling */
  .provider-list::-webkit-scrollbar {
    width: 6px;
  }
  
  .provider-list::-webkit-scrollbar-track {
    background: #f3f4f6;
    border-radius: 3px;
  }
  
  .provider-list::-webkit-scrollbar-thumb {
    background: #d1d5db;
    border-radius: 3px;
  }
  
  .provider-list::-webkit-scrollbar-thumb:hover {
    background: #9ca3af;
  }
</style>
