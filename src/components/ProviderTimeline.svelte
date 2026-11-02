<script lang="ts">
  import { providerTimeline } from '$lib/providers/providerTimeline';

  export let provider: Record<string, unknown>;
  $: timeline = providerTimeline(provider);
</script>

{#if !timeline.fixedRoute}
  <section class="mt-3 rounded-lg border border-border bg-background p-3 text-sm text-foreground" aria-label={`Application and booking for ${provider?.provider_name || 'this provider'}`} data-provider-timeline>
    <h5 class="font-semibold">Application and booking</h5>
    <dl class="mt-2 space-y-2">
      <div>
        <dt class="font-medium">Application</dt>
        <dd>{timeline.required === true ? 'Required before your first ride. Allow time for the provider to process your application.' : timeline.required === false ? 'No application required.' : 'Contact the provider to confirm whether you need to apply before your first ride.'}</dd>
      </div>
      {#if timeline.required !== false}
        <div>
          <dt class="font-medium">Application processing time</dt>
          <dd>{timeline.processingTime || 'Contact the provider to confirm processing time.'}</dd>
        </div>
      {/if}
      <div>
        <dt class="font-medium">Booking notice</dt>
        <dd>{timeline.bookingNotice}</dd>
        {#if timeline.regionalNotice}
          <dd class="mt-1">Regional trips: {timeline.regionalNotice}</dd>
        {/if}
      </div>
    </dl>
    {#if timeline.required !== false}
      <p class="mt-2">Booking notice is separate from application processing. A possible eligibility match does not mean you can book a ride immediately.</p>
    {/if}
    {#if timeline.instructions}
      <p class="mt-2 whitespace-pre-line">{timeline.instructions}</p>
    {/if}
    {#if timeline.sourceUrl || timeline.verifiedAt}
      <p class="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {#if timeline.sourceUrl}
          <a href={timeline.sourceUrl} target="_blank" rel="noopener noreferrer" class="font-medium text-primary underline" on:click|stopPropagation>Application information (opens in a new tab)</a>
        {/if}
        {#if timeline.verifiedAt}<span>Last verified: {timeline.verifiedAt}</span>{/if}
      </p>
    {/if}
  </section>
{/if}
