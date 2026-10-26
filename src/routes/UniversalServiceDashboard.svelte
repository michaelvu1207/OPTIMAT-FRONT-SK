<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import PageShell from '$lib/components/PageShell.svelte';
  import TripRouteMap from '../components/TripRouteMap.svelte';
  import { providerPortalNavItems } from '$lib/providerPortalNav';
  import { restorePortalToken } from '$lib/portalToken';
  import { getOperations, type OperationsResult, type OperationsMode, type OperationsFilters } from '$lib/operationsApi';

  let data: OperationsResult | null = null;
  let providerOptions: OperationsResult['imports'] = [];
  let statusOptions: string[] = [];
  let loading = true;
  let error = '';
  let provider = '';
  let dateFrom = '';
  let dateTo = '';
  let status = '';
  let hourFrom = '0';
  let hourTo = '24';
  let mode: OperationsMode = 'combined';
  let offset = 0;
  let applied: OperationsFilters = { mode: 'combined', hour_from: '0', hour_to: '24' };
  let controller: AbortController | null = null;
  let requestId = 0;
  let focusedCity = '';
  const count = (value: number) => value.toLocaleString('en-US');
  const clock = (value: string | null) => value?.slice(0, 5) ?? 'Unknown time';
  const modes: { value: OperationsMode; label: string }[] = [
    { value: 'combined', label: 'Both' }, { value: 'origins', label: 'Origins' }, { value: 'destinations', label: 'Destinations' }
  ];

  onMount(() => {
    restorePortalToken();
    void load();
  });
  onDestroy(() => { requestId += 1; controller?.abort(); });

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const current = ++requestId;
    loading = true;
    error = '';
    data = null;
    const result = await getOperations({ ...applied, offset: String(offset) }, controller.signal);
    if (current !== requestId) return;
    loading = false;
    if (result.error || !result.data) {
      error = result.error?.message ?? 'The server returned no operational data.';
      return;
    }
    data = result.data;
    if (!applied.provider_id) providerOptions = data.imports;
    statusOptions = data.statuses;
    focusedCity = '';
  }

  function applyFilters() {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      error = 'Start date must not follow end date.';
      return;
    }
    if (Number(hourFrom) >= Number(hourTo)) {
      error = 'End hour must follow start hour. Use two selections for an overnight window.';
      return;
    }
    offset = 0;
    applied = { provider_id: provider, date_from: dateFrom, date_to: dateTo, status,
      hour_from: hourFrom, hour_to: hourTo, mode };
    void load();
  }

  function setMode(value: OperationsMode) {
    mode = value;
    applyFilters();
  }

  function changePage(direction: number) {
    offset = Math.max(0, offset + direction * 50);
    void load();
  }

  $: points = data?.heat_points ?? [];
  // Fixed logarithmic scale across filters; totals remain visible in the area list.
  $: heatPoints = points.map(point => ({
    latLng: [point.lat, point.lng],
    radius: Math.min(38, 7 + 4 * Math.log2(1 + point.count)),
    fillColor: applied.mode === 'origins' ? '#2563eb' : applied.mode === 'destinations' ? '#ea580c' : '#7c3aed',
    fillOpacity: 0.6
  }));
  $: focus = points.find(point => point.city === focusedCity);
  $: center = focus ? [focus.lat, focus.lng] : points.length
    ? [points.reduce((sum, point) => sum + point.lat, 0) / points.length,
       points.reduce((sum, point) => sum + point.lng, 0) / points.length]
    : [37.96, -122.03];
  $: hours = Array.from({ length: 24 }, (_, hour) => ({
    hour, count: data?.hourly.find(item => item.hour === hour)?.count ?? 0
  }));
  $: maxHour = Math.max(1, ...hours.map(item => item.count));
  $: displayedWindow = `${String(applied.hour_from ?? '0').padStart(2, '0')}:00–${String(applied.hour_to ?? '24').padStart(2, '0')}:00`;
</script>

<PageShell title="Universal Service Dashboard" description="LINK operational records · City-level pickup and drop-off activity" appMode={true} navItems={providerPortalNavItems}>
  <div class="operations">
    <section class="visuals" aria-label="Demand map and service summary">
      <div class="map-panel">
        {#if data && points.length}
          <TripRouteMap mapKey={`operations-${requestId}-${focusedCity}`} {center} zoom={focus ? 11 : 10} overlayMode="heat" {heatPoints} />
          <div class="map-caption">
            <strong>City-level activity</strong>
            <span>{count(data.event_summary.mapped)} mapped endpoint events · {points.length} areas</span>
          </div>
        {:else}
          <div class="map-empty">
            <strong>{loading ? 'Loading LINK records…' : error ? 'Operational data unavailable' : 'No mapped events'}</strong>
            <p>{error ? 'Resolve the message in the filter panel and refresh.' : 'The map displays only events with a resolved city reference point.'}</p>
          </div>
        {/if}
      </div>
      <div class="summary">
        <div class="section-heading"><h2>Service summary</h2><span>{data?.summary.date_from ?? '—'} to {data?.summary.date_to ?? '—'}</span></div>
        <p class="note">Displayed: {displayedWindow} America/Los_Angeles · Status {applied.status || 'all raw codes'} · {applied.mode ?? 'combined'}</p>
        <div class="metrics">
          <div><span>Trip records</span><strong>{data ? count(data.summary.records) : '—'}</strong></div>
          <div><span>Anonymous riders</span><strong>{data ? count(data.summary.riders) : '—'}</strong></div>
          <div><span>Mapped endpoint events</span><strong>{data ? count(data.event_summary.mapped) : '—'}</strong></div>
          <div><span>Unmapped endpoint events</span><strong>{data ? count(data.event_summary.unmapped) : '—'}</strong></div>
        </div>
        <p class="note">Circles use Census place reference points, not passenger addresses. Destination cities are inferred only from an unambiguous address and ZIP match within LINK. Both mode counts two endpoints when both are available.</p>
        <div class="section-heading"><h2>Events by hour</h2><span>Pickup departure / drop-off arrival</span></div>
        <div class="hours" aria-label="Endpoint events by local hour">
          {#each hours as item}
            <div class="hour" title={`${item.hour}:00 — ${count(item.count)} events`}>
              <div class="bar-space"><div class="bar" style:height={`${100 * item.count / maxHour}%`}></div></div>
              <span>{String(item.hour).padStart(2, '0')}</span>
            </div>
          {/each}
        </div>
        <p class="note">{data ? count(data.event_summary.missing_time) : '—'} displayed events have no time. Full-day views include these events; narrower time windows exclude them.</p>
      </div>
    </section>

    <aside class="details">
      <div class="toolbar"><div><h1>LINK operating data</h1><p>Historical records from the supplied workbook</p></div>
        <button type="button" onclick={() => load()} disabled={loading}>Refresh</button>
      </div>
      <form onsubmit={(event) => { event.preventDefault(); applyFilters(); }} class="filters">
        <label>Provider<select bind:value={provider}><option value="">All authorized providers</option>
          {#each providerOptions as item}<option value={String(item.provider_id)}>{item.provider_name}</option>{/each}
        </select></label>
        <div class="two-columns">
          <label>Start date<input type="date" bind:value={dateFrom} /></label>
          <label>End date<input type="date" bind:value={dateTo} /></label>
        </div>
        <div class="two-columns">
          <label>From hour<select bind:value={hourFrom}>{#each Array.from({ length: 24 }, (_, i) => i) as hour}<option value={String(hour)}>{String(hour).padStart(2, '0')}:00</option>{/each}</select></label>
          <label>Until hour<select bind:value={hourTo}>{#each Array.from({ length: 24 }, (_, i) => i + 1) as hour}<option value={String(hour)}>{String(hour).padStart(2, '0')}:00</option>{/each}</select></label>
        </div>
        <label>Source status<select bind:value={status}><option value="">All raw status codes</option>
          {#each statusOptions as code}<option value={code}>{code}</option>{/each}
        </select></label>
        <p class="note">Status meanings are not assumed. These totals describe source records, not verified completed rides.</p>
        <div class="layers" aria-label="Map layer">{#each modes as item}
          <button type="button" aria-pressed={mode === item.value} class:active={mode === item.value} onclick={() => setMode(item.value)} disabled={loading}>{item.label}</button>
        {/each}</div>
        <button class="primary" type="submit" disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</button>
      </form>
      {#if error}<div class="error" role="alert">{error} <a href="#/provider-portal">My account / Sign in</a></div>{/if}
      {#if data && !data.imports.length}
        <div class="empty">No active operational import is available for your authorized providers. An administrator must import LINK and assign provider access.</div>
      {/if}
      {#if data}
        <div class="source">
          {#each data.imports as item}
            <strong>{item.filename}</strong><span>{item.date_from} to {item.date_to} · {count(item.row_count)} source records</span>
          {/each}
        </div>
        <section class="areas"><h2>Area activity</h2>
          {#each points as point}
            <button type="button" class:focused={focusedCity === point.city} onclick={() => { focusedCity = focusedCity === point.city ? '' : point.city; }}><span>{point.city}</span><strong>{count(point.count)} events</strong></button>
          {/each}
          {#if !points.length}<p class="note">No mapped areas match this selection.</p>{/if}
        </section>
        <section class="records">
          <div class="section-heading"><h2>Trip records</h2><span>{count(data.summary.records)} matching</span></div>
          <div class="pagination">
            <button type="button" onclick={() => changePage(-1)} disabled={loading || offset === 0}>Previous</button>
            <span>{data.summary.records ? offset + 1 : 0}–{Math.min(offset + data.trips.length, data.summary.records)}</span>
            <button type="button" onclick={() => changePage(1)} disabled={loading || offset + 50 >= data.summary.records}>Next</button>
          </div>
          {#each data.trips as trip (trip.id)}
            <article class="trip">
              <div><strong>{trip.provider_name}</strong><span>{trip.date}</span></div>
              <p>{trip.origin_city ?? 'Unknown city'} → {trip.destination_city ?? 'Unknown city'}</p>
              <p>{clock(trip.pickup_time)} → {clock(trip.dropoff_time)} · Status {trip.status ?? 'unknown'}</p>
              <small>Source row {trip.source_row} · {trip.origin_mapped && trip.destination_mapped ? 'Both cities mapped' : 'Partial or unavailable city mapping'}</small>
            </article>
          {/each}
          {#if !data.trips.length}<p class="empty">No trip records match these filters.</p>{/if}
        </section>
      {/if}
    </aside>
  </div>
</PageShell>

<style>
  .operations { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(340px,1fr); height:100%; min-height:0; overflow:hidden; background:#f8fafc; color:#0f172a; }
  .visuals { display:flex; flex-direction:column; min-height:0; overflow:auto; border-right:1px solid #dbe3ef; }
  .map-panel { position:relative; height:48vh; min-height:300px; flex-shrink:0; overflow:hidden; background:#e8eef2; }
  .map-caption { position:absolute; left:16px; top:16px; z-index:500; background:#fffffff2; padding:12px 16px; border-radius:10px; box-shadow:0 2px 10px #0001; display:grid; gap:4px; font-size:13px; }
  .map-empty { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; text-align:center; }
  .summary { padding:20px; }
  .section-heading { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:10px; }
  h1,h2,p { margin:0; }
  h1 { font-size:17px; font-weight:650; }
  h2 { font-size:14px; font-weight:650; }
  .section-heading span,.toolbar p { color:#64748b; font-size:12px; }
  .metrics { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:14px 0; }
  .metrics>div { background:white; border:1px solid #e2e8f0; border-radius:10px; padding:16px; display:grid; gap:8px; }
  .metrics span { font-size:12px; color:#64748b; }
  .metrics strong { font-size:25px; }
  .note { font-size:12px; line-height:1.6; color:#64748b; margin:8px 0 16px; }
  .details { overflow:auto; background:white; min-height:0; }
  .toolbar { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:20px; border-bottom:1px solid #e2e8f0; }
  .filters,.source,.areas,.records { padding:18px 20px; border-bottom:1px solid #e2e8f0; }
  .filters { display:grid; gap:12px; }
  label { display:grid; gap:6px; font-size:13px; color:#475569; }
  input,select { min-width:0; width:100%; border:1px solid #cbd5e1; border-radius:7px; padding:9px; color:#0f172a; background:white; }
  .two-columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  button { border:1px solid #cbd5e1; padding:8px 12px; border-radius:7px; background:white; cursor:pointer; font-size:13px; }
  button:hover { background:#f1f5f9; }
  button:disabled { opacity:0.5; cursor:default; }
  .primary,.layers .active { background:#0f172a; color:white; border-color:#0f172a; }
  .primary:hover { background:#1e293b; }
  .layers { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
  .error,.empty { padding:18px; font-size:13px; line-height:1.6; }
  .error { background:#fef2f2; color:#991b1b; }
  .error a { text-decoration:underline; display:block; }
  .source { display:grid; gap:4px; font-size:12px; color:#64748b; }
  .source strong { color:#334155; }
  .areas { max-height:250px; overflow:auto; }
  .areas button { display:flex; justify-content:space-between; width:100%; margin-top:8px; text-align:left; gap:8px; font-size:12px; }
  .areas .focused { border-color:#7c3aed; background:#f5f3ff; }
  .pagination { display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-bottom:12px; }
  .trip { border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom:10px; }
  .trip>div { display:flex; justify-content:space-between; gap:8px; font-size:12px; }
  .trip p { font-size:13px; margin-top:6px; }
  .trip small { color:#64748b; font-size:11px; }
  .hours { display:flex; gap:3px; height:104px; align-items:flex-end; }
  .hour { flex:1; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; font-size:9px; text-align:center; color:#64748b; }
  .bar-space { height:85px; display:flex; align-items:flex-end; justify-content:center; }
  .bar { width:85%; background:#7c3aed; border-radius:3px 3px 0 0; }
  @media(max-width:850px) { .operations { display:block; overflow:auto; } .visuals,.details { overflow:visible; } .map-panel { height:40vh; } }
</style>
