#!/usr/bin/env node
/**
 * ACP Method Discovery Tool
 *
 * Connects to kiro-cli via ACP and tests various method names
 * to discover which ones are supported by the installed version.
 *
 * Usage: node scripts/discover-methods.mjs [kiro-cli-path]
 */

import { spawn } from 'node:child_process';

const kiroCmd = process.argv[2] || 'kiro-cli';
const kiroArgs = ['acp'];

let nextId = 1;
let buffer = '';

function encode(msg) {
  return JSON.stringify(msg) + '\n';
}

function sendRequest(proc, method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params: params || {} };
  console.log(`→ [${id}] ${method}`, JSON.stringify(params || {}).slice(0, 100));
  proc.stdin.write(encode(msg));
  return id;
}

console.log(`Starting kiro-cli: ${kiroCmd} ${kiroArgs.join(' ')}\n`);

const proc = spawn(kiroCmd, kiroArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
});

proc.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text) console.log(`[stderr] ${text}`);
});

proc.stdout.on('data', (data) => {
  buffer += data.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.error) {
        console.log(`← [${msg.id}] ERROR: ${msg.error.message} (code: ${msg.error.code})`);
      } else if (msg.result !== undefined) {
        console.log(`← [${msg.id}] OK:`, JSON.stringify(msg.result).slice(0, 200));
      } else if (msg.method) {
        console.log(`← NOTIFICATION: ${msg.method}`, JSON.stringify(msg.params || {}).slice(0, 100));
      }
    } catch { }
  }
});

proc.on('exit', (code) => {
  console.log(`\nkiro-cli exited with code ${code}`);
  process.exit(0);
});

// Phase 1: Initialize
await new Promise(r => setTimeout(r, 1000));
sendRequest(proc, 'initialize', {
  protocolVersion: '2025-01-01',
  clientInfo: { name: 'acp-discover', version: '0.1.0' },
});

await new Promise(r => setTimeout(r, 3000));

// Phase 2: Try every possible session method name
console.log('\n--- Testing session creation methods ---\n');

const sessionMethods = [
  // Official schema
  ['sessions/new', { cwd: '/tmp' }],
  ['sessions/create', { cwd: '/tmp' }],
  ['sessions/start', { cwd: '/tmp' }],
  // camelCase variants
  ['sessionsNew', { cwd: '/tmp' }],
  ['sessionsCreate', { cwd: '/tmp' }],
  // snake_case variants
  ['sessions_new', { cwd: '/tmp' }],
  ['sessions_create', { cwd: '/tmp' }],
  ['new_session', { cwd: '/tmp' }],
  ['create_session', { cwd: '/tmp' }],
  // Flat
  ['newSession', { cwd: '/tmp' }],
  ['createSession', { cwd: '/tmp' }],
  // With workingDirectory instead of cwd
  ['sessions/new', { workingDirectory: '/tmp' }],
  ['newSession', { workingDirectory: '/tmp' }],
  // agent prefix
  ['agent/newSession', { cwd: '/tmp' }],
  ['agent/sessions/new', { cwd: '/tmp' }],
  // Other variants
  ['session/new', { cwd: '/tmp' }],
  ['session/create', { cwd: '/tmp' }],
];

for (const [method, params] of sessionMethods) {
  sendRequest(proc, method, params);
  await new Promise(r => setTimeout(r, 500));
}

// Phase 3: Try prompt methods (in case session is auto-created)
console.log('\n--- Testing prompt methods ---\n');

const promptMethods = [
  ['sessions/prompt', { sessionId: 'test', prompt: [{ type: 'text', text: 'hi' }] }],
  ['sessions/chat', { sessionId: 'test', prompt: [{ type: 'text', text: 'hi' }] }],
  ['prompt', { sessionId: 'test', prompt: [{ type: 'text', text: 'hi' }] }],
  ['chat', { prompt: [{ type: 'text', text: 'hi' }] }],
  ['sendMessage', { message: 'hi' }],
  ['send', { content: [{ type: 'text', text: 'hi' }] }],
];

for (const [method, params] of promptMethods) {
  sendRequest(proc, method, params);
  await new Promise(r => setTimeout(r, 500));
}

// Wait for responses then exit
await new Promise(r => setTimeout(r, 5000));
console.log('\n--- Discovery complete ---');
proc.kill('SIGTERM');
