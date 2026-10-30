<script lang="ts">
  import type { PairChart } from '$lib/operationsApi';
  export let title: string;
  export let description: string;
  export let chart: PairChart | undefined;
  export let unit: 'clock' | 'minutes' | 'hours';
  export let color = '#2563eb';
  let selected: number | null = null;
  const number = (value: number) => value.toLocaleString('en-US');
  const format = (value: number) => unit === 'clock'
    ? `${String(Math.floor(value)).padStart(2, '0')}:${String(Math.floor(value % 1 * 60)).padStart(2, '0')}`
    : value > 0 && value < 0.1
      ? `${(value * 60).toFixed(1)} ${unit === 'minutes' ? 'sec' : 'min'}`
      : `${value.toFixed(1)} ${unit === 'minutes' ? 'min' : 'hr'}`;
  $: width = unit === 'minutes' ? 10 : 1;
  $: length = unit === 'clock' ? 24 : Math.max(1, Math.floor((chart?.max ?? 0) / width) + 1);
  $: bins = Array.from({ length }, (_, i) => ({ start: i * width, count: chart?.bins.find(b => b.start === i * width)?.count ?? 0 }));
  $: peak = Math.max(1, ...bins.map(b => b.count));
  $: tickEvery = Math.max(1, Math.ceil(length / 9));
  $: if (chart) selected = null;
  const binLabel = (start: number) => unit === 'clock'
    ? `${String(start).padStart(2, '0')}:00–${String(start + 1).padStart(2, '0')}:00`
    : `${start}–<${start + width} ${unit}`;
</script>

<article class="histogram">
  <header><h3>{title}</h3><span>{number(chart?.n ?? 0)} {unit === 'hours' ? 'activities' : 'trips'}</span></header>
  <p>{description}</p>
  {#if chart?.n}
    <div class="stats"><span>Mean <strong>{format(chart.mean)}</strong></span><span>Min <strong>{format(chart.min)}</strong></span><span>Max <strong>{format(chart.max)}</strong></span></div>
    <svg viewBox="0 0 560 230" role="group" aria-label={`${title}. ${number(chart.n)} observations. Horizontal axis: ${unit === 'clock' ? 'departure hour' : unit}. Vertical axis: count.`}>
      <text x="46" y="13" class="axis-title">{unit === 'hours' ? 'Activities' : 'Trips'}</text>
      {#each [0, 0.5, 1] as fraction}
        <line x1="46" x2="548" y1={184 - fraction * 152} y2={184 - fraction * 152} stroke="#e2e8f0" />
        <text x="40" y={188 - fraction * 152} text-anchor="end">{number(Math.round(peak * fraction))}</text>
      {/each}
      {#each bins as bin, i}
        <rect x={48 + i * 500 / length} y={184 - bin.count / peak * 152}
          width={Math.max(1, 500 / length - 3)} height={bin.count / peak * 152}
          fill={color} opacity={selected === null || selected === i ? 0.9 : 0.45} rx="2"
          tabindex="0" role="button" aria-label={`${binLabel(bin.start)}: ${number(bin.count)}`}
          onclick={() => selected = i}
          onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selected = i; } }}
          onfocus={() => selected = i} onblur={() => selected = null}
          onmouseenter={() => selected = i} onmouseleave={() => selected = null}>
          <title>{binLabel(bin.start)}: {number(bin.count)}</title>
        </rect>
        {#if i % tickEvery === 0}
          <text x={48 + (i + 0.5) * 500 / length} y="201" text-anchor="middle">{bin.start}</text>
        {/if}
      {/each}
      <text x="298" y="222" text-anchor="middle" class="axis-title">{unit === 'clock' ? 'Departure hour · local time' : unit === 'minutes' ? 'Travel time · minutes' : 'Activity duration · hours'}</text>
    </svg>
    <div class="readout" aria-live="polite">{selected === null ? `${width}-${unit === 'minutes' ? 'minute' : 'hour'} bins · Hover or focus a bar for its count` : `${binLabel(bins[selected].start)}: ${number(bins[selected].count)} ${unit === 'hours' ? 'activities' : 'trips'}`}</div>
    <details><summary>View counts</summary><div class="table-scroll"><table><thead><tr><th>Interval</th><th>Count</th></tr></thead><tbody>{#each bins as bin}<tr><td>{binLabel(bin.start)}</td><td>{number(bin.count)}</td></tr>{/each}</tbody></table></div></details>
  {:else}
    <div class="empty">No validated round trips match this selection.</div>
  {/if}
</article>

<style>
  .histogram { height:100%; padding:18px; border:1px solid #e2e8f0; border-radius:12px; background:white; min-width:0; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  h3 { margin:0; font-size:14px; color:#0f172a; }
  header span { font-size:11px; color:#64748b; }
  p { min-height:32px; font-size:12px; line-height:1.5; color:#64748b; margin:8px 0 12px; }
  .stats { display:flex; flex-wrap:wrap; gap:8px 16px; font-size:11px; color:#64748b; }
  strong { color:#334155; margin-left:3px; }
  svg { display:block; width:100%; max-height:300px; margin-top:12px; overflow:visible; }
  svg text { fill:#64748b; font-size:11px; }
  .axis-title { font-size:12px; }
  rect:focus { outline:2px solid #0f172a; }
  .readout { min-height:30px; font-size:11px; color:#475569; line-height:1.5; }
  details { font-size:12px; color:#475569; }
  summary { cursor:pointer; width:fit-content; }
  .table-scroll { max-height:220px; overflow:auto; margin-top:10px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:6px; border-bottom:1px solid #e2e8f0; }
  th:last-child,td:last-child { text-align:right; }
  .empty { display:grid; place-items:center; min-height:160px; text-align:center; font-size:13px; color:#64748b; }
</style>
