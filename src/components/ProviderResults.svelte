<script>
  import { createEventDispatcher } from 'svelte';
  import { serviceZoneManager } from '../lib/serviceZoneManager.js';
  
  /**
   * @typedef {Object} PublicTransitData
   * @property {string} journey_description
   */
  
  /**
   * @typedef {Object} ProviderData
   * @property {Array<any>} data
   * @property {string} source_address
   * @property {string} destination_address
   * @property {PublicTransitData} [public_transit]
   */
  
  /** @type {ProviderData|null} */
  export let providerData = null;
  export let show = false;
  export let embedded = false; // New prop for embedded mode

  $: publicTransitDescription = providerData
    ? getPublicTransitDescription(providerData.public_transit)
    : null;
  
  // Local service zone state management
  let visibleZones = new Set();
  let loadingZones = false;
  
  const dispatch = createEventDispatcher();
  
  function closeWindow() {
    dispatch('close');
  }
  
  // Service zone state management
  let loadingProviderZones = new Set();

  async function toggleServiceZone(providerId, providerName, provider, index) {
    const isVisible = visibleZones.has(providerId);
    
    if (isVisible) {
      // Hide the zone
      serviceZoneManager.removeServiceZonesByProvider(providerId);
      visibleZones.delete(providerId);
      visibleZones = new Set(visibleZones); // Trigger reactivity
    } else {
      // Show the zone
      loadingProviderZones.add(providerId);
      loadingProviderZones = new Set(loadingProviderZones); // Trigger reactivity
      
      try {
        // Use the service zone data if available from provider
        if (provider.service_zone) {
          const zoneData = {
            type: 'provider',
            geoJson: typeof provider.service_zone === 'string' 
              ? JSON.parse(provider.service_zone) 
              : provider.service_zone,
            label: providerName,
            description: `${providerName} service area`,
            metadata: {
              providerId: providerId,
              provider: provider
            }
          };
          
          const zoneId = serviceZoneManager.addServiceZone(zoneData, false);
          if (zoneId) {
            visibleZones.add(providerId);
            // Focus on this specific provider's zone
            serviceZoneManager.focusOnServiceZone(zoneId);
          }
        } else {
          // Fallback: dispatch event to parent for API call
          dispatch('toggleZone', { providerId, providerName, index });
        }
      } catch (error) {
        console.error('Error loading service zone:', error);
      } finally {
        loadingProviderZones.delete(providerId);
        loadingProviderZones = new Set(loadingProviderZones); // Trigger reactivity
      }
    }
    
    visibleZones = new Set(visibleZones); // Trigger reactivity
  }

  function isProviderZoneLoading(providerId) {
    return loadingProviderZones.has(providerId);
  }
  
  function formatServiceHours(hoursData) {
    try {
      
      if (!hoursData || hoursData === 'null' || hoursData === '' || hoursData === 'undefined') {
        return 'Hours not available';
      }

      // If it's a string, parse it; if it's already an object, use it directly
      let hours;
      if (typeof hoursData === 'string') {
        hours = JSON.parse(hoursData);
      } else {
        hours = hoursData;
      }
      
      if (!hours || !hours.hours || !Array.isArray(hours.hours) || hours.hours.length === 0) {
        return 'Hours not available';
      }

      const formatTime = (time) => {
        if (!time || time.length !== 4) return 'Invalid time';
        const hour = parseInt(time.substring(0, 2));
        const minute = time.substring(2);
        const period = hour >= 12 ? 'PM' : 'AM';
        const formattedHour = hour % 12 || 12;
        return `${formattedHour}:${minute} ${period}`;
      };

      // Process all schedules and group them
      const formattedSchedules = [];
      
      for (const schedule of hours.hours) {
        if (!schedule.day || !schedule.start || !schedule.end) {
          continue;
        }
        
        const days = schedule.day.split('').map((day, index) => {
          // Backend uses Monday-Sunday format (0-6), so Mon=0, Tue=1, ..., Sun=6
          const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
          return day === '1' ? weekdays[index] : null;
        }).filter(Boolean).join(', ');

        if (days) {
          const start = formatTime(schedule.start);
          const end = formatTime(schedule.end);
          formattedSchedules.push(`${days}: ${start} - ${end}`);
        }
      }

      return formattedSchedules.length > 0 ? formattedSchedules.join('; ') : 'Hours not available';
    } catch (error) {
      return 'Hours not available';
    }
  }

  function getPublicTransitDescription(publicTransit) {
    if (!publicTransit) return null;

    if (typeof publicTransit === 'string') {
      const trimmed = publicTransit.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    const journeyDescription = publicTransit?.journey_description;
    if (typeof journeyDescription === 'string' && journeyDescription.trim()) {
      return journeyDescription.trim();
    }

    const parts = [];
    if (typeof publicTransit?.summary === 'string' && publicTransit.summary.trim()) {
      parts.push(publicTransit.summary.trim());
    }
    if (typeof publicTransit?.duration_text === 'string' && publicTransit.duration_text.trim()) {
      parts.push(publicTransit.duration_text.trim());
    }
    if (typeof publicTransit?.distance_text === 'string' && publicTransit.distance_text.trim()) {
      parts.push(publicTransit.distance_text.trim());
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  }

  function getProviderTypeLabel(type) {
    const types = {
      'ADA-para': 'ADA Paratransit',
      'volunteer-driver': 'Volunteer Driver Program'
    };
    return types[type] || type;
  }

  function parseBookingInfo(bookingValue) {
    try {
      const booking = typeof bookingValue === 'string' ? JSON.parse(bookingValue) : bookingValue;
      if (!booking) return null;
      if (booking.method === 'call' && typeof booking.details === 'string') return booking.details;
      const phone = booking.call || booking.phone || booking.contact;
      return typeof phone === 'string' ? phone : null;
    } catch {
      return null;
    }
  }

  function formatEligibility(eligibilityReqs) {
    if (!eligibilityReqs) return null;

    let reqs = eligibilityReqs;
    if (typeof eligibilityReqs === 'string') {
      try {
        reqs = JSON.parse(eligibilityReqs);
      } catch {
        return eligibilityReqs.trim() || null;
      }
    }

    if (reqs && typeof reqs === 'object' && !Array.isArray(reqs)) {
      const eligibility = typeof reqs.eligibility === 'string'
        ? reqs.eligibility.trim()
        : typeof reqs.eligibility_text === 'string'
          ? reqs.eligibility_text.trim()
          : '';
      const proof = typeof reqs.proof === 'string'
        ? reqs.proof.trim()
        : typeof reqs.proof_process === 'string'
          ? reqs.proof_process.trim()
          : '';

      if (eligibility || proof) {
        return [
          eligibility ? `Eligibility: ${eligibility}` : null,
          proof ? `Proof: ${proof}` : null
        ].filter(Boolean).join('\n');
      }

      if (Array.isArray(reqs.eligibility_reqs)) {
        reqs = reqs.eligibility_reqs;
      }
    }

    if (!Array.isArray(reqs) || reqs.length === 0) return null;

    const eligList = reqs.map(r => {
      if (typeof r === 'string') return r;
      const type = typeof r?.type === 'string' ? r.type : r?.eligibility_req || r?.eligibility_type || '';
      const proof = typeof r?.proof === 'string' ? r.proof : '';
      if (type && proof) return `${type} (${proof})`;
      return type;
    }).filter(Boolean);

    return eligList.length > 0 ? eligList.join(', ') : null;
  }

  // Array of colors for service zones
  const zoneColors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
    '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71'
  ];

  // Function to generate random trip duration between 5-20 minutes
  function generateTripDuration(providerId) {
    // Use provider ID as seed for consistent random duration
    const seed = parseInt(providerId.toString().slice(-3)) || 1;
    const random = (seed * 9301 + 49297) % 233280 / 233280; // Simple seeded random
    return Math.floor(5 + random * 16); // 5-20 minutes
  }

  // Normalize provider list in case payload is nested or malformed
  $: normalizedProviders = (() => {
    if (!providerData) return [];
    let providers = providerData.data;
    if (!Array.isArray(providers) && providers && Array.isArray(providers.data)) {
      providers = providers.data;
    }
    if (!Array.isArray(providers)) return [];
    return providers;
  })();

  // Sort providers by trip duration (shortest to longest) if we have provider data
  $: sortedProviders = normalizedProviders.length
    ? [...normalizedProviders]
        .map(provider => ({
          ...provider,
          estimatedDuration: generateTripDuration(provider.provider_id)
        }))
        .sort((a, b) => a.estimatedDuration - b.estimatedDuration)
    : [];
</script>

{#if show && providerData}
  <!-- Debug logging -->
  <div class="{embedded ? 'h-full flex flex-col' : 'fixed top-6 left-6 z-40 w-96 max-h-[calc(100vh-3rem)] bg-white/95 backdrop-blur-sm rounded-2xl shadow-2xl border border-gray-200 overflow-hidden'}">
    
    {#if !embedded}
      <!-- Header (only shown in non-embedded mode) -->
      <div class="flex items-center justify-between p-6 border-b border-gray-200 bg-white/90">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Transportation Providers</h3>
          <div class="flex items-center space-x-2">
            <p class="text-sm text-gray-600">
              {sortedProviders.length} provider{sortedProviders.length !== 1 ? 's' : ''} found
            </p>
            {#if loadingZones}
              <div class="flex items-center space-x-1 text-xs text-blue-600">
                <div class="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
                <span>Loading zones...</span>
              </div>
            {/if}
          </div>
        </div>
        <button
          class="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-full transition-colors"
          on:click={closeWindow}
          aria-label="Close provider results"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    {/if}

    <!-- Content -->
    <div class="{embedded ? 'flex-1 overflow-y-auto' : 'overflow-y-auto max-h-[calc(100vh-12rem)]'}">
      {#if sortedProviders.length === 0}
        <div class="text-gray-500 text-center py-8 bg-gray-50 m-6 rounded-lg">
          <div class="text-4xl mb-2">🚌</div>
          <p>No transportation providers found for your criteria.</p>
        </div>
      {:else}
        <div class="p-6 space-y-4">
          <!-- Trip Details Summary -->
          {#if providerData.source_address && providerData.destination_address}
            <div class="bg-gray-50 rounded-lg p-4 text-sm">
              <h4 class="font-medium text-gray-900 mb-2">Trip Details</h4>
              <div class="space-y-1 text-gray-600">
                <p><span class="font-medium">From:</span> {providerData.source_address}</p>
                <p><span class="font-medium">To:</span> {providerData.destination_address}</p>
              </div>
            </div>
          {/if}
          
          <!-- Public Transit Option -->
          {#if publicTransitDescription}
            <div class="bg-blue-50 rounded-lg p-4 text-sm border border-blue-200">
              <div class="flex items-start space-x-3">
                <div class="flex-shrink-0">
                  <svg class="w-5 h-5 text-blue-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                  </svg>
                </div>
                <div class="flex-1">
                  <h4 class="font-medium text-gray-900 mb-2">Public Transit Option</h4>
                  <p class="text-gray-700">{publicTransitDescription}</p>
                </div>
              </div>
            </div>
          {/if}
          
          <!-- Providers List -->
          <div class="space-y-3">
            {#each sortedProviders as provider, index}
              <div class="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow relative">
                <!-- Trip Duration Badge -->
                <div class="absolute top-3 right-3 bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded-full">
                  ~{provider.estimatedDuration} min
                </div>
                
                <div class="flex items-start space-x-3">
                  <!-- Color indicator -->
                  <div 
                    class="w-4 h-4 rounded-full flex-shrink-0 mt-1"
                    style="background-color: {zoneColors[index % zoneColors.length]}"
                  ></div>
                  
                  <!-- Provider details -->
                  <div class="flex-1 pr-16">
                    <h4 class="font-medium text-gray-900">{provider.provider_name}</h4>
                    <dl class="mt-2 text-sm text-gray-600 space-y-1">
                      <div class="flex">
                        <dt class="font-medium w-20">Type:</dt>
                        <dd>{getProviderTypeLabel(provider.provider_type)}</dd>
                      </div>
                      {#if provider.routing_type}
                        <div class="flex">
                          <dt class="font-medium w-20">Service:</dt>
                          <dd>{provider.routing_type.replace(/-/g, ' ')}</dd>
                        </div>
                      {/if}
                      {#if provider.service_hours}
                        <div class="flex">
                          <dt class="font-medium w-20">Hours:</dt>
                          <dd class="flex-1">{formatServiceHours(provider.service_hours)}</dd>
                        </div>
                      {/if}
                      {#if formatEligibility(provider.eligibility_reqs)}
                        <div class="flex">
                          <dt class="font-medium w-20">Eligibility:</dt>
                          <dd class="flex-1 whitespace-pre-line">{formatEligibility(provider.eligibility_reqs)}</dd>
                        </div>
                      {/if}
                      <div class="flex">
                        <dt class="font-medium w-20">Booking:</dt>
                        <dd class="flex-1">
                          {#if parseBookingInfo(provider.booking)}
                            <a href="tel:{parseBookingInfo(provider.booking)}" class="text-blue-600 hover:underline">
                              {parseBookingInfo(provider.booking)}
                            </a>
                          {:else}
                            Contact provider
                          {/if}
                        </dd>
                      </div>
                      {#if provider.website}
                        <div class="flex">
                          <dt class="font-medium w-20">Website:</dt>
                          <dd class="flex-1">
                            <a href={provider.website} target="_blank" rel="noopener noreferrer" 
                               class="text-blue-600 hover:underline">
                              Visit website
                            </a>
                          </dd>
                        </div>
                      {/if}
                    </dl>
                    
                    <!-- Service Zone Toggle Button -->
                    <div class="mt-3 pt-3 border-t border-gray-100">
                      <button
                        class="inline-flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors {
                          visibleZones.has(provider.provider_id)
                            ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }"
                        on:click={() => toggleServiceZone(provider.provider_id, provider.provider_name, provider, index)}
                        disabled={loadingZones || isProviderZoneLoading(provider.provider_id)}
                      >
                        {#if loadingZones || isProviderZoneLoading(provider.provider_id)}
                          <div class="animate-spin rounded-full h-3 w-3 border-b-2 border-current"></div>
                          <span>Loading...</span>
                        {:else if visibleZones.has(provider.provider_id)}
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"/>
                          </svg>
                          <span>Hide Service Zone</span>
                        {:else}
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
                          </svg>
                          <span>Show Service Zone</span>
                        {/if}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    {#if !embedded}
      <!-- Footer (only shown in non-embedded mode) -->
      <div class="flex justify-between items-center p-4 border-t border-gray-200 bg-gray-50/90">
        <p class="text-xs text-gray-600">
          Results from AI assistant
        </p>
        <button
          class="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          on:click={closeWindow}
        >
          Close
        </button>
      </div>
    {/if}
  </div>
{/if}
