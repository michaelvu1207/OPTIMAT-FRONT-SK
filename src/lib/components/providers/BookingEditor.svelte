<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { BOOKING_METHOD_OPTIONS, tryParseJson } from '$lib/providers/providerFields';
  import { buildBookingValue, formatProcessingTime, processingTimeFromForm, PROCESSING_UNITS, type ApplicationInfo } from '$lib/providers/providerTimeline';

  export let value: unknown = null;
  export let disabled = false;
  export let valid = true;

  let initialized = false;
  let baseBooking: Record<string, unknown> = {};
  let method = '';
  let details = '';
  let applicationRequired = '';
  let processingKind = 'unknown';
  let processingAmount: number | undefined;
  let processingMinimum: number | undefined;
  let processingMaximum: number | undefined;
  let processingUnit = 'calendar_days';
  let existingProcessingTime: ApplicationInfo['processing_time'];
  let applicationInstructions = '';
  let sourceType = '';
  let sourceUrl = '';
  let sourceNotes = '';
  let verifiedAt = '';

  onMount(() => {
    const parsed = tryParseJson(value);
    baseBooking = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : typeof parsed === 'string' && parsed.trim() ? { legacy_notes: parsed } : {};
    method = typeof baseBooking.method === 'string' ? baseBooking.method : '';
    details = typeof baseBooking.details === 'string' ? baseBooking.details : '';
    const app = baseBooking.application && typeof baseBooking.application === 'object' && !Array.isArray(baseBooking.application)
      ? baseBooking.application as Record<string, unknown> : {};
    applicationRequired = typeof app.required === 'boolean' ? String(app.required) : '';
    existingProcessingTime = app.processing_time as ApplicationInfo['processing_time'];
    if (existingProcessingTime && typeof existingProcessingTime === 'object' && formatProcessingTime(existingProcessingTime)) {
      processingKind = existingProcessingTime.kind;
      if ('unit' in existingProcessingTime) processingUnit = existingProcessingTime.unit;
      if ('value' in existingProcessingTime) processingAmount = existingProcessingTime.value;
      if ('minimum' in existingProcessingTime) processingMinimum = existingProcessingTime.minimum;
      if ('maximum' in existingProcessingTime) processingMaximum = existingProcessingTime.maximum;
    } else if (formatProcessingTime(existingProcessingTime)) processingKind = 'existing';
    applicationInstructions = typeof app.instructions === 'string' ? app.instructions : '';
    sourceType = typeof app.source_type === 'string' ? app.source_type : '';
    sourceUrl = typeof app.source_url === 'string' ? app.source_url : '';
    sourceNotes = typeof app.source_notes === 'string' ? app.source_notes : '';
    verifiedAt = typeof app.verified_at === 'string' ? app.verified_at : '';
    initialized = true;
  });

  $: processingResult = processingTimeFromForm({ kind: processingKind, value: processingAmount, minimum: processingMinimum, maximum: processingMaximum, unit: processingUnit });
  $: processingTime = applicationRequired === 'false' ? undefined : processingKind === 'existing' ? existingProcessingTime : processingResult.data;
  $: processingError = applicationRequired === 'false' || processingKind === 'existing' ? null : processingResult.error;
  $: valid = !processingError;
  $: preview = formatProcessingTime(processingTime);
  $: if (initialized && valid) {
    value = buildBookingValue(baseBooking, method, details, {
      required: applicationRequired === '' ? undefined : applicationRequired === 'true',
      processing_time: processingTime,
      instructions: applicationInstructions,
      source_type: sourceType,
      source_url: sourceUrl,
      source_notes: sourceNotes,
      verified_at: verifiedAt,
    });
  }

  function useToday() {
    const today = new Date();
    verifiedAt = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }
</script>

<div class="space-y-4" data-booking-editor>
  <p class="text-sm text-foreground">Fill in the fields below, then select Save changes.</p>
  <div class="grid gap-3 sm:grid-cols-2">
    <label class="block text-sm">
      How does the rider book?
      <select bind:value={method} {disabled} aria-label="How does the rider book?" class="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="">Not yet confirmed</option>
        {#each BOOKING_METHOD_OPTIONS as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    {#if method !== 'none'}
      <label class="block text-sm">
        {method === 'call' ? 'Booking phone number' : method === 'app' ? 'Booking app name' : 'Booking details (optional)'}
        <Input bind:value={details} {disabled} placeholder={method === 'call' ? 'e.g., 925-555-0100' : method === 'app' ? 'e.g., Lyft' : 'Existing booking instructions'} class="mt-1" />
      </label>
    {/if}
  </div>
  {#if baseBooking.legacy_notes}
    <p class="rounded-md bg-muted p-3 text-sm text-foreground">Previous booking information is preserved: {baseBooking.legacy_notes}</p>
  {/if}

  <section class="rounded-lg border border-border p-4" aria-label="Initial application">
    <h3 class="font-semibold text-foreground">Before the first ride</h3>
    <p class="mt-2 text-sm text-foreground">Use provider-confirmed information. Choose Not yet confirmed when you do not know; booking notice belongs in the Schedule section.</p>
    <div class="mt-4 grid gap-4 sm:grid-cols-2">
      <label class="block text-sm sm:col-span-2">
        Does the rider need to apply first?
        <select bind:value={applicationRequired} {disabled} aria-label="Does the rider need to apply first?" class="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Not yet confirmed</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>

      {#if applicationRequired !== 'false'}
        <label class="block text-sm sm:col-span-2">
          How long does application processing take?
          <select bind:value={processingKind} {disabled} aria-label="How long does application processing take?" class="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="unknown">Not yet confirmed</option>
            <option value="same_day">Same day</option>
            <option value="estimate">About (estimated)</option>
            <option value="range">Between two numbers</option>
            <option value="up_to">Up to (maximum)</option>
            <option value="at_least">At least (minimum)</option>
            {#if existingProcessingTime && typeof existingProcessingTime === 'string'}<option value="existing">Keep existing wording</option>{/if}
          </select>
        </label>
        {#if processingKind === 'existing'}
          <p class="text-sm text-foreground sm:col-span-2">Existing processing time: {existingProcessingTime}. Choose another format above to replace it using numbers.</p>
        {:else if !['unknown', 'same_day'].includes(processingKind)}
          {#if processingKind === 'range'}
            <label class="block text-sm">Minimum
              <Input type="number" min="1" step="1" bind:value={processingMinimum} {disabled} aria-invalid={Boolean(processingError)} class="mt-1" />
            </label>
            <label class="block text-sm">Maximum
              <Input type="number" min="1" step="1" bind:value={processingMaximum} {disabled} aria-invalid={Boolean(processingError)} class="mt-1" />
            </label>
          {:else}
            <label class="block text-sm">Number
              <Input type="number" min="1" step="1" bind:value={processingAmount} {disabled} aria-invalid={Boolean(processingError)} class="mt-1" />
            </label>
          {/if}
          <label class="block text-sm">Time unit
            <select bind:value={processingUnit} {disabled} aria-label="Time unit" class="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {#each PROCESSING_UNITS as unit}<option value={unit.value}>{unit.label}</option>{/each}
            </select>
          </label>
        {/if}
        {#if processingError}<p role="alert" class="text-sm text-destructive sm:col-span-2">{processingError}</p>{/if}
        {#if preview}<p class="rounded-md bg-muted p-3 text-sm text-foreground sm:col-span-2" data-processing-preview><strong>Riders will see:</strong> {preview}</p>{/if}
      {:else}
        <p class="text-sm text-foreground sm:col-span-2">No application processing time will be shown.</p>
      {/if}

      <label class="block text-sm sm:col-span-2">Application steps (optional)
        <Textarea bind:value={applicationInstructions} {disabled} placeholder="Brief instructions, such as completing a form or calling the application office" rows={2} class="mt-1" />
      </label>
      <label class="block text-sm">How was this information confirmed?
        <select bind:value={sourceType} {disabled} aria-label="How was this information confirmed?" class="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Not recorded</option>
          <option value="website">Official provider website</option>
          <option value="phone">Phone call with provider</option>
          <option value="email">Email from provider</option>
          <option value="other">Other source</option>
        </select>
      </label>
      <label class="block text-sm">Source link (optional)
        <Input bind:value={sourceUrl} {disabled} type="url" placeholder="https://" class="mt-1" />
      </label>
      <label class="block text-sm sm:col-span-2">Confirmation notes (optional)
        <Textarea bind:value={sourceNotes} {disabled} placeholder="What the provider confirmed" rows={2} class="mt-1" />
      </label>
      <label class="block text-sm">Date checked
        <Input bind:value={verifiedAt} {disabled} type="date" class="mt-1" />
      </label>
      <div class="flex items-end"><Button type="button" variant="outline" onclick={useToday} {disabled}>Use today's date</Button></div>
    </div>
  </section>
</div>
