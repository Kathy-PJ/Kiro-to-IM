#!/usr/bin/env node
/**
 * Post-install patches for kiro-to-im.
 *
 * 1. Native Feishu streaming cards (im/v1/messages reply + PATCH, like acp-link)
 * 2. Remove inline permission buttons (cause Feishu API errors)
 * 3. Enable numeric permission shortcuts for all platforms
 *
 * Must patch BOTH dist/ (.js) AND src/ (.ts) because
 * esbuild resolves from dist/ (the package.json "main" field).
 */

import fs from 'node:fs';
import path from 'node:path';

const PATCH_MARKER = 'PATCHED_BY_KIRO_TO_IM';
const base = path.join(import.meta.dirname || '.', '..', 'node_modules', 'claude-to-im');

let totalPatched = 0;

// ── Patch 1: Native Feishu streaming via im/v1/messages API ──
// Replace onStreamText + onStreamEnd to use native REST API instead of CardKit.
// onStreamEnd returns true → bridge-manager skips fallback message (no duplicates).

const adapterFiles = [
  path.join(base, 'dist', 'lib', 'bridge', 'adapters', 'feishu-adapter.js'),
  path.join(base, 'src', 'lib', 'bridge', 'adapters', 'feishu-adapter.ts'),
];

// Self-contained native streaming module injected at the end of the file.
// Uses global fetch (Node 18+), no external deps.
const nativeStreamingModule = `
// ── ${PATCH_MARKER}: Native Feishu Streaming (like acp-link) ──
// Replaces CardKit streaming with im/v1/messages reply + PATCH update.

const _STREAM_UPDATE_INTERVAL = 300; // ms
const _nativeCards = new Map(); // chatId → { messageId, token, apiBase, text, timer, inflightDone }
const _cardCreating = new Set(); // chatId set — prevents duplicate card creation
const _cardPromises = new Map(); // chatId → Promise — for onStreamEnd to await

async function _getNativeToken(restClient) {
  try {
    // Use SDK's built-in token management
    const resp = await restClient.auth?.v3?.tenantAccessToken?.internal?.({
      data: { app_id: restClient.appId || '', app_secret: restClient.appSecret || '' },
    });
    return resp?.tenant_access_token || null;
  } catch { return null; }
}

async function _nativeReplyCard(token, apiBase, messageId, markdown) {
  const card = JSON.stringify({ elements: [{ tag: 'markdown', content: markdown }] });
  const resp = await fetch(apiBase + '/im/v1/messages/' + messageId + '/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ content: card, msg_type: 'interactive' }),
  });
  const data = await resp.json();
  return data.code === 0 ? (data.data?.message_id || '') : '';
}

async function _nativeUpdateCard(token, apiBase, messageId, markdown) {
  const card = JSON.stringify({ elements: [{ tag: 'markdown', content: markdown }] });
  await fetch(apiBase + '/im/v1/messages/' + messageId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ content: card, msg_type: 'interactive' }),
  }).catch(() => {});
}
`;

for (const filePath of adapterFiles) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch] ${path.basename(filePath)} already patched`);
    continue;
  }

  let patched = false;

  // 1a. Disable createStreamingCard (native cards are created lazily in onStreamText)
  const createPatterns = [
    /(\s*)(private\s+)?createStreamingCard\s*\([^)]*\)\s*(?::\s*Promise<boolean>\s*)?\{/,
    /(\s*)createStreamingCard\s*\([^)]*\)\s*\{/,
  ];
  for (const p of createPatterns) {
    const m = content.match(p);
    if (m) {
      content = content.replace(m[0], m[0] + `\n    // ${PATCH_MARKER}: CardKit disabled, using native streaming.\n    return Promise.resolve(false);`);
      patched = true;
      break;
    }
  }

  // 1b. Replace onStreamText with native implementation
  const streamTextPattern = /(onStreamText\s*\([^)]*\)\s*(?::\s*void\s*)?\{)/;
  const streamTextMatch = content.match(streamTextPattern);
  if (streamTextMatch) {
    content = content.replace(streamTextMatch[0], streamTextMatch[0] + `
    // ${PATCH_MARKER}: Native streaming via im/v1/messages PATCH
    const _chatId = arguments[0], _fullText = arguments[1];
    const _existing = _nativeCards.get(_chatId);
    if (!_existing) {
      // First text chunk — create card (with creation lock to prevent duplicates)
      if (_cardCreating.has(_chatId)) return; // Already creating
      const _replyTo = this.lastIncomingMessageId?.get(_chatId);
      if (_replyTo && this.restClient) {
        _cardCreating.add(_chatId);
        const _createPromise = (async () => {
          const _tk = await _getNativeToken(this.restClient);
          if (!_tk) { _cardCreating.delete(_chatId); return; }
          const _domain = this.restClient?.domain || 'https://open.feishu.cn';
          const _ab = _domain.includes('/open-apis') ? _domain : _domain + '/open-apis';
          const _mid = await _nativeReplyCard(_tk, _ab, _replyTo, _fullText.trim() || '...');
          _cardCreating.delete(_chatId);
          if (_mid) {
            _nativeCards.set(_chatId, { messageId: _mid, token: _tk, apiBase: _ab, text: _fullText, timer: null, inflightDone: true });
            console.log('[feishu-streaming] Card created:', _mid);
          }
        })().catch(() => { _cardCreating.delete(_chatId); });
        _cardPromises.set(_chatId, _createPromise);
      }
      return;
    }
    // Subsequent chunks — throttled PATCH update
    _existing.text = _fullText;
    if (!_existing.timer && _existing.inflightDone) {
      _existing.timer = setTimeout(async () => {
        _existing.timer = null;
        _existing.inflightDone = false;
        await _nativeUpdateCard(_existing.token, _existing.apiBase, _existing.messageId, _existing.text.trim() || '...');
        _existing.inflightDone = true;
      }, _STREAM_UPDATE_INTERVAL);
    }
    return;
    // --- Original onStreamText below (unreachable) ---`);
    patched = true;
  }

  // 1c. Replace onStreamEnd to finalize native card and return true
  const streamEndPattern = /((?:async\s+)?onStreamEnd\s*\([^)]*\)\s*(?::\s*Promise<boolean>\s*)?\{)/;
  const streamEndMatch = content.match(streamEndPattern);
  if (streamEndMatch) {
    content = content.replace(streamEndMatch[0], streamEndMatch[0] + `
    // ${PATCH_MARKER}: Finalize native streaming card
    const _cid = arguments[0], _status = arguments[1], _responseText = arguments[2];
    // Wait for card creation to finish (fixes race condition)
    const _createProm = _cardPromises.get(_cid);
    if (_createProm) { await _createProm; _cardPromises.delete(_cid); }
    const _card = _nativeCards.get(_cid);
    if (_card) {
      if (_card.timer) { clearTimeout(_card.timer); _card.timer = null; }
      // Final update with complete text
      const _finalText = (_responseText || _card.text || '').trim() || '(no response)';
      await _nativeUpdateCard(_card.token, _card.apiBase, _card.messageId, _finalText);
      _nativeCards.delete(_cid);
      console.log('[feishu-streaming] Card finalized');
      return true; // Tell bridge-manager: card handled, skip fallback message
    }
    return false; // No native card — let bridge-manager send fallback
    // --- Original onStreamEnd below (unreachable) ---`);
    patched = true;
  }

  if (patched) {
    // Append the native streaming helper functions
    content += '\n' + nativeStreamingModule;
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`[patch] ${path.basename(filePath)}: Native Feishu streaming enabled`);
    totalPatched++;
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
    console.log(`[patch] ${path.basename(filePath)} buttons already removed`);
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
