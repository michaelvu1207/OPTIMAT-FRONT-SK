import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Direct database alternative to the IAM-only, VPC-resident migrator.
// Configure PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD through the environment.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv.includes('--execute')) {
  console.log('Set PostgreSQL connection environment variables, then run with --execute to apply migration 0005 and the prepared LINK import.');
  process.exit(0);
}
if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) throw new Error('Explicit PGHOST, PGDATABASE, and PGUSER are required.');
const ca = process.env.PGSSLROOTCERT ? await readFile(process.env.PGSSLROOTCERT, 'utf8') : undefined;
const client = new pg.Client({ ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) } });
await client.connect();
try {
  await client.query(await readFile(path.join(root, 'infra/migrations/0005_link_operations.sql'), 'utf8'));
  await client.query(await readFile(path.join(root, 'scripts/operations/output/import-link.sql'), 'utf8'));
  const result = await client.query(`SELECT i.filename,i.row_count,count(t.*)::integer AS imported_records
    FROM optimat.operation_imports i JOIN optimat.operation_trips t ON t.import_id=i.id
    WHERE i.source='LINK' AND i.active GROUP BY i.id`);
  for (const row of result.rows) if (row.row_count !== row.imported_records) throw new Error('Import count mismatch');
  console.log(JSON.stringify(result.rows, null, 2));
} finally { await client.end(); }
