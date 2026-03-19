import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We test SessionMap by setting KTI_HOME to a temp dir
describe('SessionMap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kti-session-test-'));
    process.env.KTI_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.KTI_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert and getSessionId round-trip', async () => {
    // Dynamic import to pick up the KTI_HOME override
    const mod = await import('../session-map.js');
    const map = new mod.SessionMap();

    map.insert('thread-1', 'session-abc');
    assert.equal(map.getSessionId('thread-1'), 'session-abc');
    assert.equal(map.getSessionId('thread-2'), undefined);
  });

  it('mapThread and getThreadId round-trip', async () => {
    const mod = await import('../session-map.js');
    const map = new mod.SessionMap();

    map.mapThread('msg-123', 'thread-456');
    assert.equal(map.getThreadId('msg-123'), 'thread-456');
    assert.equal(map.getThreadId('msg-999'), undefined);
  });

  it('tracks size correctly', async () => {
    const mod = await import('../session-map.js');
    const map = new mod.SessionMap();

    assert.equal(map.size, 0);
    map.insert('k1', 'v1');
    assert.equal(map.size, 1);
    map.insert('k2', 'v2');
    assert.equal(map.size, 2);
  });
});
