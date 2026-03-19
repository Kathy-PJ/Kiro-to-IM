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

// ── Patch 1: Replace CardKit streaming cards with native REST API ──
// Instead of disabling streaming cards entirely, replace the CardKit-based
// implementation with acp-link's approach: im/v1/messages reply + PATCH update.
// This gives real-time streaming text in Feishu without CardKit dependency.

const adapterFiles = [
  path.join(base, 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
  path.join(base, 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
];

// The native createStreamingCard implementation using im/v1/messages API
const nativeCreateStreamingCard = `
    // ${PATCH_MARKER}: Native streaming card using im/v1/messages API (like acp-link).
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);
    const _existing = this.cardCreatePromises.get(chatId);
    if (_existing) return _existing;

    const _promise = (async () => {
      try {
        const _tokenResp = await this.restClient.auth.v3.tenantAccessToken.internal({
          data: { app_id: this.restClient.appId, app_secret: this.restClient.appSecret },
        });
        const _token = _tokenResp?.tenant_access_token;
        if (!_token) { console.warn('[feishu-adapter] No token for streaming card'); return false; }

        const _cardContent = JSON.stringify({ elements: [{ tag: 'markdown', content: '...' }] });
        const _domain = this.restClient.domain || 'https://open.feishu.cn';
        const _apiBase = _domain.includes('/open-apis') ? _domain : _domain + '/open-apis';
        const _replyUrl = _apiBase + '/im/v1/messages/' + (replyToMessageId || '') + '/reply';

        const _resp = await fetch(_replyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token },
          body: JSON.stringify({ content: _cardContent, msg_type: 'interactive' }),
        });
        const _data = await _resp.json();
        if (_data.code !== 0) { console.warn('[feishu-adapter] replyCard failed:', _data.msg); return false; }

        const _messageId = _data.data?.message_id || '';
        if (!_messageId) return false;

        this.activeCards.set(chatId, {
          cardId: 'native-' + _messageId, messageId: _messageId,
          accumulatedText: '', toolsSummary: '', throttleTimer: null,
          _nativeToken: _token, _nativeApiBase: _apiBase,
        });
        console.log('[feishu-adapter] Streaming card created (native):', _messageId);
        return true;
      } catch (_err) {
        console.warn('[feishu-adapter] Native streaming card failed:', _err?.message || _err);
        return false;
      } finally { this.cardCreatePromises.delete(chatId); }
    })();
    this.cardCreatePromises.set(chatId, _promise);
    return _promise;`;

// The native updateCardContent implementation
const nativeUpdateCardContent = `
    // ${PATCH_MARKER}: Native PATCH update (like acp-link's update_card).
    const _state = this.activeCards.get(chatId);
    if (!_state) return;
    _state.accumulatedText = text;
    if (_state.throttleTimer) return;
    _state.throttleTimer = setTimeout(async () => {
      _state.throttleTimer = null;
      const _s = this.activeCards.get(chatId);
      if (!_s || !_s._nativeToken) return;
      const _cc = JSON.stringify({ elements: [{ tag: 'markdown', content: _s.accumulatedText || '...' }] });
      try {
        await fetch(_s._nativeApiBase + '/im/v1/messages/' + _s.messageId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _s._nativeToken },
          body: JSON.stringify({ content: _cc, msg_type: 'interactive' }),
        });
      } catch (_e) { console.warn('[feishu-adapter] Native updateCard failed:', _e?.message || _e); }
    }, 300);
    return;`;

for (const filePath of adapterFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch] ${path.basename(filePath)} already patched`);
    continue;
  }

  // Replace createStreamingCard method body
  const createPatterns = [
    /(\s*)(private\s+)?createStreamingCard\s*\([^)]*\)\s*(?::\s*Promise<boolean>\s*)?\{/,
    /(\s*)createStreamingCard\s*\([^)]*\)\s*\{/,
  ];

  let patched = false;
  for (const pattern of createPatterns) {
    const match = content.match(pattern);
    if (match) {
      content = content.replace(match[0], match[0] + '\n' + nativeCreateStreamingCard + '\n    // --- Original CardKit code below (unreachable) ---');
      patched = true;
      break;
    }
  }

  // Replace updateCardContent method body
  const updatePatterns = [
    /(\s*)(private\s+)?updateCardContent\s*\([^)]*\)\s*(?::\s*void\s*)?\{/,
    /(\s*)updateCardContent\s*\([^)]*\)\s*\{/,
  ];

  for (const pattern of updatePatterns) {
    const match = content.match(pattern);
    if (match) {
      content = content.replace(match[0], match[0] + '\n' + nativeUpdateCardContent + '\n    return;\n    // --- Original CardKit code below (unreachable) ---');
      break;
    }
  }

  if (patched) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`[patch] ${path.basename(filePath)}: Native streaming cards enabled (im/v1/messages API)`);
    totalPatched++;
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
