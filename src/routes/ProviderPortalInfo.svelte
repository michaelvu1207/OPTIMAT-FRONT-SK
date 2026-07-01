<script lang="ts">
  // @ts-nocheck
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import PageShell from '$lib/components/PageShell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { getProvider, updateProvider, type Provider, type ProviderUpdate } from '$lib/api';
  import providerSession, { clearProvider, setProvider } from '$lib/stores/providerSession';
  import mockDataEnabled from '$lib/stores/mockData';
  import { providerPortalNavItems } from '$lib/providerPortalNav';
  import BookingEditor from '$lib/components/providers/BookingEditor.svelte';
  import FareEditor from '$lib/components/providers/FareEditor.svelte';
  import ScheduleTypeEditor from '$lib/components/providers/ScheduleTypeEditor.svelte';
  import ServiceZoneEditor from '$lib/components/providers/ServiceZoneEditor.svelte';
  import {
    PROVIDER_TYPE_OPTIONS,
    ROUTING_TYPE_OPTIONS,
    formatBooking,
    formatEligibilityReqs,
    formatFare,
    formatRoutingType,
    formatScheduleType,
    formatServiceAreaSummary,
    tryParseJson,
  } from '$lib/providers/providerFields';

  type ProviderDraft = ProviderUpdate & {
    provider_name: string;
  };

  const SERVICE_AREA_SOURCE_OPTIONS = [
    { value: '', label: '-' },
    { value: 'custom_geojson', label: 'Custom mapped service area' },
    { value: 'city_list', label: 'City boundary service area' },
    { value: 'existing_preserved', label: 'Existing mapped service area' },
    { value: 'manual', label: 'Manually curated service area' },
    { value: 'unresolved', label: 'Service area needs review' },
  ];

  $: provider = $providerSession.provider as Provider | null;
  $: mockEnabled = $mockDataEnabled;

  let editMode = false;
  let saving = false;
  let loadingFresh = false;
  let saveError: string | null = null;
  let saveSuccess: string | null = null;
  let form: ProviderDraft | null = null;
  let serviceAreaCitiesText = '';
  let serviceHoursRaw = '';

  function logout() {
    clearProvider();
    push('/provider-portal');
  }

  function toggleMockData() {
    mockDataEnabled.update((value) => !value);
  }

  function goToLogin() {
    push('/provider-portal');
  }

  function formatText(value: unknown) {
    const text = String(value ?? '').trim();
    return text || '-';
  }

  function formatBoolean(value: unknown) {
    if (value === true) return 'Yes';
    if (value === false) return 'No';
    return '-';
  }

  function cloneValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  function stringifyJson(value: unknown) {
    if (value === null || value === undefined || value === '') return '';
    const parsed = tryParseJson(value);
    if (typeof parsed === 'string') return parsed;
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(value);
    }
  }

  function stringifyEligibility(value: unknown) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return stringifyJson(value);
  }

  function createDraft(input: Provider): ProviderDraft {
    serviceAreaCitiesText = Array.isArray(input.service_area_cities)
      ? input.service_area_cities.join('\n')
      : '';
    serviceHoursRaw = stringifyJson(input.service_hours);

    return {
      provider_name: input.provider_name || '',
      provider_type: input.provider_type || '',
      routing_type: input.routing_type || '',
      planning_type: input.planning_type || '',
      schedule_type: cloneValue(input.schedule_type ?? null),
      eligibility_reqs: stringifyEligibility(input.eligibility_reqs),
      booking: cloneValue(input.booking ?? null),
      fare: cloneValue(input.fare ?? null),
      service_hours: cloneValue(input.service_hours ?? null),
      service_zone: cloneValue(input.service_zone ?? null),
      service_area_cities: cloneValue(input.service_area_cities ?? []),
      service_area_source: input.service_area_source || '',
      service_area_notes: input.service_area_notes || '',
      provider_software: input.provider_software || '',
      website: input.website || '',
      provider_org: input.provider_org || '',
      round_trip_booking: input.round_trip_booking ?? null,
      investigated: input.investigated ?? null,
    };
  }

  function enterEditMode() {
    if (!provider) return;
    form = createDraft(provider);
    editMode = true;
    saveError = null;
    saveSuccess = null;
  }

  function cancelEditMode() {
    editMode = false;
    form = null;
    serviceAreaCitiesText = '';
    serviceHoursRaw = '';
    saveError = null;
  }

  function parseCities(value: string): string[] {
    return value
      .split(/[,\n]/)
      .map((city) => city.trim())
      .filter(Boolean);
  }

  function parseJsonish(label: string, value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return trimmed;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${label} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function providerIdentifier(input: Provider) {
    return input.provider_id ?? null;
  }

  async function refreshProvider() {
    if (!provider) return;
    const id = providerIdentifier(provider);
    if (!id) return;
    loadingFresh = true;
    try {
      const { data, error } = await getProvider(id);
      if (error) throw error;
      if (data) setProvider(data);
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      loadingFresh = false;
    }
  }

  async function saveProvider() {
    if (!provider || !form) return;
    const id = providerIdentifier(provider);
    if (!id) {
      saveError = 'This provider does not have a numeric provider_id, so it cannot be saved through the provider portal yet.';
      return;
    }

    saving = true;
    saveError = null;
    saveSuccess = null;

    try {
      const payload: ProviderUpdate = {
        ...form,
        service_area_cities: parseCities(serviceAreaCitiesText),
        service_hours: parseJsonish('Service hours', serviceHoursRaw),
      };

      const { data, error } = await updateProvider(id, payload);
      if (error) throw error;
      if (!data) throw new Error('No provider was returned after saving.');

      setProvider(data);
      form = createDraft(data);
      editMode = false;
      saveSuccess = 'Provider profile saved.';
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function setBooleanField(field: 'round_trip_booking' | 'investigated', value: string) {
    if (!form) return;
    form[field] = value === '' ? null : value === 'true';
  }

  async function importFile(event: Event, field: string, mode: 'json' | 'text' | 'cities') {
    if (!form) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      if (mode === 'cities') {
        const parsed = parseJsonish('Service area cities', text);
        if (Array.isArray(parsed)) {
          serviceAreaCitiesText = parsed.map((city) => String(city).trim()).filter(Boolean).join('\n');
        } else {
          serviceAreaCitiesText = text;
        }
      } else if (mode === 'json') {
        form[field] = parseJsonish(field, text);
        if (field === 'service_hours') {
          serviceHoursRaw = stringifyJson(form[field]);
        }
      } else {
        form[field] = text;
      }
      saveError = null;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      input.value = '';
    }
  }
</script>

<PageShell appMode={true} navItems={providerPortalNavItems}>
  <div slot="header-actions" class="flex items-center gap-2 text-xs text-muted-foreground">
    {#if provider}
      <span><span class="text-foreground font-medium">Provider View:</span> {provider.provider_name}</span>
      <Button variant="outline" size="sm" onclick={logout}>Sign out</Button>
    {:else}
      <span>Public View</span>
    {/if}
    <Button variant="outline" size="sm" onclick={toggleMockData}>
      {mockEnabled ? 'Mock Data: On' : 'Mock Data: Off'}
    </Button>
  </div>

  <div class="flex-1 overflow-auto p-6">
    {#if !provider}
      <div class="max-w-xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-6" in:fade={{ duration: 200 }}>
        <h2 class="text-lg font-semibold text-slate-900">Sign in to view provider info</h2>
        <p class="text-sm text-slate-600 mt-2">Your provider profile is available after you sign in.</p>
        <Button class="mt-4" onclick={goToLogin}>Go to Provider Portal</Button>
      </div>
    {:else}
      <div class="max-w-5xl mx-auto">
        <div class="bg-white rounded-xl shadow-lg border border-slate-200">
          <div class="px-6 py-4 border-b border-slate-200 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 class="text-xl font-bold text-slate-900">{provider.provider_name}</h1>
              <p class="text-sm text-slate-600">Provider ID: {provider.provider_id || provider.id}</p>
            </div>

            <div class="flex flex-wrap gap-2">
              {#if editMode}
                <Button variant="outline" size="sm" onclick={cancelEditMode} disabled={saving}>Cancel</Button>
                <Button size="sm" onclick={saveProvider} disabled={saving || !form?.provider_name?.trim()}>
                  {saving ? 'Saving...' : 'Save changes'}
                </Button>
              {:else}
                <Button variant="outline" size="sm" onclick={refreshProvider} disabled={loadingFresh}>
                  {loadingFresh ? 'Refreshing...' : 'Refresh'}
                </Button>
                <Button size="sm" onclick={enterEditMode}>Edit profile</Button>
              {/if}
            </div>
          </div>

          {#if saveError}
            <div class="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" transition:fade>
              {saveError}
            </div>
          {/if}

          {#if saveSuccess}
            <div class="mx-6 mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" transition:fade>
              {saveSuccess}
            </div>
          {/if}

          <div class="p-6">
            {#if editMode && form}
              <div class="grid gap-6">
                <section class="grid gap-4 rounded-lg border border-slate-200 p-4">
                  <h2 class="text-sm font-semibold text-slate-900">Core profile</h2>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="md:col-span-2">
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="provider-name">Provider name</label>
                      <Input id="provider-name" bind:value={form.provider_name} />
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="provider-type">Service category</label>
                      <select
                        id="provider-type"
                        class="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        bind:value={form.provider_type}
                      >
                        <option value="">-</option>
                        {#each PROVIDER_TYPE_OPTIONS as option}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="routing-type">Service style</label>
                      <select
                        id="routing-type"
                        class="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        bind:value={form.routing_type}
                      >
                        {#each ROUTING_TYPE_OPTIONS as option}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="planning-type">Planning type</label>
                      <Input id="planning-type" bind:value={form.planning_type} />
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="provider-org">Provider organization</label>
                      <Input id="provider-org" bind:value={form.provider_org} />
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="website">Website</label>
                      <Input id="website" bind:value={form.website} placeholder="https://..." />
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="provider-software">Provider software</label>
                      <Input id="provider-software" bind:value={form.provider_software} />
                    </div>
                  </div>
                </section>

                <section class="grid gap-4 rounded-lg border border-slate-200 p-4">
                  <h2 class="text-sm font-semibold text-slate-900">Schedule, eligibility, booking, and fare</h2>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <div class="block text-sm font-medium text-slate-700">Schedule</div>
                      <label class="text-xs text-slate-500">
                        Import JSON
                        <input class="ml-2 text-xs" type="file" accept=".json,application/json,text/plain" onchange={(event) => importFile(event, 'schedule_type', 'json')} />
                      </label>
                    </div>
                    <ScheduleTypeEditor bind:value={form.schedule_type} />
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <div class="block text-sm font-medium text-slate-700">Eligibility requirements</div>
                      <label class="text-xs text-slate-500">
                        Import text
                        <input class="ml-2 text-xs" type="file" accept=".txt,.md,.csv,text/plain,text/csv" onchange={(event) => importFile(event, 'eligibility_reqs', 'text')} />
                      </label>
                    </div>
                    <Textarea
                      bind:value={form.eligibility_reqs}
                      rows={4}
                      placeholder="Plain English eligibility and proof/application requirements from the provider row"
                    />
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <div class="block text-sm font-medium text-slate-700">Booking</div>
                      <label class="text-xs text-slate-500">
                        Import JSON/text
                        <input class="ml-2 text-xs" type="file" accept=".json,.txt,application/json,text/plain" onchange={(event) => importFile(event, 'booking', 'json')} />
                      </label>
                    </div>
                    <BookingEditor bind:value={form.booking} />
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <div class="block text-sm font-medium text-slate-700">Fare</div>
                      <label class="text-xs text-slate-500">
                        Import JSON/text
                        <input class="ml-2 text-xs" type="file" accept=".json,.txt,application/json,text/plain" onchange={(event) => importFile(event, 'fare', 'json')} />
                      </label>
                    </div>
                    <FareEditor bind:value={form.fare} />
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <label class="block text-sm font-medium text-slate-700" for="service-hours">Service hours</label>
                      <label class="text-xs text-slate-500">
                        Import JSON/text
                        <input class="ml-2 text-xs" type="file" accept=".json,.txt,application/json,text/plain" onchange={(event) => importFile(event, 'service_hours', 'json')} />
                      </label>
                    </div>
                    <Textarea id="service-hours" bind:value={serviceHoursRaw} rows={5} class="font-mono text-sm" />
                  </div>
                </section>

                <section class="grid gap-4 rounded-lg border border-slate-200 p-4">
                  <h2 class="text-sm font-semibold text-slate-900">Service area</h2>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="service-area-source">Service area source</label>
                      <select
                        id="service-area-source"
                        class="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        bind:value={form.service_area_source}
                      >
                        {#each SERVICE_AREA_SOURCE_OPTIONS as option}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="round-trip-booking">Round trip booking</label>
                      <select
                        id="round-trip-booking"
                        class="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        value={form.round_trip_booking === null ? '' : String(form.round_trip_booking)}
                        onchange={(event) => setBooleanField('round_trip_booking', (event.target as HTMLSelectElement).value)}
                      >
                        <option value="">-</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <div class="mb-2 flex items-center justify-between gap-3">
                      <label class="block text-sm font-medium text-slate-700" for="service-area-cities">Service area cities</label>
                      <label class="text-xs text-slate-500">
                        Import list/JSON
                        <input class="ml-2 text-xs" type="file" accept=".json,.csv,.txt,application/json,text/plain,text/csv" onchange={(event) => importFile(event, 'service_area_cities', 'cities')} />
                      </label>
                    </div>
                    <Textarea id="service-area-cities" bind:value={serviceAreaCitiesText} rows={4} placeholder="One city per line, or comma-separated" />
                  </div>

                  <div>
                    <label class="block text-sm font-medium text-slate-700 mb-2" for="service-area-notes">Service area notes</label>
                    <Textarea id="service-area-notes" bind:value={form.service_area_notes} rows={3} />
                  </div>

                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Service zone GeoJSON</div>
                    <ServiceZoneEditor bind:value={form.service_zone} />
                  </div>
                </section>

                <section class="grid gap-4 rounded-lg border border-slate-200 p-4">
                  <h2 class="text-sm font-semibold text-slate-900">Review metadata</h2>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label class="block text-sm font-medium text-slate-700 mb-2" for="investigated">Investigated</label>
                      <select
                        id="investigated"
                        class="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        value={form.investigated === null ? '' : String(form.investigated)}
                        onchange={(event) => setBooleanField('investigated', (event.target as HTMLSelectElement).value)}
                      >
                        <option value="">-</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    </div>

                    <div>
                      <div class="block text-sm font-medium text-slate-700 mb-2">Read-only IDs</div>
                      <div class="text-sm text-slate-700 bg-slate-50 rounded-md px-3 py-2">
                        provider_id: {provider.provider_id || '-'} · row id: {provider.id || '-'}
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            {:else}
              <div class="grid gap-6">
                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Provider name</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">{provider.provider_name || '-'}</div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Service category</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">{formatText(provider.provider_type)}</div>
                  </div>

                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Service style</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">{formatRoutingType(provider.routing_type) || '-'}</div>
                  </div>
                </div>

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Schedule</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">
                    {formatScheduleType(provider.schedule_type) || '-'}
                  </div>
                </div>

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Eligibility</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2 text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {formatEligibilityReqs(provider.eligibility_reqs) || '-'}
                  </div>
                </div>

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Booking</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2 text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {formatBooking(provider.booking) || '-'}
                  </div>
                </div>

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Fare</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2 text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {formatFare(provider.fare) || '-'}
                  </div>
                </div>

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Service area</div>
                  <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {formatServiceAreaSummary(provider) || '-'}
                  </div>
                </div>

                {#if provider.service_area_notes}
                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Service area notes</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
                      {provider.service_area_notes}
                    </div>
                  </div>
                {/if}

                <div>
                  <div class="block text-sm font-medium text-slate-700 mb-2">Website</div>
                  {#if provider.website}
                    <a
                      href={provider.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-primary hover:underline bg-slate-50 rounded-md px-3 py-2 block break-all"
                    >
                      {provider.website}
                    </a>
                  {:else}
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">-</div>
                  {/if}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Round trip booking</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">
                      {formatBoolean(provider.round_trip_booking)}
                    </div>
                  </div>

                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Investigated</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">
                      {formatBoolean(provider.investigated)}
                    </div>
                  </div>

                  <div>
                    <div class="block text-sm font-medium text-slate-700 mb-2">Provider software</div>
                    <div class="text-slate-900 bg-slate-50 rounded-md px-3 py-2">
                      {formatText(provider.provider_software)}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</PageShell>

<style>
  :global(.font-mono) {
    scrollbar-width: thin;
    scrollbar-color: #cbd5e1 transparent;
  }
</style>
