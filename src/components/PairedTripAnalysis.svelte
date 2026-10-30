<script lang="ts">
  import OperationsHistogram from './OperationsHistogram.svelte';
  import type { PairedAnalysis } from '$lib/operationsApi';
  export let analysis: PairedAnalysis;
  const count = (value: number) => value.toLocaleString('en-US');
</script>

<section aria-label="Paired round-trip analysis" class="paired-analysis">
  <div class="heading"><div><span class="eyebrow">LINK · Paired journeys</span><h2>Outbound, return & activity patterns</h2></div><strong>{count(analysis.selected_pairs)} round trips</strong></div>
  <p class="note">Each validated pair contributes one observation to every chart. Dates and provider follow the filters. Both legs must match the selected status. An hour window keeps the whole pair when either departure falls inside it. Map layers do not change these charts.</p>
  <div class="charts">
    <OperationsHistogram title="Outbound departure time" description="Departure from the inferred home location." chart={analysis.charts.find(c => c.id === 'outbound_time')} unit="clock" color="#2563eb" />
    <OperationsHistogram title="Return departure time" description="Departure from the activity location for home." chart={analysis.charts.find(c => c.id === 'return_time')} unit="clock" color="#ea580c" />
    <OperationsHistogram title="Travel time · Going out" description="Outbound drop-off arrival minus pickup departure." chart={analysis.charts.find(c => c.id === 'outbound_travel')} unit="minutes" color="#2563eb" />
    <OperationsHistogram title="Travel time · Back home" description="Return drop-off arrival minus pickup departure." chart={analysis.charts.find(c => c.id === 'return_travel')} unit="minutes" color="#ea580c" />
    <div class="wide"><OperationsHistogram title="Going-out activity duration" description="Return pickup departure minus outbound drop-off arrival. This observed interval may include waiting and boarding." chart={analysis.charts.find(c => c.id === 'activity_duration')} unit="hours" color="#0f766e" /></div>
  </div>
  <details class="quality">
    <summary>Pairing & data quality · {count(analysis.quality.excluded_records)} source records excluded from paired analysis</summary>
    <p class="note">Quality counts cover the selected provider and dates before status and hour filters. Raw trip records remain available. Home is inferred from a matching first pickup and final drop-off address and ZIP; it is not a verified residence.</p>
    <dl>
      <div><dt>Source records</dt><dd>{count(analysis.quality.source_records)}</dd></div>
      <div><dt>Validated pairs before status / hours</dt><dd>{count(analysis.quality.valid_pairs)}</dd></div>
      <div><dt>Single-trip client days</dt><dd>{count(analysis.quality.single_trip_days)}</dd></div>
      <div><dt>Client days with more than two trips</dt><dd>{count(analysis.quality.multi_trip_days)}</dd></div>
      <div><dt>Two-trip days with missing times</dt><dd>{count(analysis.quality.missing_time_pairs)}</dd></div>
      <div><dt>Two-trip days with invalid time order</dt><dd>{count(analysis.quality.invalid_sequence_pairs)}</dd></div>
      <div><dt>Two-trip days without a home match</dt><dd>{count(analysis.quality.unmatched_home_pairs)}</dd></div>
      <div><dt>Records without a client identifier</dt><dd>{count(analysis.quality.missing_client_records)}</dd></div>
      <div><dt>Selected pairs with different or unresolved activity addresses</dt><dd>{count(analysis.changed_activity_pairs)}</dd></div>
    </dl>
    <p class="note">Pairing uses the same import, client and date, sorted by actual pickup departure. Only two-record client days with complete, ordered times and a home match qualify. Activity drop-off and pickup addresses may differ. Missing times, overlapping legs and ambiguous multi-trip days are not forced into pairs; overnight rollover is not assumed.</p>
  </details>
</section>

<style>
  .paired-analysis { padding-top:24px; margin-top:20px; border-top:1px solid #dbe3ef; }
  .heading { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; }
  h2 { font-size:18px; line-height:1.4; margin:5px 0 0; color:#0f172a; }
  .heading>strong { padding:8px 12px; font-size:12px; color:#0f766e; background:#ccfbf1; border-radius:20px; }
  .note { font-size:12px; line-height:1.7; color:#64748b; margin:12px 0 18px; }
  .charts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
  .wide { grid-column:1 / -1; }
  .quality { margin-top:18px; padding:14px; background:#f1f5f9; border-radius:10px; font-size:12px; }
  summary { color:#334155; cursor:pointer; line-height:1.6; }
  dl { margin:0; }
  dl>div { display:flex; justify-content:space-between; gap:16px; padding:7px 0; border-bottom:1px solid #e2e8f0; }
  dd { margin:0; font-weight:650; font-variant-numeric:tabular-nums; }
  @media(max-width:1550px) { .charts { grid-template-columns:minmax(0,1fr); } }
</style>
