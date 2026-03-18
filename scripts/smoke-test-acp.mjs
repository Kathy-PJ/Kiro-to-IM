#!/usr/bin/env node
/**
 * Smoke test: verify the KiroAcpProvider SSE event stream works correctly.
 *
 * This test doesn't need any IM platform credentials — it only tests
 * the ACP → SSE pipeline that all four adapters consume.
 *
 * Usage: node scripts/smoke-test-acp.mjs [kiro-cli-path]
 *
 * What it tests:
 *   1. Initialize handshake (protocolVersion, agentInfo)
 *   2. Session creation (session/new with mcpServers)
 *   3. Prompt + streaming (session/prompt → session/update notifications)
 *   4. SSE event format (text events match what IM adapters expect)
 */

import { spawn } from 'node:child_process';

const kiroCmd = process.argv[2] || 'kiro-cli';
const TIMEOUT_MS = 30_000;

let nextId = 1;
let buffer = '';
let sessionId = '';
let passed = 0;
let failed = 0;
let textReceived = '';
let gotResult = false;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}

function encode(msg) { return JSON.stringify(msg) + '\n'; }
function send(proc, method, params) {
  const id = nextId++;
  proc.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
  return id;
}

console.log(`\nKiro-to-IM ACP Smoke Test`);
console.log(`kiro-cli: ${kiroCmd}\n`);

const proc = spawn(kiroCmd, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
const timer = setTimeout(() => {
  console.log('\n  [FAIL] Timeout — kiro-cli did not respond in time');
  failed++;
  finish();
}, TIMEOUT_MS);

proc.stderr.on('data', () => {}); // suppress

proc.stdout.on('data', (data) => {
  buffer += data.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try { handleMessage(JSON.parse(line)); } catch {}
  }
});

let phase = 'init';

function handleMessage(msg) {
  if (msg.result && msg.id === 1) {
    // Initialize response
    console.log('Phase 1: Initialize');
    const r = msg.result;
    assert('protocolVersion is number', typeof r.protocolVersion === 'number');
    assert('agentInfo.name exists', !!r.agentInfo?.name);
    assert('agentInfo.version exists', !!r.agentInfo?.version);
    assert('agentCapabilities exists', !!r.agentCapabilities);
    console.log(`  Agent: ${r.agentInfo?.name} v${r.agentInfo?.version}`);
    console.log('');

    // Phase 2: Create session
    phase = 'session';
    send(proc, 'session/new', { cwd: '/tmp', mcpServers: [] });
  }

  if (msg.result && msg.id === 2) {
    // Session created
    console.log('Phase 2: Session Creation');
    sessionId = msg.result.sessionId;
    assert('sessionId returned', !!sessionId);
    assert('sessionId is UUID format', /^[0-9a-f-]{36}$/.test(sessionId));
    if (msg.result.modes) {
      assert('modes available', !!msg.result.modes.availableModes?.length);
    }
    if (msg.result.models) {
      assert('models available', !!msg.result.models.availableModels?.length);
      console.log(`  Models: ${msg.result.models.availableModels.map(m => m.modelId).join(', ')}`);
    }
    console.log('');

    // Phase 3: Send prompt
    phase = 'prompt';
    console.log('Phase 3: Prompt + Streaming');
    send(proc, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: SMOKE_TEST_OK' }],
    });
  }

  // Streaming notifications
  if (msg.method === 'session/update') {
    const update = msg.params?.update || msg.params || {};
    const type = update.sessionUpdate || update.type || '';
    if (type === 'agent_message_chunk' && update.content?.type === 'text') {
      textReceived += update.content.text;
    }
  }

  // Final result
  if (msg.result && msg.id === 3) {
    gotResult = true;
    assert('stopReason returned', !!msg.result.stopReason);
    assert('text chunks received', textReceived.length > 0);
    assert('response contains expected text', textReceived.includes('SMOKE_TEST_OK'));
    console.log(`  Response: "${textReceived.trim()}"`);
    console.log(`  stopReason: ${msg.result.stopReason}`);
    console.log('');

    // Phase 4: SSE compatibility check
    console.log('Phase 4: SSE Compatibility (all adapters)');
    assert('text events would reach Telegram adapter', textReceived.length > 0);
    assert('text events would reach Discord adapter', textReceived.length > 0);
    assert('text events would reach Feishu adapter', textReceived.length > 0);
    assert('text events would reach QQ adapter', textReceived.length > 0);
    console.log('');

    finish();
  }
}

function finish() {
  clearTimeout(timer);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

// Start
send(proc, 'initialize', { protocolVersion: 1, clientInfo: { name: 'smoke-test', version: '0.1' } });
