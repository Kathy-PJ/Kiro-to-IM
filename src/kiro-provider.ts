/**
 * Kiro ACP Provider — LLMProvider implementation backed by kiro-cli
 * via the Agent Client Protocol (ACP).
 *
 * Manages a pool of ACP clients (kiro-cli processes) with consistent
 * hash routing, converting ACP stream events into the SSE format
 * expected by the bridge conversation engine.
 *
 * Architecture inspired by acp-link's Rust worker pool design.
 */

import { AcpClient, textBlock, imageBlock, resourceLinkBlock } from './acp-client.js';
import type { ContentBlock, StreamEvent, AcpClientOptions } from './acp-client.js';
import type { LLMProvider, StreamChatParams, FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

// ── Image support ──

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

// ── FNV-1a stable hash (matches Rust acp-link implementation) ──

function stableHash(s: string): bigint {
  let hash = 14695981039346656037n;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * 1099511628211n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return hash;
}

// ── Worker Pool ──

interface WorkerState {
  client: AcpClient;
  alive: boolean;
}

export interface KiroProviderConfig {
  /** Path to kiro-cli executable (default: "kiro-cli") */
  cmd: string;
  /** Arguments for kiro-cli (default: ["acp"]) */
  args: string[];
  /** Number of kiro-cli worker processes (default: 4) */
  poolSize: number;
  /** Working directory for kiro-cli (default: cwd) */
  cwd?: string;
  /** Auto-approve all permission requests (default: false) */
  autoApprove: boolean;
  /** Extra environment variables to pass to kiro-cli (e.g. AWS credentials) */
  extraEnv?: Record<string, string>;
}

/**
 * KiroAcpProvider — bridges the claude-to-im LLMProvider interface
 * to kiro-cli via the Agent Client Protocol.
 *
 * Manages a pool of kiro-cli worker processes with hash-based routing,
 * automatic restart on crash, and keepalive heartbeats.
 */
export class KiroAcpProvider implements LLMProvider {
  private workers: WorkerState[] = [];
  private config: KiroProviderConfig;
  private pendingPerms: PendingPermissions;
  private sessionWorkerMap = new Map<string, number>(); // sessionId -> workerIdx

  constructor(config: KiroProviderConfig, pendingPerms: PendingPermissions) {
    this.config = config;
    this.pendingPerms = pendingPerms;
  }

  /**
   * Initialize the worker pool. Must be called before streamChat.
   */
  async initialize(): Promise<void> {
    const poolSize = Math.max(1, this.config.poolSize);
    console.log(`[kiro-provider] Starting ACP worker pool: size=${poolSize}`);

    const startPromises: Promise<void>[] = [];

    for (let i = 0; i < poolSize; i++) {
      startPromises.push(this.startWorker(i));
    }

    await Promise.all(startPromises);
    console.log(`[kiro-provider] All ${poolSize} workers initialized`);

    // Start keepalive background task
    this.startKeepalive();
  }

  private async startWorker(idx: number): Promise<void> {
    const client = new AcpClient({
      cmd: this.config.cmd,
      args: this.config.args,
      cwd: this.config.cwd,
      autoApprove: this.config.autoApprove,
      extraEnv: this.config.extraEnv,
    });

    // Handle worker exit
    client.on('exit', (code: number | null, signal: string | null) => {
      console.warn(`[kiro-provider] Worker-${idx} exited (code: ${code}, signal: ${signal})`);
      if (this.workers[idx]) {
        this.workers[idx].alive = false;
      }
    });

    client.on('error', (err: Error) => {
      console.error(`[kiro-provider] Worker-${idx} error:`, err.message);
    });

    try {
      const initResp = await Promise.race([
        client.start(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Worker initialization timeout (10s)')), 10_000)
        ),
      ]);

      console.log(
        `[kiro-provider] Worker-${idx} ready: agent=${JSON.stringify(initResp.agent_info)}, ` +
        `protocol=${initResp.protocol_version}`
      );

      if (this.workers[idx]) {
        this.workers[idx] = { client, alive: true };
      } else {
        this.workers.push({ client, alive: true });
      }
    } catch (err) {
      console.error(`[kiro-provider] Worker-${idx} failed to initialize:`, err);
      throw err;
    }
  }

  /**
   * Restart a crashed worker.
   */
  private async restartWorker(idx: number): Promise<void> {
    console.log(`[kiro-provider] Restarting worker-${idx}...`);
    try {
      await this.workers[idx]?.client.stop();
    } catch { /* ignore */ }
    await this.startWorker(idx);
    console.log(`[kiro-provider] Worker-${idx} restarted successfully`);
  }

  /**
   * Route a session key to a consistent worker index using FNV-1a hash.
   */
  private routeIdx(routingKey: string): number {
    const hash = stableHash(routingKey);
    return Number(hash % BigInt(this.workers.length));
  }

  /**
   * Get a live worker for a routing key, restarting if necessary.
   */
  private async getWorker(routingKey: string): Promise<{ client: AcpClient; idx: number }> {
    let idx = this.routeIdx(routingKey);
    let worker = this.workers[idx];

    if (!worker?.alive || !worker.client.isAlive) {
      try {
        await this.restartWorker(idx);
        worker = this.workers[idx];
      } catch (err) {
        // Try another worker as fallback
        for (let i = 0; i < this.workers.length; i++) {
          if (i !== idx && this.workers[i]?.alive && this.workers[i].client.isAlive) {
            idx = i;
            worker = this.workers[i];
            break;
          }
        }
        if (!worker?.alive) {
          throw new Error(`All kiro-cli workers are down: ${err}`);
        }
      }
    }

    return { client: worker.client, idx };
  }

  /**
   * Background keepalive task — periodically pings workers to keep
   * kiro-cli auth tokens from expiring.
   */
  private startKeepalive(): void {
    const interval = 6 * 60 * 60 * 1000; // 6 hours

    setInterval(async () => {
      for (let i = 0; i < this.workers.length; i++) {
        const worker = this.workers[i];
        if (!worker?.alive || !worker.client.isAlive) continue;

        try {
          const sid = await worker.client.newSession(this.config.cwd || process.cwd());
          const stream = await worker.client.prompt(sid, [textBlock('hello')]);
          // Drain the stream
          for await (const _ of stream) { /* consume */ }
          console.log(`[kiro-provider] Keepalive heartbeat OK: worker-${i}`);
        } catch (err) {
          console.warn(`[kiro-provider] Keepalive failed for worker-${i}:`, err);
          worker.alive = false;
        }
      }
    }, interval);
  }

  /**
   * Implement the LLMProvider interface.
   * Converts IM messages into ACP prompts and streams responses back as SSE events.
   */
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            // Determine routing key from session
            const routingKey = params.sessionId || `default-${Date.now()}`;
            const { client, idx } = await self.getWorker(routingKey);

            // Build content blocks from prompt and files
            const blocks = self.buildContentBlocks(params.prompt, params.files);

            // Resolve or create ACP session
            let sessionId: string;
            if (params.sdkSessionId) {
              try {
                sessionId = await client.loadSession(
                  params.sdkSessionId,
                  params.workingDirectory || self.config.cwd || process.cwd(),
                );
              } catch {
                // Load failed — create new session
                sessionId = await client.newSession(
                  params.workingDirectory || self.config.cwd || process.cwd(),
                );
              }
            } else {
              sessionId = await client.newSession(
                params.workingDirectory || self.config.cwd || process.cwd(),
              );
            }

            // Emit session status
            controller.enqueue(sseEvent('status', {
              session_id: sessionId,
            }));

            // Track this session's worker for future routing
            self.sessionWorkerMap.set(sessionId, idx);

            // Set up permission handling if not auto-approve
            if (!self.config.autoApprove) {
              client.removeAllListeners('permission_request');
              client.on('permission_request', async (req: {
                id: number;
                options: Array<{ option_id: string; label: string; kind: string }>;
                tool_name?: string;
                description?: string;
              }) => {
                // Emit permission_request SSE for the bridge
                const toolUseId = `perm-${req.id}`;
                controller.enqueue(sseEvent('permission_request', {
                  permissionRequestId: toolUseId,
                  toolName: req.tool_name || 'unknown_tool',
                  toolInput: { description: req.description },
                  suggestions: req.options.map((o: { label: string }) => o.label),
                }));

                // Wait for IM user response
                const result = await self.pendingPerms.waitFor(toolUseId);

                if (result.behavior === 'allow') {
                  // Find AllowAlways or AllowOnce option
                  const allowOption = req.options.find((o: { kind: string }) =>
                    o.kind === 'allow_always' || o.kind === 'allow_once'
                  ) || req.options[0];
                  if (allowOption) {
                    client.resolvePermission(req.id, allowOption.option_id);
                  }
                } else {
                  // Find reject option
                  const denyOption = req.options.find((o: { kind: string }) =>
                    o.kind === 'reject_once' || o.kind === 'reject_always'
                  ) || req.options[req.options.length - 1];
                  if (denyOption) {
                    client.resolvePermission(req.id, denyOption.option_id);
                  }
                }
              });
            }

            // Send prompt and stream response
            const stream = await client.prompt(sessionId, blocks);
            let hasText = false;

            for await (const event of stream) {
              if (params.abortController?.signal.aborted) break;

              switch (event.type) {
                case 'text':
                  controller.enqueue(sseEvent('text', event.text));
                  hasText = true;
                  break;
                case 'tool_call':
                  controller.enqueue(sseEvent('tool_use', {
                    id: `tool-${Date.now()}`,
                    name: event.title,
                    input: {},
                  }));
                  break;
              }
            }

            // Emit result
            controller.enqueue(sseEvent('result', {
              session_id: sessionId,
              is_error: false,
            }));

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[kiro-provider] Stream error:', err instanceof Error ? err.stack || err.message : err);

            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });
  }

  /**
   * Build ACP ContentBlocks from prompt text and optional file attachments.
   */
  private buildContentBlocks(text: string, files?: FileAttachment[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    // Add image blocks
    const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
    if (imageFiles && imageFiles.length > 0) {
      for (const file of imageFiles) {
        const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
        blocks.push(imageBlock(file.data, mimeType));
      }
    }

    // Add text block
    if (text.trim()) {
      blocks.push(textBlock(text));
    }

    return blocks;
  }

  /**
   * Gracefully shut down all workers.
   */
  async shutdown(): Promise<void> {
    console.log('[kiro-provider] Shutting down worker pool...');
    await Promise.allSettled(
      this.workers.map((w, i) => {
        console.log(`[kiro-provider] Stopping worker-${i}`);
        return w.client.stop();
      })
    );
    this.workers = [];
    console.log('[kiro-provider] All workers stopped');
  }
}
