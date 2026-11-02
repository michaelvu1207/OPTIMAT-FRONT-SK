import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prepared = path.join(root, 'scripts/operations/output/agencies');
const out = path.join(root, 'infra/.aws-sam/agency-operations');
const reports = [];
const imports = [];
for (const [source, id] of [['WESTCAT', 1003], ['TDT', 1002], ['MM', 4021]]) {
  const folder = path.join(prepared, source.toLowerCase());
  const report = JSON.parse(await readFile(path.join(folder, 'quality-report.json'), 'utf8'));
  if (report.source !== source || report.provider_id !== id || !report.row_count || !/^[a-f0-9]{64}$/.test(report.import_id)) {
    throw new Error(`Prepare and review ${source} before bundling`);
  }
  reports.push(report);
  imports.push(await readFile(path.join(folder, 'import.sql'), 'utf8'));
}
for (const name of ['migrator', 'trip-records']) {
  const target = path.join(out, name);
  await mkdir(target, { recursive: true });
  await build({ entryPoints: [path.join(root, `infra/lambda/${name}/index.ts`)], outfile: path.join(target, 'index.js'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true });
}
await copyFile(path.join(root, 'infra/migrations/0006_agency_operations.sql'), path.join(out, 'migrator/agency-schema.sql'));
await writeFile(path.join(out, 'migrator/agency-quality-reports.json'), JSON.stringify(reports, null, 2));
await writeFile(path.join(out, 'migrator/agency-import.sql'), imports.join('\n'));
console.log(`Built private deployment bundle: ${out}`);
