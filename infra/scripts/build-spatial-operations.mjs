import { build } from 'esbuild';
import { mkdir,copyFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const out=path.join(root,'infra/.aws-sam/spatial-operations');
for (const [name,entry] of [['migrator','migrator/spatial-operations.ts'],['trip-records','trip-records/index.ts']]) {
  const target=path.join(out,name); await mkdir(target,{recursive:true});
  await build({entryPoints:[path.join(root,'infra/lambda',entry)],outfile:path.join(target,'index.js'),
    bundle:true,platform:'node',target:'node24',format:'cjs',minify:true});
}
for (const [source,dest] of [['infra/migrations/0007_operation_spatial_cells.sql','spatial-schema.sql'],
  ['scripts/operations/output/spatial/import-spatial.sql','spatial-import.sql'],
  ['scripts/operations/output/spatial/verification.json','spatial-verification.json']]) {
  await copyFile(path.join(root,source),path.join(out,'migrator',dest));
}
console.log('Built private spatial deployment bundles. Restore the prior migrator after use.');
