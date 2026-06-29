<script lang="ts">
  // @ts-nocheck
  import { createEventDispatcher, onMount } from 'svelte';
  import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { formatScheduleType } from '$lib/providers/providerFields';
  const dispatch = createEventDispatcher();

  // Helper function to format datetime-local string
  function formatDateTimeLocal(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }

  // Set default times
  const now = new Date();
  const fourHoursLater = new Date(now.getTime() + (4 * 60 * 60 * 1000));

  export let loading = false;
  export let error = null;
  export let responseData = null;

  // Add predefined origin addresses
  const predefinedOrigins = [
    {
      label: "Safeway (Walnut Creek)",
      address: "600 S Broadway, Walnut Creek, CA"
    },
    {
      label: "BART (Walnut Creek)",
      address: "200 Ygnacio Valley Road, Walnut Creek, CA 94596"
    },
    {
      label: "Rossmoor Golf Clubs",
      address: "1010 Stanley Dollar Dr, Walnut Creek, CA 94595"
    },
    {
      label: "Kaiser Permanente",
      address: "1425 S Main St, Walnut Creek, CA 94596"
    }
  ];

  // Add predefined destinations
  const predefinedDestinations = [
    {
      label: "Broadway Plaza",
      address: "1275 Broadway Plaza, Walnut Creek, CA 94596"
    },
    {
      label: "UC Berkeley",
      address: "Barrow Ln, Berkeley, CA 94704"
    },
    {
      label: "Rossmoor Shopping Center",
      address: "1980 Tice Valley Blvd, Walnut Creek, CA 94595"
    },
    {
      label: "Police Station",
      address: "1666 N Main St, Walnut Creek, CA 94596"
    },
    {
      label: "Stoneridge Shopping Center",
      address: "1 Stoneridge Mall Rd, Pleasanton, CA 94588"
    }
  ];

  // Filter options based on database values
  const scheduleTypeOptions = [
    { value: '', label: 'All Schedule Types' },
    { value: 'fixed-schedules', label: 'Fixed Schedules' },
    { value: 'in-advance-book', label: 'Book in Advance' },
    { value: 'real-time-book', label: 'Real-time Booking' }
  ];

  const eligibilityTypeOptions = [
    { value: '', label: 'All Eligibility Types' },
    { value: 'Senior', label: 'Seniors (60+)' },
    { value: 'Disabled', label: 'Disabled / ADA' },
    { value: 'Veteran', label: 'Veterans' },
    { value: 'Resident', label: 'Area Residents' }
  ];

  const providerTypeOptions = [
    { value: '', label: 'All Provider Types' },
    { value: 'ADA-para', label: 'ADA Paratransit' },
    { value: 'para', label: 'Paratransit' },
    { value: 'fix-route', label: 'Fixed Route' },
    { value: 'volunteer-driver', label: 'Volunteer Driver' },
    { value: 'city', label: 'City Service' },
    { value: 'community', label: 'Community Service' },
    { value: 'discount-program', label: 'Discount Program' },
    { value: 'special-TNC', label: 'Special TNC' }
  ];

  // Update formData to use first predefined origin and destination as default
  let formData = {
    departureTime: formatDateTimeLocal(now),
    returnTime: formatDateTimeLocal(fourHoursLater),
    originAddress: predefinedOrigins[0].address,
    destinationAddress: predefinedDestinations[0].address,
    scheduleType: '',
    eligibilityType: '',
    providerType: ''
  };

  function handleSubmit() {
    dispatch('submit', formData);
  }

  // // Watch for changes to addresses using $: reactive statements
  // $: if (formData.originAddress) {
  //   dispatch('originUpdate', formData.originAddress);
  // }

  // $: if (formData.destinationAddress) {
  //   dispatch('destinationUpdate', formData.destinationAddress);
  // }

  // Dispatch initial addresses on mount
  onMount(() => {
    dispatch('originUpdate', formData.originAddress);
    dispatch('destinationUpdate', formData.destinationAddress);
  });

  function handleReturnToForm() {
    responseData = null;
    error = null;
  }

  function formatServiceHours(hoursValue) {
    try {
      const hours = typeof hoursValue === 'string' ? JSON.parse(hoursValue) : hoursValue;
      if (!hours?.hours?.[0]) return 'Hours not available';

      const schedule = hours.hours[0];
      const days = schedule.day.split('').map((day, index) => {
        const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return day === '1' ? weekdays[index] : null;
      }).filter(Boolean).join(', ');

      // Format time from "HHMM" to "HH:MM AM/PM"
      const formatTime = (time) => {
        const hour = parseInt(time.substring(0, 2));
        const minute = time.substring(2);
        const period = hour >= 12 ? 'PM' : 'AM';
        const formattedHour = hour % 12 || 12;
        return `${formattedHour}:${minute} ${period}`;
      };

      const start = formatTime(schedule.start);
      const end = formatTime(schedule.end);

      return `${days}: ${start} - ${end}`;
    } catch {
      return 'Hours not available';
    }
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

  function getEligibilityList(provider) {
    let elig = provider?.eligibility_reqs;
    if (elig && !Array.isArray(elig) && typeof elig === 'object') {
      const eligibility = typeof elig.eligibility === 'string'
        ? elig.eligibility.trim()
        : typeof elig.eligibility_text === 'string'
          ? elig.eligibility_text.trim()
          : '';
      const proof = typeof elig.proof === 'string'
        ? elig.proof.trim()
        : typeof elig.proof_process === 'string'
          ? elig.proof_process.trim()
          : '';
      if (eligibility || proof) {
        elig = [
          eligibility ? `Eligibility: ${eligibility}` : null,
          proof ? `Proof: ${proof}` : null
        ].filter(Boolean);
      } else if (Array.isArray(elig.eligibility_reqs)) {
        elig = elig.eligibility_reqs;
      }
    }
    if (elig && !Array.isArray(elig)) {
      elig = [String(elig)];
    }
    if (!Array.isArray(elig)) return [];

    return elig.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const type = typeof entry.type === 'string'
          ? entry.type
          : typeof entry.eligibility_req === 'string'
            ? entry.eligibility_req
            : typeof entry.eligibility_type === 'string'
              ? entry.eligibility_type
              : '';
        const proof = typeof entry.proof === 'string' ? entry.proof : '';
        if (type && proof) return `${type} (${proof})`;
        if (type) return type;
      }
      return String(entry);
    }).filter(Boolean);
  }

  async function handleOriginBlur() {
    if (formData.originAddress) {
      dispatch('originUpdate', formData.originAddress);
    }
  }

  async function handleDestinationBlur() {
    if (formData.destinationAddress) {
      dispatch('destinationUpdate', formData.destinationAddress);
    }
  }

  // Handle origin selection
  function handleOriginSelect(event) {
    formData.originAddress = event.target.value;
    handleOriginBlur();
  }

  // Handle destination selection
  function handleDestinationSelect(event) {
    formData.destinationAddress = event.target.value;
    handleDestinationBlur();
  }
</script>

{#if responseData}
  <div class="space-y-4">
    {#if responseData.data.length === 0}
      <div class="text-gray-500 text-center py-8 bg-gray-50 rounded-lg">
        <div class="text-4xl mb-2">🚌</div>
        <p>No transportation providers found for your route and criteria.</p>
        <p class="text-sm mt-1">Try adjusting your search parameters.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each responseData.data as provider, index}
          <div
            class="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
            role="button"
            tabindex="0"
            aria-label={`Focus ${provider.provider_name} service zone`}
            on:click={() => dispatch('focusProvider', provider)}
            on:keydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dispatch('focusProvider', provider);
              }
            }}
          >
            <div class="flex items-start space-x-3">
              <!-- Color indicator -->
              <div
                class="w-4 h-4 rounded-full flex-shrink-0 mt-1"
                style={`background-color: ${provider._zone_color || '#3B82F6'}`}
                title="Service zone color"
              ></div>

              <!-- Service details -->
              <div class="flex-1">
                <h4 class="font-medium text-gray-900">{provider.provider_name}</h4>
                <dl class="mt-2 text-sm text-gray-600 space-y-1">
                  <div class="flex">
                    <dt class="font-medium w-24">Type:</dt>
                    <dd>{getProviderTypeLabel(provider.provider_type)}</dd>
                  </div>
                  {#if provider.routing_type}
                    <div class="flex">
                      <dt class="font-medium w-24">Service:</dt>
                      <dd>{provider.routing_type.replace(/-/g, ' ')}</dd>
                    </div>
                  {/if}
                  {#if provider.schedule_type}
                    <div class="flex">
                      <dt class="font-medium w-24">Schedule:</dt>
                      <dd>{formatScheduleType(provider.schedule_type) || 'Schedule varies'}</dd>
                    </div>
                  {/if}
                  <div class="flex">
                    <dt class="font-medium w-24">Hours:</dt>
                    <dd>{formatServiceHours(provider.service_hours)}</dd>
                  </div>
                  <div class="flex">
                    <dt class="font-medium w-24">Booking:</dt>
                    <dd>
                      {#if parseBookingInfo(provider.booking)}
                        <a href="tel:{parseBookingInfo(provider.booking)}" class="text-blue-600 hover:underline">
                          {parseBookingInfo(provider.booking)}
                        </a>
                      {:else}
                        {provider.booking?.method ? provider.booking.method : 'Contact provider'}
                      {/if}
                    </dd>
                  </div>
                  {#if getEligibilityList(provider).length}
                    <div class="flex">
                      <dt class="font-medium w-24">Eligibility:</dt>
                      <dd class="flex flex-wrap gap-1">
                        {#each getEligibilityList(provider) as req}
                          <span class="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-700">{req}</span>
                        {/each}
                      </dd>
                    </div>
                  {/if}
                  {#if provider.website}
                    <div class="flex">
                      <dt class="font-medium w-24">Website:</dt>
                      <dd>
                        <a href={provider.website} target="_blank" rel="noopener noreferrer"
                           class="text-blue-600 hover:underline">
                          Visit website
                        </a>
                      </dd>
                    </div>
                  {/if}
                </dl>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Trip Details Summary -->
    <div class="bg-gray-50 rounded-lg p-4 text-sm">
      <h3 class="font-medium text-gray-900 mb-2">Your Trip Details</h3>
      <div class="space-y-1 text-gray-600">
        <p><span class="font-medium">From:</span> {formData.originAddress}</p>
        <p><span class="font-medium">To:</span> {formData.destinationAddress}</p>
        <p><span class="font-medium">Departure:</span> {new Date(formData.departureTime).toLocaleString()}</p>
        <p><span class="font-medium">Return:</span> {new Date(formData.returnTime).toLocaleString()}</p>
      </div>
    </div>

    <div class="flex justify-end">
      <button
        type="button"
        class="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        on:click={handleReturnToForm}
      >
        Submit Another Request
      </button>
    </div>
  </div>

{:else if error}
  <div class="rounded-md bg-red-50 p-4">
    <div class="flex">
      <div class="flex-shrink-0">
        <!-- You can add an error icon here -->
      </div>
      <div class="ml-3">
        <h3 class="text-sm font-medium text-red-800">Error Submitting Request</h3>
        <div class="mt-2 text-sm text-red-700">
          <p>Error: {error.error || error}</p>
          {#if error.details}
            <ul class="list-disc list-inside mt-2">
              {#each Object.entries(error.details) as [field, message]}
                <li>{message}</li>
              {/each}
            </ul>
          {/if}
        </div>
        <div class="mt-4">
          <button
            type="button"
            class="bg-red-50 text-red-800 px-4 py-2 rounded-md text-sm font-medium hover:bg-red-100"
            on:click={handleReturnToForm}
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  </div>

{:else}
  <form on:submit|preventDefault={handleSubmit} class="space-y-4">
    <!-- Basic fields always visible -->
    <Card class="shadow-sm border-border/60">
      <CardHeader>
        <CardTitle class="text-lg">Plan your trip</CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="grid grid-cols-1 gap-3">
          <div class="space-y-1">
            <label for="departureTime" class="block text-sm font-medium text-muted-foreground">Departure time</label>
            <Input 
              id="departureTime"
              type="datetime-local" 
              bind:value={formData.departureTime}
              required
            />
          </div>

          <div class="space-y-1">
            <label for="returnTime" class="block text-sm font-medium text-muted-foreground">Return time</label>
            <Input 
              id="returnTime"
              type="datetime-local" 
              bind:value={formData.returnTime}
              required
            />
          </div>

          <div class="space-y-1">
            <label for="originAddress" class="block text-sm font-medium text-muted-foreground">Origin</label>
            <select
              id="originAddress"
              bind:value={formData.originAddress}
              on:change={handleOriginSelect}
              class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
            >
              {#each predefinedOrigins as origin}
                <option value={origin.address}>
                  {origin.label}
                </option>
              {/each}
            </select>
          </div>

          <div class="space-y-1">
            <label for="destinationAddress" class="block text-sm font-medium text-muted-foreground">Destination</label>
            <select
              id="destinationAddress"
              bind:value={formData.destinationAddress}
              on:change={handleDestinationSelect}
              class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
            >
              {#each predefinedDestinations as destination}
                <option value={destination.address}>
                  {destination.label}
                </option>
              {/each}
            </select>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Filter Options -->
    <Card class="shadow-sm border-border/60">
      <CardHeader class="pb-2">
        <CardTitle class="text-sm font-medium text-muted-foreground">Filter Options</CardTitle>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="space-y-1">
          <label for="eligibilityType" class="block text-sm font-medium text-muted-foreground">Eligibility</label>
          <select
            id="eligibilityType"
            bind:value={formData.eligibilityType}
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {#each eligibilityTypeOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-1">
          <label for="scheduleType" class="block text-sm font-medium text-muted-foreground">Schedule Type</label>
          <select
            id="scheduleType"
            bind:value={formData.scheduleType}
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {#each scheduleTypeOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        <div class="space-y-1">
          <label for="providerType" class="block text-sm font-medium text-muted-foreground">Provider Type</label>
          <select
            id="providerType"
            bind:value={formData.providerType}
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {#each providerTypeOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
      </CardContent>
    </Card>

    <div class="space-y-2">
      <Button type="submit" class="mt-2 w-full" disabled={loading}>
        {#if loading}
          <svg class="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Searching...
        {:else}
          Submit
        {/if}
      </Button>
    </div>
  </form>
{/if} 
