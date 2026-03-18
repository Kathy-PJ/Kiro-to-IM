/**
 * Daemon entry point for kiro-to-im.
 *
 * Assembles all DI implementations and starts the bridge,
 * using kiro-cli via ACP protocol as the AI agent backend.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';

import { loadConfig, configToSettings, KTI_HOME } from './config.js';
import { JsonFileStore } from './store.js';
import { KiroAcpProvider } from './kiro-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

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
 * Priority:
 *   1. KTI_KIRO_CLI_PATH env var
 *   2. `kiro-cli` in PATH
 *   3. Common install locations
 */
function resolveKiroCliPath(): string {
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

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[kiro-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();

  const kiroCliPath = resolveKiroCliPath();
  const kiroArgs = config.kiroArgs || ['acp'];

  console.log(`[kiro-to-im] Using kiro-cli: ${kiroCliPath} ${kiroArgs.join(' ')}`);

  const provider = new KiroAcpProvider(
    {
      cmd: kiroCliPath,
      args: kiroArgs,
      poolSize: config.kiroPoolSize,
      cwd: config.defaultWorkDir,
      autoApprove: config.autoApprove ?? false,
    },
    pendingPerms,
  );

  try {
    await provider.initialize();
    console.log(`[kiro-to-im] Kiro ACP provider initialized (pool_size: ${config.kiroPoolSize})`);
  } catch (err) {
    console.error(
      `[kiro-to-im] FATAL: Failed to initialize kiro-cli ACP connection.\n` +
      `  Path: ${kiroCliPath}\n` +
      `  Args: ${kiroArgs.join(' ')}\n` +
      `  Error: ${err instanceof Error ? err.message : err}\n` +
      `  Fix:\n` +
      `    1. Install kiro-cli: https://kiro.dev/\n` +
      `    2. Verify: kiro-cli --version\n` +
      `    3. Set KTI_KIRO_CLI_PATH=/path/to/kiro-cli if not in PATH`,
    );
    process.exit(1);
  }

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm: provider,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[kiro-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[kiro-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[kiro-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await provider.shutdown();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[kiro-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[kiro-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });

  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[kiro-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
