/**
 * Daemon entry point for kiro-to-im.
 *
 * Assembles all DI implementations and starts the bridge,
 * using kiro-cli via ACP protocol as the AI agent backend.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';

import { loadConfig, configToSettings, KTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { KiroAcpProvider } from './kiro-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { startMcpServer } from './mcp-server.js';

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

/**
 * Pre-flight check: verify kiro-cli is authenticated before starting workers.
 *
 * Kiro CLI stores auth tokens in a SQLite database, NOT plain text files.
 * The database location is platform-specific:
 *   - macOS:  ~/Library/Application Support/kiro-cli/data.sqlite3
 *   - Linux:  ~/.local/share/kiro-cli/data.sqlite3
 *   - Windows: %APPDATA%/kiro-cli/data.sqlite3
 *
 * Common auth methods:
 *   - `kiro-cli auth login` (interactive OAuth → tokens stored in SQLite DB)
 *   - AWS SSO / IAM credentials (env vars or ~/.aws/)
 *   - Environment variables (AWS_ACCESS_KEY_ID, etc.)
 *
 * Detection strategies (in order):
 *   1. `kiro-cli auth status` (if the subcommand exists)
 *   2. Check for kiro-cli SQLite database file (platform-specific paths)
 *   3. Check for AWS credentials (env vars or ~/.aws/credentials)
 *   4. Let ACP initialize handshake be the final validator
 */
function getKiroDataPaths(): string[] {
  const home = process.env.HOME || '';
  const platform = process.platform;
  const paths: string[] = [];

  if (platform === 'darwin') {
    // macOS: ~/Library/Application Support/kiro-cli/
    paths.push(path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'));
  } else if (platform === 'win32') {
    // Windows: %APPDATA%/kiro-cli/
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    paths.push(path.join(appData, 'kiro-cli', 'data.sqlite3'));
  } else {
    // Linux: ~/.local/share/kiro-cli/ (XDG_DATA_HOME)
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    paths.push(path.join(xdgData, 'kiro-cli', 'data.sqlite3'));
  }

  // Also check ~/.config/kiro-cli/ and ~/.kiro/ as fallbacks
  paths.push(
    path.join(home, '.config', 'kiro-cli', 'data.sqlite3'),
    path.join(home, '.kiro', 'data.sqlite3'),
  );

  return paths;
}

function checkKiroAuth(kiroCliPath: string): { ok: boolean; method: string; detail: string } {
  // Strategy 1: `kiro-cli auth status` (may not exist in all versions)
  try {
    const out = execFileSync(kiroCliPath, ['auth', 'status'], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = (out || '').toLowerCase();
    if (text.includes('logged in') || text.includes('authenticated') || text.includes('valid')) {
      return { ok: true, method: 'kiro-cli auth status', detail: out.trim() };
    }
    if (text.includes('not logged in') || text.includes('expired') || text.includes('invalid')) {
      return { ok: false, method: 'kiro-cli auth status', detail: out.trim() };
    }
    // Ambiguous output — don't fail, try other strategies
  } catch {
    // `auth status` subcommand may not exist — fall through
  }

  // Strategy 2: Check for kiro-cli SQLite database (contains auth tokens)
  // Platform-specific paths:
  //   macOS:   ~/Library/Application Support/kiro-cli/data.sqlite3
  //   Linux:   ~/.local/share/kiro-cli/data.sqlite3
  //   Windows: %APPDATA%/kiro-cli/data.sqlite3
  for (const dbPath of getKiroDataPaths()) {
    try {
      const stat = fs.statSync(dbPath);
      if (stat.size > 0) {
        const ageMs = Date.now() - stat.mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        return {
          ok: true,
          method: 'kiro-cli SQLite database',
          detail: `${dbPath} (${Math.floor(ageDays)}d old, ${(stat.size / 1024).toFixed(0)}KB)`,
        };
      }
    } catch { /* not found */ }
  }

  // Strategy 3: Check AWS credentials (Kiro may use AWS-backed auth)
  const hasAwsCreds = !!(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_SESSION_TOKEN ||
    process.env.AWS_PROFILE
  );
  const home = process.env.HOME || '';
  const awsCredsFile = path.join(home, '.aws', 'credentials');
  const hasAwsCredsFile = (() => {
    try { return fs.statSync(awsCredsFile).size > 0; } catch { return false; }
  })();

  if (hasAwsCreds || hasAwsCredsFile) {
    return {
      ok: true,
      method: 'AWS credentials',
      detail: hasAwsCreds ? 'env vars' : awsCredsFile,
    };
  }

  // No auth method detected — warn but don't block
  // The ACP initialize handshake will be the real test
  return {
    ok: false,
    method: 'none detected',
    detail: 'No kiro-cli database, no AWS credentials. Run: kiro-cli auth login',
  };
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

  // Pre-flight auth check
  const authCheck = checkKiroAuth(kiroCliPath);
  if (authCheck.ok) {
    console.log(`[kiro-to-im] Auth check passed (method: ${authCheck.method}, detail: ${authCheck.detail})`);
  } else {
    console.warn(
      `[kiro-to-im] WARNING: No Kiro authentication detected.\n` +
      `  Method: ${authCheck.method}\n` +
      `  Detail: ${authCheck.detail}\n` +
      `  The ACP handshake will attempt to proceed, but may fail.\n` +
      `  Fix:\n` +
      `    1. Run: kiro-cli auth login\n` +
      `    2. Or set AWS credentials: export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...\n` +
      `    3. Or configure AWS SSO: aws sso login --profile your-profile`,
    );
  }

  // Build extra env vars for kiro-cli based on auth config
  const extraEnv: Record<string, string> = {};
  if (config.awsAccessKeyId) extraEnv.AWS_ACCESS_KEY_ID = config.awsAccessKeyId;
  if (config.awsSecretAccessKey) extraEnv.AWS_SECRET_ACCESS_KEY = config.awsSecretAccessKey;
  if (config.awsSessionToken) extraEnv.AWS_SESSION_TOKEN = config.awsSessionToken;
  if (config.awsRegion) extraEnv.AWS_REGION = config.awsRegion;
  if (config.awsProfile) extraEnv.AWS_PROFILE = config.awsProfile;

  if (Object.keys(extraEnv).length > 0) {
    console.log(`[kiro-to-im] Forwarding auth env vars to kiro-cli: ${Object.keys(extraEnv).join(', ')}`);
  }

  // Determine MCP port (0 if disabled)
  const mcpPort = (config.feishuAppId && config.feishuAppSecret)
    ? parseInt(process.env.KTI_MCP_PORT || '9800', 10)
    : 0;

  const provider = new KiroAcpProvider(
    {
      cmd: kiroCliPath,
      args: kiroArgs,
      poolSize: config.kiroPoolSize,
      cwd: config.defaultWorkDir,
      autoApprove: config.autoApprove ?? false,
      extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
      mcpPort,
    },
    pendingPerms,
  );

  try {
    await provider.initialize();
    console.log(`[kiro-to-im] Kiro ACP provider initialized (pool_size: ${config.kiroPoolSize})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAuthError = /auth|unauthorized|forbidden|credential|token.*expired|login/i.test(errMsg);

    if (isAuthError) {
      console.error(
        `[kiro-to-im] FATAL: kiro-cli authentication failed.\n` +
        `  Error: ${errMsg}\n` +
        `  Fix:\n` +
        `    1. Run: kiro-cli auth login\n` +
        `    2. Or configure AWS credentials:\n` +
        `       export AWS_ACCESS_KEY_ID=your-key\n` +
        `       export AWS_SECRET_ACCESS_KEY=your-secret\n` +
        `    3. Or use AWS SSO: aws sso login --profile your-profile\n` +
        `    4. Then restart: kiro-to-im stop && kiro-to-im start`,
      );
    } else {
      console.error(
        `[kiro-to-im] FATAL: Failed to initialize kiro-cli ACP connection.\n` +
        `  Path: ${kiroCliPath}\n` +
        `  Args: ${kiroArgs.join(' ')}\n` +
        `  Error: ${errMsg}\n` +
        `  Fix:\n` +
        `    1. Verify kiro-cli: ${kiroCliPath} --version\n` +
        `    2. Check auth: kiro-cli auth status\n` +
        `    3. Re-login if needed: kiro-cli auth login\n` +
        `    4. Set KTI_KIRO_CLI_PATH=/path/to/kiro-cli if not in PATH`,
      );
    }
    process.exit(1);
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
      console.log(`[kiro-to-im] MCP Server started on port ${mcpPort} (feishu_send_file tool available)`);
    } catch (err) {
      console.warn(`[kiro-to-im] MCP Server failed to start (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
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
