#!/usr/bin/env node
/**
 * Patch: disable CardKit streaming cards in feishu-adapter.
 *
 * CardKit v2 doesn't exist in @larksuiteoapi/node-sdk <= 1.59.0,
 * and CardKit v1 has a different API format ("body is nil" error).
 *
 * We disable streaming cards entirely by making createStreamingCard()
 * return false immediately. The bridge-manager falls back to sending
 * the final response as a regular text message.
 *
 * IMPORTANT: Must patch BOTH dist/ (.js) AND src/ (.ts) because
 * esbuild resolves from dist/ (the package.json "main" field).
 *
 * Run after `npm install`:
 *   node scripts/patch-cardkit.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const PATCH_MARKER = 'PATCHED_BY_KIRO_TO_IM';

const filesToPatch = [
  // dist/ JS — this is what esbuild actually bundles
  path.join(import.meta.dirname || '.', '..', 'node_modules', 'claude-to-im', 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
  // src/ TS — patch this too for tsc/typecheck
  path.join(import.meta.dirname || '.', '..', 'node_modules', 'claude-to-im', 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
];

let totalPatched = 0;

for (const filePath of filesToPatch) {
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-cardkit] ${path.basename(filePath)} not found, skipping`);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch-cardkit] ${path.basename(filePath)} already patched`);
    continue;
  }

  // Pattern: find createStreamingCard method and inject early return
  // Works for both .ts (with `private`) and .js (without)
  const patterns = [
    // TypeScript: private createStreamingCard(...)
    /(\s*)(private\s+)?createStreamingCard\s*\([^)]*\)\s*(?::\s*Promise<boolean>\s*)?\{/,
    // JavaScript: createStreamingCard(...)
    /(\s*)createStreamingCard\s*\([^)]*\)\s*\{/,
  ];

  let patched = false;
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const indent = match[1] || '  ';
      const original = match[0];
      const replacement = original + `\n${indent}  // ${PATCH_MARKER}: Disable CardKit streaming cards.\n${indent}  // CardKit v2 not in SDK, v1 has incompatible format. Fallback to regular messages.\n${indent}  return Promise.resolve(false);`;
      content = content.replace(original, replacement);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`[patch-cardkit] Patched ${path.basename(filePath)}: createStreamingCard() → always returns false`);
      patched = true;
      totalPatched++;
      break;
    }
  }

  if (!patched) {
    console.log(`[patch-cardkit] ${path.basename(filePath)}: createStreamingCard pattern not found`);
  }
}

if (totalPatched > 0) {
  console.log(`[patch-cardkit] Done: ${totalPatched} file(s) patched`);
} else {
  console.log('[patch-cardkit] No files needed patching');
}
