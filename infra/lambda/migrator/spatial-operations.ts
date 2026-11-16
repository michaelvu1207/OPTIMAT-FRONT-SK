// Temporary, bounded deployment handler. Restore the existing migrator afterwards.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSecret } from '../_shared/secrets.js';
import { OPERATIONS_SQL } from '../trip-records/operations.js';

export async function handler(event: { action?: string }) {
  if (!['apply-spatial-operations','verify-spatial-operations'].includes(event.action || '')) {
    return { success: false, error: 'Unsupported spatial migration action' };
  }
  const secret = await getSecret(process.env.DB_MASTER_SECRET_ARN!);
  const client = new pg.Client({ host: secret.host || process.env.DB_HOST, port:Number(secret.port || 5432),
    database: secret.dbname || 'optimat', user: secret.username, password: secret.password,
    ssl: { rejectUnauthorized:true }, connectionTimeoutMillis:10000 });
  await client.connect();
  try {
    if (event.action === 'apply-spatial-operations') {
      await client.query(await readFile(join(__dirname,'spatial-schema.sql'),'utf8'));
      await client.query(await readFile(join(__dirname,'spatial-import.sql'),'utf8'));
    }
    const expected = JSON.parse(await readFile(join(__dirname,'spatial-verification.json'),'utf8'));
    const results=[];
    for (const e of expected) {
      const p = (await client.query(OPERATIONS_SQL,[e.provider === 'all' ? null : Number(e.provider),null,null,0,24,null,'combined',50,0])).rows[0].payload;
      if (p.summary.records !== e.records || p.spatial_analysis.geocoded_events !== e.geocoded ||
        p.spatial_analysis.cells.length !== e.spatial || p.spatial_analysis.displayed_events !== e.displayed ||
        p.record_analysis.departure.n !== e.departure || p.record_analysis.travel.n !== e.travel ||
        p.paired_analysis.selected_pairs !== e.pairs) throw new Error(`Spatial reconciliation failed for provider ${e.provider}`);
      results.push(e);
    }
    return {success:true,providers:results};
  } finally { await client.end(); }
}
