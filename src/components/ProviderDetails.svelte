<script lang="ts">
  import { formatBooking, formatEligibilityReqs, formatFare, membershipBillingNotice, formatRoutingType, tryParseJson } from '$lib/providers/providerFields';
  import { formatProcessingTime } from '$lib/providers/providerTimeline';
  import ProviderTimeline from './ProviderTimeline.svelte';

  export let info: unknown;
  const record = (value: unknown): Record<string, unknown> => {
    const parsed = tryParseJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  };
  const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && !/^[\s]*[\[{]/.test(value) ? value.trim() : null;
  const website = (value: unknown): string | null => {
    const raw = text(value);
    if (!raw || (!/^https?:\/\//i.test(raw) && !/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw))) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  function phone(entry: Record<string, unknown>): string | null {
    const booking = record(entry.booking);
    const contacts = Array.isArray(entry.contacts) ? entry.contacts : [];
    for (const value of [entry.phone, booking.phone, booking.details, booking.instructions, ...contacts.map(contact => record(contact).phone)]) {
      const match = text(value)?.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (match) return match[0];
    }
    return null;
  }
  function email(value: unknown): string | null {
    const raw = text(value);
    return raw && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw) ? raw : null;
  }
  function hours(value: unknown): string[] {
    const parsed = tryParseJson(value);
    if (typeof parsed === 'string') return text(parsed) ? [text(parsed)!] : [];
    const rows = record(parsed).hours;
    if (!Array.isArray(rows)) return [];
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const time = (value: unknown) => {
      const match = typeof value === 'string' ? value.match(/^(\d{2}):?(\d{2})$/) : null;
      if (!match) return null;
      const h = Number(match[1]); const m = Number(match[2]);
      if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
      if (h === 24) return 'midnight';
      return `${h % 12 || 12}:${match[2]} ${h < 12 ? 'AM' : 'PM'}`;
    };
    return rows.flatMap(row => {
      const r = record(row); const day = text(r.day); const start = time(r.start); const end = time(r.end);
      if (!day || !start || !end) return [];
      const label = /^[01]{7}$/.test(day) ? days.filter((_, index) => day[index] === '1').join(', ') : day;
      return label ? [`${label}: ${start}–${end}`] : [];
    });
  }
  function timelineEntry(provider: Record<string, unknown>): Record<string, unknown> {
    const booking = record(provider.booking); const app = record(booking.application); const schedule = record(provider.schedule_type);
    const verified = text(app.verified_at);
    return {
      provider_name: text(provider.provider_name), provider_type: text(provider.provider_type),
      eligibility_reqs: text(formatEligibilityReqs(provider.eligibility_reqs || provider.eligibility_requirement)),
      schedule_type: { advance_notice: text(schedule.advance_notice), regional_advance_notice: text(schedule.regional_advance_notice) },
      booking: { method: text(booking.method), application: {
        required: typeof app.required === 'boolean' ? app.required : undefined,
        processing_time: text(formatProcessingTime(tryParseJson(app.processing_time))),
        instructions: text(app.instructions), source_url: website(app.source_url),
        verified_at: verified && /^\d{4}-\d{2}-\d{2}/.test(verified) && Number.isFinite(Date.parse(verified)) ? verified.slice(0, 10) : null,
      } },
    };
  }
  $: parsed = tryParseJson(info);
  $: providers = (Array.isArray(parsed) ? parsed : [parsed]).map(record).filter(entry => text(entry.provider_name));
</script>

{#each providers as provider}
  {@const name = text(provider.provider_name)}
  {@const number = phone(provider)}
  {@const url = website(provider.website)}
  {@const fare = text(formatFare(provider.fare))}
  {@const eligibility = text(formatEligibilityReqs(provider.eligibility_reqs || provider.eligibility_requirement))}
  {@const booking = text(formatBooking(provider.booking))}
  {@const serviceHours = hours(provider.service_hours)}
  {@const cities = Array.isArray(provider.service_area_cities) ? provider.service_area_cities.map(text).filter(Boolean) : []}
  <section class="min-w-0 rounded-lg border border-border bg-background p-3 text-sm text-foreground" aria-label={`Service details for ${name}`} data-provider-details>
    <h3 class="text-base font-semibold break-words">{name}</h3>
    {#if text(provider.routing_type)}<p class="mt-1">{formatRoutingType(provider.routing_type)}</p>{/if}
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
      {#if number}<a class="font-semibold text-primary underline" href={`tel:${number.replace(/[^\d+]/g, '')}`}>Call {number}</a>{/if}
      {#if url}<a class="text-primary underline" href={url} target="_blank" rel="noopener noreferrer">Provider website</a>{/if}
    </div>
    <dl class="mt-3 space-y-3">
      <div><dt class="font-semibold">Eligibility</dt><dd class="whitespace-pre-line break-words">{eligibility || 'Contact the provider to confirm eligibility requirements.'}</dd></div>
      {#if fare}<div><dt class="font-semibold">Fare</dt><dd>{fare}</dd>{#if membershipBillingNotice(provider.fare)}<dd data-membership-notice>{membershipBillingNotice(provider.fare)}</dd>{/if}</div>{/if}
      {#if booking}<div><dt class="font-semibold">How to book</dt><dd class="whitespace-pre-line break-words">{booking}</dd></div>{/if}
      <div><dt class="font-semibold">Service hours</dt><dd>{serviceHours.length ? serviceHours.join('; ') : 'Contact the provider to confirm service hours.'}</dd></div>
      {#if cities.length}<div><dt class="font-semibold">Service area</dt><dd class="break-words">{cities.join(', ')}</dd></div>{/if}
    </dl>
    <ProviderTimeline provider={timelineEntry(provider)} />
    {#if Array.isArray(provider.contacts)}
      {#each provider.contacts as contact}
        {@const person = record(contact)}
        {@const address = email(person.email)}
        {#if address}<p class="mt-3 break-words">{text(person.name) ? `${text(person.name)}: ` : ''}<a class="text-primary underline" href={`mailto:${address}`}>{address}</a></p>{/if}
      {/each}
    {/if}
  </section>
{:else}
  <p class="text-sm text-foreground">Service details are unavailable. Please contact the provider for more information.</p>
{/each}
