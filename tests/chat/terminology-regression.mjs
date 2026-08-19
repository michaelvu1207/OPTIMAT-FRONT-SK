#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const roots = [
  'src',
  'supabase/functions/chat',
  'infra/lambda/chat',
];
const allowedExtensions = new Set(['.svelte', '.ts', '.js', '.mjs', '.json']);
const legacyTerm = /\bADA[- ]certif(?:ied|ication)\b/i;
const failures = [];

function visit(path) {
  for (const name of readdirSync(path)) {
    const fullPath = join(path, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (!allowedExtensions.has(extname(name))) continue;
    const lines = readFileSync(fullPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (legacyTerm.test(line)) failures.push(`${relative(root, fullPath)}:${index + 1}`);
    });
  }
}

roots.forEach((path) => visit(join(root, path)));
assert.deepEqual(
  failures,
  [],
  `Use "ADA paratransit eligibility" in rider-facing code. Legacy wording found at:\n${failures.join('\n')}`,
);

console.log('ADA terminology regression passed');
