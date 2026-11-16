<script lang="ts">
  import OperationsHistogram from './OperationsHistogram.svelte';
  import type { OperationsResult } from '$lib/operationsApi';
  export let analysis: NonNullable<OperationsResult['record_analysis']>;
  const count = (n: number) => n.toLocaleString('en-US');
  $: peak = Math.max(1, ...analysis.daily.map(d => d.count));
  $: origins = analysis.cities.filter(c => c.kind === 'origins').slice(0, 10);
  $: destinations = analysis.cities.filter(c => c.kind === 'destinations').slice(0, 10);
</script>

<section class="record-analysis" aria-label="Source record activity">
  <header><div><span class="eyebrow">All selected source records</span><h2>Service activity</h2></div><strong>{count(analysis.records)} records</strong></header>
  <p class="note">These charts do not require round-trip pairing. They count source bookings or rides, including the selected raw statuses; they do not establish completed trips or unique riders.</p>
  {#if analysis.records === 0}
    <p class="notice">No source records match these filters.</p>
  {:else}
    <article>
      <h3>Daily records</h3>
      <svg viewBox="0 0 720 190" role="img" aria-label="Source records per service date">
        {#each [0, 0.5, 1] as fraction}
          <line x1="42" x2="710" y1={150-fraction*125} y2={150-fraction*125} stroke="#e2e8f0" />
          <text x="37" y={154-fraction*125} text-anchor="end">{count(Math.round(peak*fraction))}</text>
        {/each}
        {#each analysis.daily as day, i}
          <rect x={44+i*660/analysis.daily.length} y={150-day.count/peak*125} width={Math.max(1,660/analysis.daily.length-1)} height={day.count/peak*125} fill="#0f766e"><title>{day.label}: {count(day.count)} records</title></rect>
        {/each}
        <text x="44" y="174">{analysis.daily[0]?.label}</text><text x="705" y="174" text-anchor="end">{analysis.daily.at(-1)?.label}</text>
      </svg>
      <details><summary>View daily counts</summary><div class="counts">{#each analysis.daily as day}<div><span>{day.label}</span><strong>{count(day.count)}</strong></div>{/each}</div></details>
    </article>
    <div class="chart-grid">
      {#if analysis.departure.n > 0}
        <OperationsHistogram title="Single-trip departure time" description="Actual pickup departure for individual records. No outbound or return role is inferred." chart={analysis.departure} unit="clock" emptyMessage="No actual departure times are supplied." />
      {/if}
      {#if analysis.travel.n > 0}
        <OperationsHistogram title="Single-trip travel time" description="Actual drop-off arrival minus pickup departure. Missing times and reversed sequences are excluded; overnight rollover is not inferred." chart={analysis.travel} unit="minutes" color="#0f766e" emptyMessage="No valid actual travel times are supplied." />
      {/if}
    </div>
    {#if !analysis.departure.n && !analysis.travel.n}<p class="notice">Actual departure and arrival times are unavailable for this selection. Scheduled pickup, appointment times, and reported service hours are not substituted for actual leg times.</p>{/if}
    <div class="chart-grid">
      {#each [{ title: 'Origin cities', rows: origins }, { title: 'Destination cities', rows: destinations }, { title: 'Source statuses', rows: analysis.statuses }] as panel}
        <article><h3>{panel.title}</h3><p class="note">{panel.title === 'Source statuses' ? 'Raw labels; completion is not assumed.' : 'Top 10 by endpoint count; follows the selected map layer.'}</p>
          {#if panel.rows.length === 0}<p class="note">No events in this layer.</p>{/if}
          {#each panel.rows as row}
            <div class="bar-row"><span>{row.label}</span><strong>{count(row.count)}</strong><div class="track"><i style:width={`${row.count / Math.max(1,...panel.rows.map(r=>r.count)) * 100}%`}></i></div></div>
          {/each}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .record-analysis { border-top:1px solid #dbe3ef; margin-top:20px; padding-top:20px; }
  header { display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap; }
  header>strong { font-size:12px; color:#0f766e; }
  .eyebrow { font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:.06em; }
  h2 { font-size:18px; margin:5px 0; } h3 { font-size:14px; margin:0; }
  .note, .notice { font-size:12px; line-height:1.65; color:#64748b; }
  .notice { padding:12px; background:#f1f5f9; border-radius:8px; }
  article { min-width:0; padding:18px; border:1px solid #e2e8f0; border-radius:12px; background:white; margin-bottom:14px; }
  .chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:14px; margin:14px 0; }
  svg { display:block; width:100%; margin-top:12px; } svg text { font-size:11px; fill:#64748b; }
  .bar-row { display:grid; grid-template-columns:1fr auto; gap:5px; margin:12px 0; font-size:12px; }
  .track { grid-column:1 / -1; height:7px; background:#f1f5f9; border-radius:4px; overflow:hidden; }
  .track i { display:block; height:100%; background:#0f766e; }
  details { font-size:12px; } summary { cursor:pointer; } .counts { max-height:220px; overflow:auto; }
  .counts>div { display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #e2e8f0; }
</style>
