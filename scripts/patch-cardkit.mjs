#!/usr/bin/env node
/**
 * Post-install patches for kiro-to-im.
 *
 * 1. Disable CardKit streaming cards (stable fallback: complete text message)
 * 2. Remove inline permission buttons (cause Feishu API errors)
 * 3. Enable numeric permission shortcuts for all platforms
 */

import fs from 'node:fs';
import path from 'node:path';

const PATCH_MARKER = 'PATCHED_BY_KIRO_TO_IM';
const base = path.join(import.meta.dirname || '.', '..', 'node_modules', 'claude-to-im');

let totalPatched = 0;

// ── Patch 1: Disable CardKit streaming cards ──
// Simply return false from createStreamingCard. Bridge-manager sends
// the complete response as a regular text message. This is stable and
// avoids all race conditions with native streaming card patches.

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
      content = content.replace(match[0],
        match[0] + `\n    // ${PATCH_MARKER}: Disable streaming cards. Bridge-manager sends final text.\n    return Promise.resolve(false);`
      );
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`[patch] ${path.basename(filePath)}: Streaming cards disabled`);
      totalPatched++;
      break;
    }
  }
}

// ── Patch 2: Remove inline permission buttons + add text instructions ──

const brokerFiles = [
  path.join(base, 'dist', 'lib', 'bridge', 'permission-broker.js'),
  path.join(base, 'src', 'lib', 'bridge', 'permission-broker.ts'),
  path.join(base, 'dist', 'lib', 'bridge', 'bridge-manager.js'),
  path.join(base, 'src', 'lib', 'bridge', 'bridge-manager.ts'),
];

for (const filePath of brokerFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('BUTTONS_REMOVED_BY_KIRO_TO_IM')) {
    console.log(`[patch] ${path.basename(filePath)} already patched`);
    continue;
  }

  let modified = content;

  // Remove inlineButtons block
  modified = modified.replace(
    /inlineButtons\s*:\s*\[[\s\S]*?(?:\]\s*,?\s*\]\s*,)/g,
    '// BUTTONS_REMOVED_BY_KIRO_TO_IM: inline buttons removed.'
  );

  // Add text reply instructions
  modified = modified.replace(
    /(`Choose an action:`)/g,
    '`Choose an action:\\n\\nReply: 1 Allow · 2 Allow Session · 3 Deny`'
  );

  // Patch 3: Enable numeric permission shortcuts for ALL platforms
  const shortcutPatterns = [
    /channelType\s*!==\s*['"]feishu['"]\s*&&\s*channelType\s*!==\s*['"]qq['"]/g,
    /adapter\.channelType\s*===\s*['"]feishu['"]\s*\|\|\s*adapter\.channelType\s*===\s*['"]qq['"]/g,
  ];
  for (const pattern of shortcutPatterns) {
    if (pattern.test(modified)) {
      modified = modified.replace(pattern, (match) => {
        return match.includes('!==')
          ? 'false /* PATCHED_SHORTCUT_BY_KIRO_TO_IM */'
          : 'true /* PATCHED_SHORTCUT_BY_KIRO_TO_IM */';
      });
      console.log(`[patch] ${path.basename(filePath)}: Permission shortcuts for all platforms`);
    }
  }

  if (modified !== content) {
    fs.writeFileSync(filePath, modified, 'utf-8');
    console.log(`[patch] ${path.basename(filePath)}: Permission buttons removed`);
    totalPatched++;
  }
}

console.log(`[patch] Done: ${totalPatched} file(s) patched`);
