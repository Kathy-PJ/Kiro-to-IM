#!/usr/bin/env node
/**
 * Patch: downgrade cardkit.v2 → cardkit.v1 in feishu-adapter
 *
 * The claude-to-im Feishu adapter uses cardkit.v2 API, but
 * @larksuiteoapi/node-sdk <= 1.59.0 only has cardkit.v1.
 * This patch replaces all v2 calls with v1 as a workaround.
 *
 * Run after `npm install`:
 *   node scripts/patch-cardkit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const adapterPath = path.join(
  import.meta.dirname || '.',
  '..',
  'node_modules',
  'claude-to-im',
  'src',
  'lib',
  'bridge',
  'adapters',
  'feishu-adapter.ts',
);

if (!fs.existsSync(adapterPath)) {
  console.log('[patch-cardkit] feishu-adapter.ts not found, skipping');
  process.exit(0);
}

let content = fs.readFileSync(adapterPath, 'utf-8');
const count = (content.match(/cardkit\.v2/g) || []).length;

if (count === 0) {
  console.log('[patch-cardkit] No cardkit.v2 references found, already patched or not needed');
  process.exit(0);
}

content = content.replace(/cardkit\.v2/g, 'cardkit.v1');
fs.writeFileSync(adapterPath, content, 'utf-8');
console.log(`[patch-cardkit] Replaced ${count} cardkit.v2 → cardkit.v1 references`);
