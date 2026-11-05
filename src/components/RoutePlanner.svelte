<script>
  export let plan;
  function safeUrl(value, mode) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'www.google.com' && !url.port && !url.username && !url.password && url.pathname === '/maps/dir/' && url.searchParams.get('api') === '1' && url.searchParams.get('travelmode') === mode && ['transit', 'bicycling'].includes(mode) ? url.href : null;
    } catch { return null; }
  }
  $: href = safeUrl(plan?.url, plan?.mode);
</script>
{#if href}
  <div class="rounded-lg border border-border bg-background p-3 text-sm" data-route-planner>
    <a {href} target="_blank" rel="noopener noreferrer" class="inline-flex min-h-11 items-center rounded-lg border border-primary px-3 py-2 font-semibold text-primary underline">{plan.mode === 'bicycling' ? 'Plan a bike trip' : 'Plan a bus/train trip'} (opens in a new tab)</a>
    <p class="mt-2">Check the date, time and route in Google Maps. OPTIMAT does not calculate this route.</p>
  </div>
{/if}
