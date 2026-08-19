<script>
  /**
   * The fixed-route itinerary as an inline option, rendered alongside the provider cards so the
   * rider sees every way to make the trip in one place. Nothing to phone here, so the card leads
   * with the journey instead of a number.
   */

  export let transit;
  export let selected = false;
  export let onSelect = null;

  function lines(publicTransit) {
    const names = (Array.isArray(publicTransit?.steps) ? publicTransit.steps : [])
      .map((step) => step?.transit_details?.line_name)
      .filter((line) => typeof line === 'string' && line.trim())
      .map((line) => line.trim());
    return [...new Set(names)];
  }

  function stripInstruction(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  function googleMapsUrl(publicTransit) {
    if (typeof publicTransit?.google_maps_url === 'string' && publicTransit.google_maps_url.trim()) {
      return publicTransit.google_maps_url.trim();
    }
    const origin = publicTransit?.start_address;
    const destination = publicTransit?.end_address;
    if (!origin || !destination) return null;
    const params = new URLSearchParams({
      api: '1',
      origin,
      destination,
      travelmode: 'transit'
    });
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  $: steps = Array.isArray(transit?.steps) ? transit.steps : [];
  $: transitLines = lines(transit);
  $: mapsUrl = googleMapsUrl(transit);
  $: hasRouteDetail = transit?.routing_status !== 'handoff_only' && (
    Boolean(transit?.overview_polyline || transit?.polyline) || steps.length > 0
  );
</script>

<article
  class="my-2 rounded-lg border p-3 text-left transition {selected
    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400/40 dark:bg-blue-950/30'
    : 'border-blue-200 bg-background/80 hover:border-blue-400 dark:border-blue-900'}"
  data-provider-kind="public-transit"
  data-provider-name="Public Transit"
>
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2">
      <span class="shrink-0 text-base">🚇</span>
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-foreground">Public Transit</div>
        <div class="text-[10px] uppercase tracking-wide text-blue-700">
          {hasRouteDetail ? 'Fixed-route itinerary' : 'Plan fixed-route trip'}
        </div>
      </div>
    </div>
    <span class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">No booking needed</span>
  </div>

  <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground">
    {#if transit?.duration_text}
      <span class="font-semibold">{transit.duration_text}</span>
    {/if}
    {#if transit?.distance_text}
      <span class="text-muted-foreground">{transit.distance_text}</span>
    {/if}
    {#if transit?.departure_time || transit?.arrival_time}
      <span class="text-muted-foreground">
        {transit.departure_time || 'Departure'} → {transit.arrival_time || 'Arrival'}
      </span>
    {/if}
  </div>

  {#if transitLines.length > 0}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each transitLines as line}
        <span class="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-800">{line}</span>
      {/each}
    </div>
  {/if}

  {#if steps.length > 0}
    <ol class="mt-2 space-y-1 text-[11px]">
      {#each steps.slice(0, 5) as step, index}
        <li class="grid grid-cols-[1rem_1fr] gap-1.5 leading-snug">
          <span class="text-blue-600">{index + 1}.</span>
          <span>
            {step.transit_details?.line_name || stripInstruction(step.instruction) || step.travel_mode}
            {#if step.duration_text}<span class="text-muted-foreground"> · {step.duration_text}</span>{/if}
          </span>
        </li>
      {/each}
      {#if steps.length > 5}
        <li class="pl-6 text-muted-foreground">+{steps.length - 5} more steps</li>
      {/if}
    </ol>
  {/if}

  {#if onSelect || mapsUrl}
    <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
      {#if onSelect && hasRouteDetail}
        <button
          type="button"
          class="min-h-11 rounded-md bg-blue-600 px-3 py-2 font-medium text-white transition hover:bg-blue-700"
          on:click|stopPropagation={() => onSelect({
            provider_id: 'public-transit',
            provider_name: 'Public Transit',
            provider_type: 'fixed-route',
            is_public_transit: true,
            public_transit: transit
          })}
        >
          {selected ? 'Hide route' : 'Show route'}
        </button>
      {/if}
      {#if mapsUrl}
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center rounded-md border border-blue-200 px-3 py-2 font-medium text-blue-700 transition hover:bg-blue-50"
        >
          Open in Google Maps
        </a>
      {/if}
    </div>
  {/if}
</article>
