#!/usr/bin/env node
/**
 * Post-install patches for kiro-to-im.
 *
 * 1. Disable CardKit streaming cards (v2 not in SDK, v1 incompatible format)
 * 2. Remove inline permission buttons (cause Feishu API errors with CardKit disabled)
 *
 * Must patch BOTH dist/ (.js) AND src/ (.ts) because
 * esbuild resolves from dist/ (the package.json "main" field).
 *
 * Run after `npm install`:
 *   node scripts/patch-cardkit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const PATCH_MARKER = 'PATCHED_BY_KIRO_TO_IM';
const base = path.join(import.meta.dirname || '.', '..', 'node_modules', 'claude-to-im');

let totalPatched = 0;

// ── Patch 1: Disable CardKit streaming cards ──

const adapterFiles = [
  path.join(base, 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
  path.join(base, 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
];

for (const filePath of adapterFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch] ${path.basename(filePath)} already patched`);
    continue;
  }

  const patterns = [
    /(\s*)(private\s+)?createStreamingCard\s*\([^)]*\)\s*(?::\s*Promise<boolean>\s*)?\{/,
    /(\s*)createStreamingCard\s*\([^)]*\)\s*\{/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const indent = match[1] || '  ';
      content = content.replace(match[0],
        match[0] + `\n${indent}  // ${PATCH_MARKER}: Disable CardKit streaming cards.\n${indent}  return Promise.resolve(false);`
      );
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`[patch] ${path.basename(filePath)}: CardKit streaming disabled`);
      totalPatched++;
      break;
    }
  }
}

// ── Patch 2: Remove inline permission buttons ──
// The buttons cause Feishu API errors (200340) because CardKit is disabled.
// Users can still reply with text "1 Allow / 2 Allow Session / 3 Deny".

const brokerFiles = [
  path.join(base, 'dist', 'lib', 'bridge', 'permission-broker.js'),
  path.join(base, 'src', 'lib', 'bridge', 'permission-broker.ts'),
];

for (const filePath of brokerFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('BUTTONS_REMOVED_BY_KIRO_TO_IM')) {
    console.log(`[patch] ${path.basename(filePath)} buttons already removed`);
    continue;
  }

  // Remove inlineButtons from permission cards
  // Match multiline inlineButtons block with any indentation
  const removed = content.replace(
    /inlineButtons\s*:\s*\[[\s\S]*?(?:\]\s*,?\s*\]\s*,)/g,
    '// BUTTONS_REMOVED_BY_KIRO_TO_IM: inline buttons removed (cause Feishu API errors).'
  );
  if (removed !== content) {
    fs.writeFileSync(filePath, removed, 'utf-8');
    console.log(`[patch] ${path.basename(filePath)}: Permission buttons removed`);
    totalPatched++;
  }
}

console.log(`[patch] Done: ${totalPatched} file(s) patched`);
