/** Run the production SQL against a private, in-memory PostgreSQL preview. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const modulePath = args[0];
if (!modulePath) throw new Error('Usage: node scripts/operations/local_preview.mjs <pglite module path> [--verify-only]');
const { PGlite } = await import(pathToFileURL(path.resolve(modulePath)).href);
const require = createRequire(path.join(root, 'infra/package.json'));
const { build } = require('esbuild');
const output = path.join(root, 'scripts/operations/output/spatial');
await build({ stdin: { contents: "export { OPERATIONS_SQL, parseFilters } from './infra/lambda/trip-records/operations.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: path.join(root, 'infra/.aws-sam/operations-preview.mjs') });
const { OPERATIONS_SQL, parseFilters } = await import(pathToFileURL(path.join(root, 'infra/.aws-sam/operations-preview.mjs')).href);
const db = new PGlite();
await db.exec('CREATE SCHEMA optimat; CREATE TABLE optimat.providers(provider_id integer PRIMARY KEY,provider_name text);');
const names = { LINK: [2006,'LINK Paratransit'], WESTCAT: [1003,'WestCAT'], TDT: [1002,'Tri Delta Transit'], MM: [4021,'Mobility Matters'] };
for (const [id,name] of Object.values(names)) await db.query('INSERT INTO optimat.providers VALUES ($1,$2)',[id,name]);
for (const file of ['0005_link_operations.sql','0006_agency_operations.sql','0007_operation_spatial_cells.sql']) {
  await db.exec(await fs.readFile(path.join(root,'infra/migrations',file),'utf8'));
}
const rows = (await fs.readFile(path.join(output,'records.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
for (const source of Object.keys(names)) {
  const selected = rows.filter(r => r.source === source);
  const dates = selected.map(r => r.service_date).sort();
  await db.query(`INSERT INTO optimat.operation_imports(id,source,filename,file_sha256,parser_version,provider_id,row_count,date_from,date_to,active,quality_report)
    VALUES($1,$2,$3,'local-preview','local-preview',$4,$5,$6,$7,true,$8)`,
    ['preview-'+source,source,source+' reviewed local export',names[source][0],selected.length,dates[0],dates.at(-1),JSON.stringify({ record_unit: source==='MM'?'ride':'booking' })]);
}
const spatial = [];
for (const r of rows) {
  r.import_id = 'preview-'+r.source;
  for (const kind of ['origin','destination']) if (r[kind+'_cell']) {
    spatial.push({ import_id:r.import_id,source_row:r.source_row,kind:kind+'s',cell_x:r[kind+'_cell'][0],cell_y:r[kind+'_cell'][1],
      location_key:r[kind+'_location_key'],precision:r[kind+'_precision'] });
  }
}
await db.exec('BEGIN');
for (let start=0;start<rows.length;start+=2000) await db.query('INSERT INTO optimat.operation_trips SELECT * FROM jsonb_populate_recordset(NULL::optimat.operation_trips,$1)',[JSON.stringify(rows.slice(start,start+2000))]);
for (let start=0;start<spatial.length;start+=2000) await db.query('INSERT INTO optimat.operation_spatial_cells SELECT * FROM jsonb_populate_recordset(NULL::optimat.operation_spatial_cells,$1)',[JSON.stringify(spatial.slice(start,start+2000))]);
await db.exec('COMMIT');
async function query(params) {
  const f = parseFilters(params);
  const result = await db.query(OPERATIONS_SQL,[f.providerId,f.from,f.to,f.hourFrom,f.hourTo,f.status,f.mode,f.limit,f.offset]);
  return { ...result.rows[0].payload, filters:f, precision:'aggregated_1km_cells', timezone:'America/Los_Angeles' };
}
const reports=[];
for (const id of ['', '2006','1003','1002','4021']) {
  const data = await query(new URLSearchParams({provider_id:id}));
  reports.push({provider:id||'all',records:data.summary.records,spatial:data.spatial_analysis.cells.length,
    geocoded:data.spatial_analysis.geocoded_events,displayed:data.spatial_analysis.displayed_events,
    departure:data.record_analysis.departure.n,travel:data.record_analysis.travel.n,pairs:data.paired_analysis.selected_pairs});
  if (data.record_analysis.daily.reduce((a,b)=>a+b.count,0)!==data.summary.records) throw new Error('Daily count reconciliation failed');
  if (data.record_analysis.statuses.reduce((a,b)=>a+b.count,0)!==data.summary.records) throw new Error('Status count reconciliation failed');
  if (data.spatial_analysis.cells.some(c=>c.count<20 || c.count%10!==0)) throw new Error('Unsafe spatial counts');
  const serialized = JSON.stringify(data.spatial_analysis);
  if (/location_key|source_row|address|client_id/.test(serialized)) throw new Error('Private fields leaked');
}
const sparse=await query(new URLSearchParams({provider_id:'4021',hour_from:'8',hour_to:'9'}));
if(sparse.summary.records!==0 || sparse.spatial_analysis.cells.length) throw new Error('Missing times must not enter hourly filters');
const empty=await query(new URLSearchParams({date_from:'2030-01-01'}));
if(empty.summary.records!==0 || empty.record_analysis.daily.length) throw new Error('Empty selection failed');
// Test privacy thresholds with controlled records using the real dashboard SQL.
await db.exec('BEGIN; UPDATE optimat.operation_imports SET active=false');
await db.exec(`INSERT INTO optimat.operation_imports(id,source,filename,file_sha256,parser_version,provider_id,row_count,date_from,date_to,active,quality_report)
  VALUES('threshold-test','MM','synthetic','test','test',4021,59,'2025-07-01','2025-07-01',true,'{}')`);
let rowNumber=2;
for (const [x,total,locations] of [[-10000,19,5],[-10001,20,4],[-10002,20,5]]) {
  for(let i=0;i<total;i++) {
    await db.query("INSERT INTO optimat.operation_trips(import_id,source_row,service_date,status) VALUES('threshold-test',$1,'2025-07-01',$2)",[rowNumber,i<9?'B':'A']);
    await db.query("INSERT INTO optimat.operation_spatial_cells VALUES('threshold-test',$1,'origins',$2,4000,$3,'census_street_interpolation')",[rowNumber,x,'area-'+(i%locations)]);
    rowNumber++;
  }
}
const threshold=await query(new URLSearchParams({provider_id:'4021',mode:'origins'}));
if(threshold.spatial_analysis.cells.length!==1 || threshold.spatial_analysis.cells[0].count!==20) throw new Error('Privacy threshold boundary failed');
const subset=await query(new URLSearchParams({provider_id:'4021',mode:'origins',status:'B'}));
if(subset.spatial_analysis.cells.length!==0) throw new Error('Filter subsets bypassed privacy suppression');
await db.exec('ROLLBACK');
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports));
if (args.includes('--verify-only')) { await db.close(); process.exit(0); }
const server=http.createServer(async(req,res)=>{
  if (req.headers.origin && !['http://localhost:43111','http://127.0.0.1:43111'].includes(req.headers.origin)) {res.writeHead(403).end();return;}
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'http://127.0.0.1:43111');
  res.setHeader('Cache-Control','no-store');
  const url=new URL(req.url,'http://127.0.0.1:43112');
  if(req.method!=='GET'||url.pathname!=='/operations'){res.writeHead(404).end();return;}
  try { const data=await query(url.searchParams);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data)); }
  catch {res.writeHead(400).end(JSON.stringify({error:'Invalid preview request'}));}
});
server.listen(43112,'127.0.0.1',()=>console.log('Private operations preview ready on http://127.0.0.1:43112'));
