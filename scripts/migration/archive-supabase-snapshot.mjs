#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'htjohidcoyfuwfjecazu';
const AWS_PROFILE = process.env.AWS_PROFILE || 'path';
const AWS_REGION = process.env.AWS_REGION || 'us-west-1';
const ACCOUNT_ID = execFileSync(
  'aws',
  ['sts', 'get-caller-identity', '--profile', AWS_PROFILE, '--query', 'Account', '--output', 'text'],
  { encoding: 'utf8' },
).trim();
const BUCKET = `optimat-archive-${ACCOUNT_ID}-${AWS_REGION}`;
const OP = '/Users/maikyon/bin/op-michaelagents';
const READER_ITEM = '2df72qzeklxf54hmom2pisp5ey';
const PG_DUMP = '/opt/homebrew/opt/libpq/bin/pg_dump';
const POOLER_HOST = 'aws-1-us-east-2.pooler.supabase.com';
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const prefix = `supabase-snapshots/${stamp}`;
const dumpPath = `/tmp/optimat-supabase-${stamp}.dump`;
const functionsPath = `/tmp/optimat-supabase-functions-${stamp}.tar.gz`;
const manifestPath = `/tmp/optimat-supabase-${stamp}.manifest.json`;
const schemaPath = resolve('docs/migration/inventory/supabase-schema-raw.sql');
const inventoryDirectory = resolve('docs/migration/inventory');
const inventoryPath = readdirSync(inventoryDirectory)
  .filter((name) => /^live-supabase-\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .sort()
  .map((name) => resolve(inventoryDirectory, name))
  .at(-1);

if (!inventoryPath) throw new Error('No captured live Supabase inventory found.');

function opField(field) {
  return execFileSync(
    OP,
    ['item', 'get', READER_ITEM, '--vault', 'MichaelAgents', '--fields', field, '--reveal'],
    { encoding: 'utf8' },
  ).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function upload(path, key) {
  execFileSync(
    'aws',
    [
      's3',
      'cp',
      path,
      `s3://${BUCKET}/${key}`,
      '--profile',
      AWS_PROFILE,
      '--region',
      AWS_REGION,
      '--sse',
      'AES256',
      '--only-show-errors',
    ],
    { stdio: 'inherit' },
  );

  const remoteSize = Number(
    execFileSync(
      'aws',
      [
        's3api',
        'head-object',
        '--bucket',
        BUCKET,
        '--key',
        key,
        '--profile',
        AWS_PROFILE,
        '--region',
        AWS_REGION,
        '--query',
        'ContentLength',
        '--output',
        'text',
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
  if (remoteSize !== statSync(path).size) throw new Error(`S3 size mismatch for ${key}`);
}

const username = opField('username');
const password = opField('password');

console.log('Creating transaction-consistent Supabase data dump...');
execFileSync(
  PG_DUMP,
  [
    `host=${POOLER_HOST} port=5432 dbname=postgres sslmode=require`,
    '--username',
    username,
    '--format=custom',
    '--compress=9',
    '--data-only',
    '--enable-row-security',
    '--schema=optimat',
    '--schema=public',
    '--no-owner',
    '--no-privileges',
    '--file',
    dumpPath,
  ],
  { env: { ...process.env, PGPASSWORD: password }, stdio: 'inherit' },
);

console.log('Archiving downloaded live Edge Function sources...');
execFileSync(
  'tar',
  [
    '-czf',
    functionsPath,
    '-C',
    '/tmp/optimat-supabase-live/supabase',
    'functions',
  ],
  { stdio: 'inherit' },
);

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const files = [
  { kind: 'data_dump', path: dumpPath },
  { kind: 'schema', path: schemaPath },
  { kind: 'inventory', path: inventoryPath },
  { kind: 'edge_functions', path: functionsPath },
].map((file) => ({
  ...file,
  filename: basename(file.path),
  bytes: statSync(file.path).size,
  sha256: sha256(file.path),
}));

const manifest = {
  captured_at: new Date().toISOString(),
  source_project_ref: PROJECT_REF,
  source_server_version: inventory.database.system?.[0]?.server_version,
  inventory_captured_at: inventory.captured_at,
  table_checksums: inventory.database.tableChecksums,
  retention: 'indefinite',
  files: files.map(({ kind, filename, bytes, sha256: checksum }) => ({
    kind,
    filename,
    bytes,
    sha256: checksum,
  })),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

console.log(`Uploading encrypted snapshot to s3://${BUCKET}/${prefix}/ ...`);
for (const file of files) upload(file.path, `${prefix}/${file.filename}`);
upload(manifestPath, `${prefix}/${basename(manifestPath)}`);

for (const path of [dumpPath, functionsPath, manifestPath]) unlinkSync(path);

console.log(JSON.stringify({
  bucket: BUCKET,
  prefix,
  files: files.map(({ kind, filename, bytes, sha256: checksum }) => ({
    kind,
    filename,
    bytes,
    sha256: checksum,
  })),
}, null, 2));
