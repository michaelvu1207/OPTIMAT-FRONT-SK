<script>
  /**
   * A provider, as a rider needs it at the moment of booking: who to call, by when, what it costs,
   * and whether their eligibility is settled.
   *
   * Rendered inline in the conversation, directly under the paragraph that names the provider, so
   * the details sit with the sentence that introduced them instead of in a separate panel the
   * rider has to cross-reference.
   */

  export let provider;
  /** True when the search confirmed the rider meets this provider's requirements. */
  export let qualified = true;
  /** Resolved trip, used for the booking deadline and the unconfirmed-hours note. */
  export let trip = null;
  export let selected = false;
  export let onSelect = null;

  const RIDER_FACT_LABELS = {
    age: 'your age',
    disabled: 'whether you have a disability',
    ada_certified: 'ADA certification',
    veteran: 'veteran status',
    residence_city: 'where you live'
  };

  function parseMaybeJson(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function providerPhone(entry) {
    if (typeof entry?.phone === 'string' && entry.phone.trim()) return entry.phone.trim();
    const booking = parseMaybeJson(entry?.booking);
    if (!booking) return null;
    for (const candidate of [booking.phone, booking.call, booking.contact]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const details = [booking.details, booking.instructions].find((value) => typeof value === 'string');
    return details?.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] || null;
  }

  function advanceNotice(entry) {
    const schedule = parseMaybeJson(entry?.schedule_type);
    const notice = schedule?.advance_notice;
    return typeof notice === 'string' && notice.trim() ? notice.trim() : null;
  }

  /** "7 days" against the travel date becomes the date the rider has to call by. */
  function bookByDate(entry, travelDate) {
    const notice = advanceNotice(entry);
    if (!notice || !travelDate) return null;
    const days = Number(notice.match(/(\d+)\s*day/i)?.[1]);
    if (!Number.isFinite(days)) return null;
    const [year, month, day] = String(travelDate).split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'
    }).format(new Date(Date.UTC(year, month - 1, day - days)));
  }

  function fareText(entry) {
    const fare = parseMaybeJson(entry?.fare);
    if (!fare) return null;
    if (fare.type === 'free') return 'Free';
    const cost = typeof fare.cost === 'string' ? fare.cost.trim() : null;
    if (!cost) return null;
    return fare.payment ? `${cost} · pay by ${fare.payment}` : cost;
  }

  function eligibilityLines(entry) {
    const reqs = entry?.eligibility_reqs;
    if (!reqs) return [];
    const text = typeof reqs === 'string' ? reqs : JSON.stringify(reqs);
    return text
      .split(/\.\s+|\s*·\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 2)
      .slice(0, 3);
  }

  function missingFactsSentence(entry) {
    const facts = Array.isArray(entry?.missing_facts) ? entry.missing_facts : [];
    if (facts.length === 0) return 'whether you may qualify for this service.';
    return `whether you may qualify — it turns on ${facts.map((fact) => RIDER_FACT_LABELS[fact] || fact).join(' and ')}.`;
  }

  function typeIcon(type) {
    const value = String(type || '').toLowerCase();
    if (value.includes('para') || value.includes('ada')) return '♿';
    if (value.includes('fix')) return '🚌';
    if (value.includes('dial') || value.includes('demand')) return '📞';
    return '🚐';
  }

  function normalizeWebsite(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const website = value.trim();
    if (/^https?:\/\//i.test(website)) return website;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(website)) return `https://${website}`;
    return null;
  }

  /**
   * The search marks this per provider, but stored snapshots (replayed examples) predate the flag,
   * so fall back to whether hours are present at all rather than warning about hours we have.
   */
  function serviceHoursKnown(entry) {
    if (entry?.service_hours_known !== undefined) return Boolean(entry.service_hours_known);
    const hours = parseMaybeJson(entry?.service_hours);
    return Array.isArray(hours?.hours) ? hours.hours.length > 0 : Boolean(hours);
  }

  $: phone = providerPhone(provider);
  $: notice = advanceNotice(provider);
  $: deadline = bookByDate(provider, trip?.date);
  $: fare = fareText(provider);
  $: website = normalizeWebsite(provider?.website);
  $: requirements = eligibilityLines(provider);
  $: hoursKnown = serviceHoursKnown(provider);
</script>

<article
  class="my-2 rounded-lg border p-3 text-left transition {
    qualified
      ? (selected ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border/70 bg-background/80 hover:border-border')
      : (selected ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400/40 dark:bg-amber-950/30' : 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20')
  }"
  data-provider-kind={qualified ? 'callable' : 'verification-required'}
  data-provider-name={provider?.provider_name}
>
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-center gap-2">
      <span class="shrink-0 text-base">{typeIcon(provider?.provider_type)}</span>
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold text-foreground">{provider?.provider_name}</div>
        {#if provider?.routing_type}
          <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{provider.routing_type}</div>
        {/if}
      </div>
    </div>
    {#if qualified}
      <span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">You may qualify</span>
    {:else}
      <span class="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">Confirm eligibility</span>
    {/if}
  </div>

  <!-- The number is the point of the card, so it is the largest thing on it. -->
  <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
    {#if phone}
      <a
        href="tel:{phone.replace(/[^\d+]/g, '')}"
        class="text-base font-semibold text-primary hover:underline"
        on:click|stopPropagation
      >
        📞 {phone}
      </a>
    {:else}
      <span class="text-xs text-muted-foreground">No phone number on file — see their website</span>
    {/if}
    {#if fare}
      <span class="text-xs text-foreground">{fare}</span>
    {/if}
  </div>

  {#if deadline}
    <div class="mt-1.5 text-[11px] font-medium text-foreground">
      Call by {deadline}
      <span class="font-normal text-muted-foreground">· needs {notice} notice</span>
    </div>
  {:else if notice}
    <div class="mt-1.5 text-[11px] text-muted-foreground">Needs {notice} advance notice</div>
  {/if}

  {#if !qualified}
    <div class="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <span class="font-semibold">Ask when you call:</span> {missingFactsSentence(provider)}
      {#if requirements.length > 0}
        <div class="mt-1 text-amber-800 dark:text-amber-300">{requirements.join(' · ')}</div>
      {/if}
    </div>
  {/if}

  {#if !hoursKnown}
    <div class="mt-1.5 text-[11px] text-muted-foreground">
      Operating hours aren't on file{trip?.time ? ` — confirm ${trip.time} works` : ' — confirm your time'}.
    </div>
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
    {#if onSelect}
      <button
        type="button"
        class="rounded-md bg-muted px-2 py-1 font-medium text-foreground transition hover:bg-muted/70"
        on:click|stopPropagation={() => onSelect(provider)}
      >
        {selected ? 'Hide area' : 'Show service area'}
      </button>
    {/if}
    {#if website}
      <a
        href={website}
        target="_blank"
        rel="noopener noreferrer"
        class="text-primary hover:underline"
        on:click|stopPropagation
      >
        Website
      </a>
    {/if}
  </div>
</article>
