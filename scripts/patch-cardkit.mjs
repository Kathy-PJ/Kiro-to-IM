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
  // Also patch bridge-manager for the isNumericPermissionShortcut fix
  path.join(base, 'dist', 'lib', 'bridge', 'bridge-manager.js'),
  path.join(base, 'src', 'lib', 'bridge', 'bridge-manager.ts'),
];

for (const filePath of brokerFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('BUTTONS_REMOVED_BY_KIRO_TO_IM')) {
    console.log(`[patch] ${path.basename(filePath)} buttons already removed`);
    continue;
  }

  // Remove inlineButtons from permission cards and add text reply instructions
  let modified = content;

  // Remove inlineButtons block
  modified = modified.replace(
    /inlineButtons\s*:\s*\[[\s\S]*?(?:\]\s*,?\s*\]\s*,)/g,
    '// BUTTONS_REMOVED_BY_KIRO_TO_IM: inline buttons removed (cause Feishu API errors).'
  );

  // Add reply instructions to the permission message text (for non-QQ platforms)
  // Find: `Choose an action:` and append reply instructions after it
  modified = modified.replace(
    /(`Choose an action:`)/g,
    '`Choose an action:\\n\\nReply: 1 Allow · 2 Allow Session · 3 Deny`'
  );

  // Patch 3: Enable numeric permission shortcuts for ALL platforms (not just feishu/qq)
  // Upstream only routes "1/2/3" text replies via non-session-locked path for feishu/qq.
  // Discord/Telegram use inline buttons instead, but we removed buttons.
  // Without this patch, Discord "1/2/3" replies deadlock on the session lock.
  // Match both formats:
  //   src (.ts): channelType !== 'feishu' && channelType !== 'qq'
  //   dist (.js): adapter.channelType === 'feishu' || adapter.channelType === 'qq'
  const shortcutPatterns = [
    // src format (isNumericPermissionShortcut function)
    /channelType\s*!==\s*['"]feishu['"]\s*&&\s*channelType\s*!==\s*['"]qq['"]/g,
    // dist format (inline check in handleIncomingEvent)
    /adapter\.channelType\s*===\s*['"]feishu['"]\s*\|\|\s*adapter\.channelType\s*===\s*['"]qq['"]/g,
  ];
  let shortcutPatched = false;
  for (const pattern of shortcutPatterns) {
    if (pattern.test(modified)) {
      modified = modified.replace(pattern, (match) => {
        if (match.includes('!==')) {
          // src format: condition that returns false for non-feishu/qq → always false
          return 'false /* PATCHED_SHORTCUT_BY_KIRO_TO_IM */';
        } else {
          // dist format: condition that matches feishu/qq → always true
          return 'true /* PATCHED_SHORTCUT_BY_KIRO_TO_IM: enable for all platforms */';
        }
      });
      shortcutPatched = true;
    }
  }
  if (shortcutPatched) {
    console.log(`[patch] ${path.basename(filePath)}: Enabled permission shortcuts for all platforms`);
  }

  if (modified !== content) {
    fs.writeFileSync(filePath, modified, 'utf-8');
    console.log(`[patch] ${path.basename(filePath)}: Permission buttons removed`);
    totalPatched++;
  }
}

console.log(`[patch] Done: ${totalPatched} file(s) patched`);
