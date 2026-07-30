#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SELF = 'scripts/check-secrets.mjs';
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((file) => file !== SELF)
  .filter((file) => !file.startsWith('.playwright-cli/'))
  .filter((file) => !file.startsWith('.omc/'))
  .filter((file) => !file.startsWith('.codex/'))
  .filter((file) => !file.includes('/node_modules/'));

const patterns = [
  ['AWS access key', new RegExp(`\\b(?:${'AK' + 'IA'}|${'AS' + 'IA'})[0-9A-Z]{16}\\b`)],
  ['JWT', new RegExp(`\\b${'ey' + 'J'}[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\b`)],
  ['Supabase key', new RegExp(`\\b${'sb_' + '(?:publishable|secret)'}_[A-Za-z0-9_-]{20,}\\b`)],
  ['private key', new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`)],
];

const findings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const [label, pattern] of patterns) {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    });
  }
}

if (findings.length > 0) {
  console.error('Potential committed credentials found (values redacted):');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} files checked).`);
