#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || 'docs/qa/feedback-2026-08-24');
const fixture = JSON.parse(readFileSync(resolve('tests/chat/feedback-2026-08-24.json'), 'utf8'));
const comparisons = resolve(root, 'comparisons');
mkdirSync(comparisons, { recursive: true });

const outputs = [];
for (const scenario of fixture.scenarios) {
  const before = resolve(root, 'before', `${scenario.id}.webm`);
  const after = resolve(root, 'after', `${scenario.id}.webm`);
  const output = resolve(comparisons, `${scenario.id}.mp4`);
  const title = scenario.id.replaceAll(':', '\\:').replaceAll("'", "\\'");
  const filter = [
    `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='BEFORE':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=24:box=1:boxcolor=black@0.75:boxborderw=12[left]`,
    `[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,drawtext=text='AFTER':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=24:box=1:boxcolor=black@0.75:boxborderw=12[right]`,
    `[left][right]hstack=inputs=2,drawtext=text='${title}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-52:box=1:boxcolor=black@0.75:boxborderw=10[out]`,
  ].join(';');
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-i', before, '-i', after,
    '-filter_complex', filter,
    '-map', '[out]', '-an', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ]);
  outputs.push(output);
}

const concatList = resolve(comparisons, 'concat.txt');
writeFileSync(concatList, outputs.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join('\n'));
execFileSync('ffmpeg', [
  '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatList,
  '-c', 'copy', '-movflags', '+faststart', resolve(root, 'feedback-2026-08-24-before-after-summary.mp4'),
]);

const artifactFiles = [
  ...readdirSync(resolve(root, 'before')).filter((name) => /\.(webm|png)$/.test(name)).map((name) => `before/${name}`),
  ...readdirSync(resolve(root, 'after')).filter((name) => /\.(webm|png)$/.test(name)).map((name) => `after/${name}`),
  ...readdirSync(comparisons).filter((name) => name.endsWith('.mp4')).map((name) => `comparisons/${name}`),
  'feedback-2026-08-24-before-after-summary.mp4',
].sort();
writeFileSync(resolve(root, 'artifact-manifest.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  fixture: 'tests/chat/feedback-2026-08-24.json',
  artifacts: artifactFiles.map((relativePath) => {
    const absolutePath = resolve(root, relativePath);
    const data = readFileSync(absolutePath);
    return {
      path: relativePath,
      bytes: statSync(absolutePath).size,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }),
}, null, 2));

console.log(`Comparison clips and summary reel written to ${root}`);
