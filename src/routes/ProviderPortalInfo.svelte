<script lang="ts">
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import PageShell from '$lib/components/PageShell.svelte';
  import { Button } from '$lib/components/ui/button';
  import type { Provider } from '$lib/api';
  import providerSession, { clearProvider } from '$lib/stores/providerSession';
  import mockDataEnabled from '$lib/stores/mockData';
  import { providerPortalNavItems } from '$lib/providerPortalNav';
  import {
    formatBooking,
    formatEligibilityReqs,
    formatFare,
    formatRoutingType,
    formatScheduleType,
    formatServiceAreaSummary,
  } from '$lib/providers/providerFields';

  $: provider = $providerSession.provider as Provider | null;
  $: mockEnabled = $mockDataEnabled;

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
      <div class="max-w-4xl mx-auto">
        <div class="bg-white rounded-xl shadow-lg border border-slate-200">
          <div class="px-6 py-4 border-b border-slate-200">
            <h1 class="text-xl font-bold text-slate-900">{provider.provider_name}</h1>
            <p class="text-sm text-slate-600">Provider ID: {provider.provider_id || provider.id}</p>
          </div>

          <div class="p-6">
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
