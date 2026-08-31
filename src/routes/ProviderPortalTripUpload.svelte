<script lang="ts">
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import PageShell from '$lib/components/PageShell.svelte';
  import { Button } from '$lib/components/ui/button';
  import { uploadTripRecords } from '$lib/api';
  import providerSession from '$lib/stores/providerSession';
  import mockDataEnabled from '$lib/stores/mockData';
  import { providerPortalNavItems } from '$lib/providerPortalNav';

  let selectedFile: File | null = null;
  let isDragging = false;
  let uploading = false;
  let uploadError: string | null = null;
  let uploadSuccess: string | null = null;

  $: provider = $providerSession.provider;
  $: mockEnabled = $mockDataEnabled;
  $: providerId = (() => {
    if (!provider?.provider_id) return null;
    const parsed = Number(provider.provider_id);
    return Number.isNaN(parsed) ? null : parsed;
  })();

  function handleFileChange(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] || null;
    selectedFile = file;
    uploadError = null;
    uploadSuccess = null;
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragging = false;
    const file = event.dataTransfer?.files?.[0] || null;
    selectedFile = file;
    uploadError = null;
    uploadSuccess = null;
  }

  function formatFileSize(bytes: number) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
  }

  async function uploadRecords() {
    if (!selectedFile || !providerId) return;

    uploading = true;
    uploadError = null;
    uploadSuccess = null;

    try {
      const recordsText = await selectedFile.text();
      const { data, error } = await uploadTripRecords({
        records: recordsText,
        providerId,
        filename: selectedFile.name,
      });

      if (error) throw error;

      const rowCount = data?.row_count ?? 0;
      uploadSuccess = `Upload received. ${rowCount} data rows were saved for processing.`;
    } catch (err) {
      uploadError = err instanceof Error ? err.message : String(err);
    } finally {
      uploading = false;
    }
  }

  function goToLogin() {
    push('/provider-portal');
  }

  function toggleMockData() {
    mockDataEnabled.update((value) => !value);
  }
</script>

<PageShell appMode={true} navItems={providerPortalNavItems}>
  <div slot="header-actions" class="flex items-center gap-2 text-xs text-muted-foreground">
    {#if provider}
      <span><span class="text-foreground font-medium">Provider View:</span> {provider.provider_name}</span>
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
        <h2 class="text-lg font-semibold text-slate-900">Sign in to upload trip records</h2>
        <p class="text-sm text-slate-600 mt-2">Uploads are tied to your provider account.</p>
        <Button class="mt-4" onclick={goToLogin}>Go to Provider Portal</Button>
      </div>
    {:else}
      <div class="max-w-3xl mx-auto bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        <h1 class="text-xl font-bold text-slate-900">Trip Upload</h1>
        <p class="text-sm text-slate-600 mt-1">Upload trip data for {provider.provider_name}. Files are stored securely for processing.</p>

        <div
          class={`mt-6 border-2 border-dashed rounded-xl p-6 text-center transition ${
            isDragging ? 'border-primary bg-primary/5' : 'border-slate-200'
          }`}
          role="button"
          tabindex="0"
          on:dragover|preventDefault={() => { isDragging = true; }}
          on:dragleave={() => { isDragging = false; }}
          on:drop={handleDrop}
        >
          <input
            id="trip-upload"
            type="file"
            accept=".csv,text/csv"
            class="hidden"
            on:change={handleFileChange}
          />
          <label for="trip-upload" class="cursor-pointer">
            <div class="text-sm font-medium text-slate-900">Drop your trip data file here or click to browse</div>
            <div class="text-xs text-slate-500 mt-1">File must be in .csv format.</div>
          </label>

          {#if selectedFile}
            <div class="mt-4 text-sm text-slate-700">
              <div class="font-medium">{selectedFile.name}</div>
              <div class="text-xs text-slate-500">{formatFileSize(selectedFile.size)}</div>
            </div>
          {/if}
        </div>

        {#if uploadError}
          <div class="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {uploadError}
          </div>
        {/if}
        {#if uploadSuccess}
          <div class="mt-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {uploadSuccess}
          </div>
        {/if}

        <div class="mt-6 flex items-center justify-between flex-wrap gap-3">
          <div class="text-xs text-slate-500">
            Expected headers: no_pk, no_dp, trip_id, pick_time, addr_pk, drop_time, addr_dp, no_return, psg_on_brd, trip_id_return,
            outgo_dura, google_maps_route, google_route_distance_m, google_route_duration_s, google_route_summary.
          </div>
          <Button onclick={uploadRecords} disabled={!selectedFile || uploading}>
            {#if uploading}
              Uploading…
            {:else}
              Upload Trip Data
            {/if}
          </Button>
        </div>
      </div>
    {/if}
  </div>
</PageShell>
