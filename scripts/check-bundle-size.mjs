// TD-12 §8.1: initial JS budget for the dashboard (gzip). Run after `next build`.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 170);
const manifestPath = '.next/app-build-manifest.json';
if (!existsSync(manifestPath)) {
  console.error('Run `next build` first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const key = Object.keys(manifest.pages).find((k) => k === '/(app)/page') ?? Object.keys(manifest.pages).find((k) => k.endsWith('/page') && k.includes('(app)'));
if (!key) {
  console.error('Dashboard page not found in the build manifest.');
  process.exit(1);
}
const files = [...new Set([...(manifest.pages['/layout'] ?? []), ...(manifest.pages[key] ?? [])])].filter((f) => f.endsWith('.js'));
let total = 0;
for (const f of files) total += gzipSync(readFileSync(path.join('.next', f))).length;
const kb = total / 1024;
console.log(`Dashboard initial JS: ${kb.toFixed(1)} kB gzip (budget ${BUDGET_KB} kB) across ${files.length} files`);
if (kb > BUDGET_KB) {
  console.error('Bundle budget exceeded.');
  process.exit(1);
}
