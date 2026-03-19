/**
 * Daemon entry point for kiro-to-im v2.
 *
 * Architecture: acp-link style — no session lock, spawn per message.
 *   - Adapter(s) listen for IM messages
 *   - Router receives messages and spawns independent handlers
 *   - Each handler: createReply → preparePrompt → streamAcp → updateReply
 *   - Worker pool with consistent hash routing
 *   - No claude-to-im dependency
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { loadConfig, KTI_HOME } from './config.js';
import type { Config } from './config.js';
import { setupLogger } from './logger.js';
import { MessageRouter } from './router.js';
import { createAdapter } from './adapters/index.js';
import { startMcpServer } from './mcp-server.js';

// Register all adapters (side-effect import)
import './adapters/index.js';

const RUNTIME_DIR = path.join(KTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
  version?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

/**
 * Resolve kiro-cli executable path.
 */
function resolveKiroCliPath(config: Config): string {
  if (config.kiroCliPath) return config.kiroCliPath;
  const fromEnv = process.env.KTI_KIRO_CLI_PATH;
  if (fromEnv) return fromEnv;

  const candidates = [
    `${process.env.HOME}/.local/bin/kiro-cli`,
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
    `${process.env.HOME}/.npm-global/bin/kiro-cli`,
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }

  return 'kiro-cli';
}

/**
 * Pre-flight auth check.
 */
function checkKiroAuth(kiroCliPath: string): { ok: boolean; method: string; detail: string } {
  // Strategy 1: `kiro-cli auth status`
  try {
    const out = execFileSync(kiroCliPath, ['auth', 'status'], {
      timeout: 10_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = (out || '').toLowerCase();
    if (text.includes('logged in') || text.includes('authenticated') || text.includes('valid')) {
      return { ok: true, method: 'kiro-cli auth status', detail: out.trim() };
    }
  } catch { /* fall through */ }

  // Strategy 2: Check SQLite database
  const home = process.env.HOME || '';
  const dbPaths = [
    path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3'),
    path.join(home, '.config', 'kiro-cli', 'data.sqlite3'),
  ];

  for (const dbPath of dbPaths) {
    try {
      const stat = fs.statSync(dbPath);
      if (stat.size > 0) {
        return { ok: true, method: 'SQLite database', detail: dbPath };
      }
    } catch { /* not found */ }
  }

  // Strategy 3: AWS credentials
  const hasAwsCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  if (hasAwsCreds) {
    return { ok: true, method: 'AWS credentials', detail: 'env vars' };
  }

  return { ok: false, method: 'none detected', detail: 'Run: kiro-cli auth login' };
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[kiro-to-im] v2 starting (run_id: ${runId})`);
  console.log(`[kiro-to-im] Architecture: acp-link style (no session lock, spawn per message)`);

  const kiroCliPath = resolveKiroCliPath(config);
  const kiroArgs = config.kiroArgs || ['acp'];
  console.log(`[kiro-to-im] kiro-cli: ${kiroCliPath} ${kiroArgs.join(' ')}`);

  // Pre-flight auth check
  const authCheck = checkKiroAuth(kiroCliPath);
  if (authCheck.ok) {
    console.log(`[kiro-to-im] Auth OK (method: ${authCheck.method})`);
  } else {
    console.warn(
      `[kiro-to-im] WARNING: No auth detected. Fix: kiro-cli auth login\n` +
      `  Detail: ${authCheck.detail}`,
    );
  }

  // Build extra env vars for kiro-cli
  const extraEnv: Record<string, string> = {};
  if (config.awsAccessKeyId) extraEnv.AWS_ACCESS_KEY_ID = config.awsAccessKeyId;
  if (config.awsSecretAccessKey) extraEnv.AWS_SECRET_ACCESS_KEY = config.awsSecretAccessKey;
  if (config.awsSessionToken) extraEnv.AWS_SESSION_TOKEN = config.awsSessionToken;
  if (config.awsRegion) extraEnv.AWS_REGION = config.awsRegion;
  if (config.awsProfile) extraEnv.AWS_PROFILE = config.awsProfile;

  // Create router
  const router = new MessageRouter({
    kiroCmd: kiroCliPath,
    kiroArgs,
    poolSize: config.kiroPoolSize,
    cwd: config.defaultWorkDir,
    autoApprove: config.autoApprove ?? false,
    extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    sessionRetention: 30, // 30 days
  });

  // Initialize worker pool
  try {
    await router.initialize();
    console.log(`[kiro-to-im] Worker pool initialized (size: ${config.kiroPoolSize})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[kiro-to-im] FATAL: Worker pool init failed: ${errMsg}`);
    console.error(`  Fix: 1) kiro-cli auth login  2) Check path: ${kiroCliPath}`);
    process.exit(1);
  }

  // Register and validate adapters
  const enabledChannels = config.enabledChannels;
  if (enabledChannels.length === 0) {
    console.error('[kiro-to-im] FATAL: No channels enabled. Set KTI_ENABLED_CHANNELS=feishu,discord,...');
    process.exit(1);
  }

  for (const channelName of enabledChannels) {
    const adapter = createAdapter(channelName);
    if (!adapter) {
      console.warn(`[kiro-to-im] Unknown adapter: ${channelName}, skipping`);
      continue;
    }

    const validationError = adapter.validateConfig();
    if (validationError) {
      console.warn(`[kiro-to-im] Adapter ${channelName} config invalid: ${validationError}, skipping`);
      continue;
    }

    router.registerAdapter(adapter);
  }

  // Start embedded MCP Server if Feishu credentials are available
  if (config.feishuAppId && config.feishuAppSecret) {
    const mcpPort = parseInt(process.env.KTI_MCP_PORT || '9800', 10);
    try {
      await startMcpServer(
        config.feishuAppId,
        config.feishuAppSecret,
        config.feishuDomain || 'https://open.feishu.cn',
        mcpPort,
      );
      console.log(`[kiro-to-im] MCP Server on port ${mcpPort} (feishu_send_file tool)`);
    } catch (err) {
      console.warn(`[kiro-to-im] MCP Server failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // Start all adapters
  await router.startAdapters();

  // Write runtime status
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  writeStatus({
    running: true,
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
    channels: enabledChannels,
    version: '2.0.0',
  });

  console.log(
    `[kiro-to-im] Bridge started (PID: ${process.pid}, channels: ${enabledChannels.join(', ')})`,
  );

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[kiro-to-im] Shutting down (${reason})...`);

    await router.shutdown();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[kiro-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[kiro-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });

  // Keepalive (prevent Node.js from exiting)
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[kiro-to-im] Fatal:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
