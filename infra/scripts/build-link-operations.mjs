import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'infra/.aws-sam/link-operations');
const prepared = path.join(root, 'scripts/operations/output');
const report = JSON.parse(await readFile(path.join(prepared, 'quality-report.json'), 'utf8'));
if (report.source !== 'LINK' || !report.row_count || !/^[a-f0-9]{64}$/.test(report.import_id)) {
  throw new Error('Prepare and review the LINK import before building the deployment bundle.');
}
for (const name of ['migrator', 'trip-records']) {
  const target = path.join(out, name);
  await mkdir(target, { recursive: true });
  await build({ entryPoints: [path.join(root, `infra/lambda/${name}/index.ts`)], outfile: path.join(target, 'index.js'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true });
}
for (const [source, target] of [
  [path.join(root, 'infra/migrations/0005_link_operations.sql'), 'link-schema.sql'],
  [path.join(prepared, 'import-link.sql'), 'link-import.sql'],
  [path.join(prepared, 'quality-report.json'), 'link-quality-report.json'],
]) await copyFile(source, path.join(out, 'migrator', target));
console.log(`Built LINK deployment directories in ${out}. Raw data remains outside version control.`);
