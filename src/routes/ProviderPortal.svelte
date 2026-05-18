<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import PageShell from '$lib/components/PageShell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { getAllProviders, type Provider } from '$lib/api';
  import providerSession, { setProvider } from '$lib/stores/providerSession';
  import mockDataEnabled from '$lib/stores/mockData';
  import { providerPortalNavItems } from '$lib/providerPortalNav';

  let mounted = false;
  let selectedProviderKey = '';
  let lookupLoading = false;
  let lookupError: string | null = null;

  let providers: Provider[] = [];
  let optionsLoading = false;
  let optionsError: string | null = null;
  let providerOptions: Array<{ value: string; providerName: string }> = [];
  $: currentProvider = $providerSession.provider;
  $: mockEnabled = $mockDataEnabled;

  onMount(async () => {
    mounted = true;
    await loadProviders();
  });

  $: if (mounted && currentProvider) {
    push('/provider-portal/info');
  }

  async function loadProviders() {
    optionsLoading = true;
    optionsError = null;
    try {
      const { data, error } = await getAllProviders();
      if (error) throw error;
      providers = data || [];
      providerOptions = buildProviderOptions(providers);
    } catch (err) {
      optionsError = err instanceof Error ? err.message : String(err);
      providers = [];
      providerOptions = [];
    } finally {
      optionsLoading = false;
    }
  }

  function buildProviderOptions(list: Provider[]) {
    const options: Array<{ value: string; providerName: string }> = [];
    for (const provider of list) {
      const value = String(provider.provider_id || provider.id || provider.provider_name);
      options.push({
        value,
        providerName: provider.provider_name
      });
    }
    return options.sort((a, b) => a.providerName.localeCompare(b.providerName));
  }

  async function lookupProvider() {
    if (!selectedProviderKey) {
      lookupError = 'Please select a provider.';
      return;
    }

    lookupLoading = true;
    lookupError = null;

    try {
      let list = providers;
      if (!list.length) {
        const { data, error } = await getAllProviders();
        if (error) throw error;
        list = data || [];
      }

      const foundProvider = list.find((provider) =>
        String(provider.provider_id || provider.id || provider.provider_name) === selectedProviderKey
      ) || null;

      if (!foundProvider) {
        lookupError = 'No provider found. Please refresh the list and try again.';
        return;
      }

      setProvider(foundProvider);
      push('/provider-portal/info');
    } catch (err) {
      lookupError = err instanceof Error ? err.message : String(err);
    } finally {
      lookupLoading = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      lookupProvider();
    }
  }

  function toggleMockData() {
    mockDataEnabled.update((value) => !value);
    selectedProviderKey = '';
  }
</script>

{#if mounted}
  <PageShell appMode={true} navItems={providerPortalNavItems}>
    <div slot="header-actions" class="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Public View</span>
      <Button variant="outline" size="sm" onclick={toggleMockData}>
        {mockEnabled ? 'Mock Data: On' : 'Mock Data: Off'}
      </Button>
    </div>

    <div class="flex-1 flex items-center justify-center p-4" in:fade={{ duration: 300 }}>
      <div class="w-full max-w-md">
        <div class="bg-white rounded-xl shadow-lg border border-slate-200 p-8">
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-primary/10 rounded-full mb-4">
              <svg class="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h1 class="text-2xl font-bold text-slate-900">Provider Portal</h1>
            <p class="text-slate-600 mt-2">Select a provider to view the current public profile.</p>
          </div>

          <div class="space-y-4">
            <div>
              <!-- svelte-ignore a11y_label_has_associated_control -->
              <label class="block text-sm font-medium text-slate-700 mb-2">Provider</label>
              <select
                class="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
                bind:value={selectedProviderKey}
                disabled={optionsLoading || providerOptions.length === 0}
                onkeydown={handleKeydown}
              >
                <option value="">Select a provider…</option>
                {#each providerOptions as option}
                  <option value={option.value}>{option.providerName}</option>
                {/each}
              </select>
              {#if optionsLoading}
                <p class="text-xs text-slate-500 mt-2">Loading providers…</p>
              {:else if optionsError}
                <p class="text-xs text-red-600 mt-2">{optionsError}</p>
              {/if}
            </div>

            {#if lookupError}
              <div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" transition:fade>
                {lookupError}
              </div>
            {/if}

            <Button
              class="w-full"
              onclick={lookupProvider}
              disabled={lookupLoading || !selectedProviderKey}
            >
              {#if lookupLoading}
                <span class="animate-spin mr-2">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </span>
                Looking up…
              {:else}
                Open Provider View
              {/if}
            </Button>
          </div>

          <p class="text-center text-xs text-slate-500 mt-6">
            Provider profile edits are handled through the controlled data update workflow.
          </p>
        </div>
      </div>
    </div>
  </PageShell>
{/if}
