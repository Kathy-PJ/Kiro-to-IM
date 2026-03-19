/**
 * Message Router — core of v2 architecture.
 *
 * Translates acp-link's main loop + handle_message + do_stream_prepared:
 *   - Each inbound message is handled independently (no session lock)
 *   - spawn per message (like tokio::spawn in acp-link)
 *   - reply_card → prepare_prompt → stream_acp → 300ms throttled card updates
 *   - Worker pool with consistent hash routing (via AcpClient)
 *   - Session map: thread_id → session_id (persistent)
 */

import type { BaseAdapter, InboundMessage, ReplyHandle } from './adapters/base.js';
import { AcpClient, textBlock, imageBlock, resourceLinkBlock } from './acp-client.js';
import type { ContentBlock, StreamEvent, AcpClientOptions } from './acp-client.js';
import { SessionMap } from './session-map.js';

// Card update interval (matches acp-link CARD_UPDATE_INTERVAL = 300ms)
const CARD_UPDATE_INTERVAL = 300;
// Keepalive interval (6 hours, matches acp-link)
const KEEPALIVE_INTERVAL = 6 * 60 * 60 * 1000;

// ── FNV-1a stable hash (matches acp-link) ──

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

export interface RouterConfig {
  /** Path to kiro-cli executable */
  kiroCmd: string;
  /** Arguments for kiro-cli */
  kiroArgs: string[];
  /** Number of worker processes */
  poolSize: number;
  /** Working directory */
  cwd: string;
  /** Auto-approve all permission requests */
  autoApprove: boolean;
  /** Extra env vars for kiro-cli */
  extraEnv?: Record<string, string>;
  /** Session retention days */
  sessionRetention: number;
}

/**
 * MessageRouter — handles the full message lifecycle:
 *   inbound message → createReply → preparePrompt → streamAcp → updateReply
 *
 * No session lock. Each message is spawned independently.
 */
export class MessageRouter {
  private config: RouterConfig;
  private workers: WorkerState[] = [];
  private sessionMap: SessionMap;
  private loadedSessions = new Set<string>();
  private adapters = new Map<string, BaseAdapter>();
  private running = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  // Track inflight messages per adapter (for graceful shutdown)
  private inflight = new Set<Promise<void>>();

  constructor(config: RouterConfig) {
    this.config = config;
    this.sessionMap = new SessionMap();
  }

  /**
   * Initialize worker pool and register adapters.
   */
  async initialize(): Promise<void> {
    const poolSize = Math.max(1, this.config.poolSize);
    console.log(`[router] Starting ACP worker pool: size=${poolSize}`);

    const startPromises: Promise<void>[] = [];
    for (let i = 0; i < poolSize; i++) {
      startPromises.push(this.startWorker(i));
    }
    await Promise.all(startPromises);
    console.log(`[router] All ${poolSize} workers initialized`);

    // Start keepalive and cleanup timers
    this.keepaliveTimer = setInterval(() => this.keepalive(), KEEPALIVE_INTERVAL);
    this.cleanupTimer = setInterval(
      () => this.sessionMap.cleanupExpired(this.config.sessionRetention),
      60 * 60 * 1000, // hourly
    );
  }

  private async startWorker(idx: number): Promise<void> {
    const client = new AcpClient({
      cmd: this.config.kiroCmd,
      args: this.config.kiroArgs,
      cwd: this.config.cwd,
      autoApprove: this.config.autoApprove,
      extraEnv: this.config.extraEnv,
    });

    client.on('exit', (code: number | null, signal: string | null) => {
      console.warn(`[router] Worker-${idx} exited (code: ${code}, signal: ${signal})`);
      if (this.workers[idx]) this.workers[idx].alive = false;
    });

    client.on('error', (err: Error) => {
      console.error(`[router] Worker-${idx} error:`, err.message);
    });

    try {
      const initResp = await Promise.race([
        client.start(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Worker initialization timeout (10s)')), 10_000),
        ),
      ]);

      console.log(
        `[router] Worker-${idx} ready: agent=${JSON.stringify(initResp.agentInfo)}, ` +
        `protocol=${initResp.protocolVersion}`,
      );

      if (this.workers[idx]) {
        this.workers[idx] = { client, alive: true };
      } else {
        this.workers.push({ client, alive: true });
      }
    } catch (err) {
      console.error(`[router] Worker-${idx} failed to initialize:`, err);
      throw err;
    }
  }

  private routeIdx(routingKey: string): number {
    const hash = stableHash(routingKey);
    return Number(hash % BigInt(this.workers.length));
  }

  private async getWorker(routingKey: string): Promise<{ client: AcpClient; idx: number }> {
    let idx = this.routeIdx(routingKey);
    let worker = this.workers[idx];

    if (!worker?.alive || !worker.client.isAlive) {
      try {
        await this.restartWorker(idx);
        worker = this.workers[idx];
      } catch {
        // Fallback to any alive worker
        for (let i = 0; i < this.workers.length; i++) {
          if (i !== idx && this.workers[i]?.alive && this.workers[i].client.isAlive) {
            idx = i;
            worker = this.workers[i];
            break;
          }
        }
        if (!worker?.alive) throw new Error('All kiro-cli workers are down');
      }
    }

    return { client: worker.client, idx };
  }

  private async restartWorker(idx: number): Promise<void> {
    console.log(`[router] Restarting worker-${idx}...`);
    try { await this.workers[idx]?.client.stop(); } catch { /* ignore */ }
    await this.startWorker(idx);
  }

  /**
   * Register an adapter and start listening for its messages.
   */
  registerAdapter(adapter: BaseAdapter): void {
    this.adapters.set(adapter.name, adapter);

    adapter.on('message', (msg: InboundMessage) => {
      // Spawn independent handler per message (like acp-link's tokio::spawn)
      const task = this.handleMessage(adapter, msg).catch(err => {
        console.error(`[router] handleMessage failed: ${err instanceof Error ? err.stack : err}`);
      });
      this.inflight.add(task);
      task.finally(() => this.inflight.delete(task));
    });

    console.log(`[router] Adapter registered: ${adapter.name}`);
  }

  /**
   * Start all registered adapters.
   */
  async startAdapters(): Promise<void> {
    this.running = true;
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start();
        console.log(`[router] Adapter started: ${name}`);
      } catch (err) {
        console.error(`[router] Failed to start adapter ${name}:`, err);
      }
    }
  }

  // ── Core Message Handler (like acp-link's handle_message) ──

  private async handleMessage(adapter: BaseAdapter, msg: InboundMessage): Promise<void> {
    const startTime = Date.now();
    console.log(
      `[router] [${msg.adapter}] message: chat=${msg.chatId}, user=${msg.userId}, ` +
      `text="${msg.text.substring(0, 50)}${msg.text.length > 50 ? '...' : ''}"`,
    );

    // Determine routing key for session lookup
    // Feishu: use root_id (thread root) or message_id (new thread)
    // Others: use chatId
    const routingKey = msg.rootId || msg.chatId;

    try {
      if (msg.rootId) {
        // Message in existing thread → find thread_id, reply with card, stream ACP
        await this.handleThreadMessage(adapter, msg, routingKey);
      } else {
        // New message → create reply (starts thread in Feishu), stream ACP
        await this.handleNewMessage(adapter, msg, routingKey);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[router] [${msg.adapter}] Error: ${errMsg}`);
      try {
        await adapter.sendText(msg.chatId, `Error: ${errMsg}`, msg.messageId);
      } catch { /* ignore send error */ }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[router] [${msg.adapter}] Completed in ${elapsed}ms`);
  }

  /**
   * Handle a new message (not in an existing thread).
   * Creates a reply card, starts a new ACP session, streams response.
   */
  private async handleNewMessage(
    adapter: BaseAdapter,
    msg: InboundMessage,
    routingKey: string,
  ): Promise<void> {
    const isText = !msg.text.startsWith('[');

    // Create initial reply (Feishu: reply_card with "...")
    const hint = isText ? '...' : '收到，请继续输入指令';
    const handle = await adapter.createReply(msg.messageId, hint);

    // Map the message_id → thread_id (Feishu threads)
    if (handle.threadId) {
      this.sessionMap.mapThread(msg.messageId, handle.threadId);
    }

    if (!isText) return; // Non-text: just acknowledge, don't stream

    // Prepare prompt content blocks
    const { sessionId, blocks } = await this.preparePrompt(
      adapter, routingKey, msg, false,
    );

    // Stream ACP response with card updates
    await this.streamAcpWithCard(adapter, routingKey, sessionId, handle, msg, blocks);
  }

  /**
   * Handle a message in an existing thread.
   * Finds the ACP session, creates reply card, streams response.
   */
  private async handleThreadMessage(
    adapter: BaseAdapter,
    msg: InboundMessage,
    routingKey: string,
  ): Promise<void> {
    const isText = !msg.text.startsWith('[');

    // Look up thread_id from root_id
    const threadId = this.sessionMap.getThreadId(msg.rootId!) || msg.rootId!;
    const existingSession = this.sessionMap.getSessionId(threadId);

    // Create reply card and prepare prompt in parallel (like acp-link)
    const cardPromise = adapter.createReply(msg.messageId, isText ? '...' : '收到附件，请回复文字指令来处理它');
    const promptPromise = existingSession
      ? this.preparePrompt(adapter, threadId, msg, true)
      : this.preparePrompt(adapter, threadId, msg, false);

    const [handle, promptResult] = await Promise.all([cardPromise, promptPromise]);

    if (!isText) return;

    await this.streamAcpWithCard(
      adapter, threadId, promptResult.sessionId, handle, msg, promptResult.blocks,
    );
  }

  /**
   * Prepare ACP prompt content blocks and session.
   * Like acp-link's prepare_prompt.
   */
  private async preparePrompt(
    adapter: BaseAdapter,
    routingKey: string,
    msg: InboundMessage,
    incremental: boolean,
  ): Promise<{ sessionId: string; blocks: ContentBlock[] }> {
    const existingSessionId = this.sessionMap.getSessionId(routingKey);

    if (existingSessionId && incremental) {
      // Incremental: only send current message text
      console.log(`[router] Incremental prompt: routing=${routingKey} → session=${existingSessionId}`);

      const { client } = await this.getWorker(routingKey);

      // Load session if not already loaded in this worker
      if (!this.loadedSessions.has(existingSessionId)) {
        await client.loadSession(existingSessionId, this.config.cwd);
        this.loadedSessions.add(existingSessionId);
      }

      const context = `[feishu_context: message_id=${msg.messageId}, chat_id=${msg.chatId}]\n\n${msg.text}`;
      return { sessionId: existingSessionId, blocks: [textBlock(context)] };
    }

    // Full aggregation: collect thread messages + create new session
    console.log(`[router] Full aggregation: routing=${routingKey}`);

    const blocks: ContentBlock[] = [];

    // Context header
    blocks.push(textBlock(
      `[feishu_context: message_id=${msg.messageId}, chat_id=${msg.chatId}]`,
    ));

    // Try to aggregate thread context if available
    if (adapter.name === 'feishu' && routingKey !== msg.chatId) {
      try {
        const { texts, images, files } = await adapter.aggregateThread(routingKey, msg.chatId);
        for (const text of texts) blocks.push(textBlock(text));

        // Download and add images
        for (const img of images) {
          try {
            const data = await adapter.downloadResource(img.messageId, img.key, 'image');
            const mime = detectImageMime(data);
            blocks.push(imageBlock(data.toString('base64'), mime));
          } catch (err) {
            console.warn(`[router] Failed to download image ${img.key}: ${err}`);
          }
        }

        // Add file references
        for (const file of files) {
          blocks.push(resourceLinkBlock(file.name, `feishu://file/${file.key}`));
        }
      } catch (err) {
        console.warn(`[router] Thread aggregation failed: ${err}`);
        // Fallback: just use current message
        blocks.push(textBlock(msg.text));
      }
    } else {
      blocks.push(textBlock(msg.text));
    }

    if (blocks.length <= 1) {
      // Only context header, add current message text
      blocks.push(textBlock(msg.text));
    }

    // Create new ACP session
    const { client } = await this.getWorker(routingKey);
    const sessionId = await client.newSession(this.config.cwd);
    this.sessionMap.insert(routingKey, sessionId);
    this.loadedSessions.add(sessionId);
    console.log(`[router] New session: routing=${routingKey} → session=${sessionId}`);

    return { sessionId, blocks };
  }

  /**
   * Core streaming: send ACP prompt → receive chunks → throttled card updates.
   * Like acp-link's do_stream_prepared.
   */
  private async streamAcpWithCard(
    adapter: BaseAdapter,
    routingKey: string,
    sessionId: string,
    handle: ReplyHandle,
    msg: InboundMessage,
    blocks: ContentBlock[],
  ): Promise<void> {
    console.log(
      `[router] Streaming ACP: session=${sessionId}, blocks=${blocks.length}`,
    );

    const { client } = await this.getWorker(routingKey);
    const stream = await client.prompt(sessionId, blocks);

    const streamStart = Date.now();
    let fullText = '';
    let lastUpdate = 0; // Start at 0 to trigger first update immediately
    let dirty = false;
    let chunkCount = 0;
    let firstChunkLogged = false;
    let inToolCall = false;
    // Track inflight card update to avoid concurrent PATCH conflicts
    let inflightUpdate: Promise<void> | null = null;

    for await (const event of stream) {
      chunkCount++;

      switch (event.type) {
        case 'text':
          if (!firstChunkLogged) {
            console.log(
              `[router] First chunk: session=${sessionId}, latency=${Date.now() - streamStart}ms`,
            );
            firstChunkLogged = true;
          }
          fullText += event.text;
          dirty = true;
          inToolCall = false;
          break;
        case 'tool_call':
          console.log(`[router] Tool call: ${event.title}, session=${sessionId}`);
          dirty = true;
          inToolCall = true;
          break;
      }

      // Throttled card update (300ms, like acp-link)
      const now = Date.now();
      if (now - lastUpdate >= CARD_UPDATE_INTERVAL && dirty) {
        // Check if previous update finished
        const shouldSend = !inflightUpdate || await isSettled(inflightUpdate);
        if (shouldSend) {
          const trimmed = fullText.replace(/^\n+/, '');
          const snapshot = inToolCall ? `${trimmed}\n...` : trimmed;
          inflightUpdate = adapter.updateReply(handle, snapshot || '...').catch(err => {
            console.warn(`[router] Card update failed (will continue): ${err}`);
          });
          lastUpdate = now;
          dirty = false;
        }
      }
    }

    // Wait for last inflight update
    if (inflightUpdate) {
      try { await inflightUpdate; } catch { /* already logged */ }
    }

    // Final card update
    if (dirty || fullText.trim() === '') {
      const finalText = fullText.trim() || '(no response)';
      try {
        await adapter.updateReply(handle, finalText);
      } catch (err) {
        console.error(`[router] Final card update failed: ${err}`);
      }
    }

    console.log(
      `[router] Stream complete: session=${sessionId}, chunks=${chunkCount}, ` +
      `elapsed=${Date.now() - streamStart}ms, text=${fullText.length} chars`,
    );
  }

  /**
   * Keepalive: ping workers to keep auth tokens fresh.
   */
  private async keepalive(): Promise<void> {
    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      if (!worker?.alive || !worker.client.isAlive) continue;

      try {
        const sid = await worker.client.newSession(this.config.cwd);
        const stream = await worker.client.prompt(sid, [textBlock('hello')]);
        for await (const _ of stream) { /* drain */ }
        console.log(`[router] Keepalive OK: worker-${i}`);
      } catch (err) {
        console.warn(`[router] Keepalive failed for worker-${i}:`, err);
        worker.alive = false;
      }
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    console.log('[router] Shutting down...');
    this.running = false;

    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    // Stop all adapters
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.stop();
        console.log(`[router] Adapter stopped: ${name}`);
      } catch (err) {
        console.error(`[router] Error stopping adapter ${name}:`, err);
      }
    }

    // Wait for inflight messages (max 10s)
    if (this.inflight.size > 0) {
      console.log(`[router] Waiting for ${this.inflight.size} inflight messages...`);
      await Promise.race([
        Promise.allSettled(this.inflight),
        new Promise(r => setTimeout(r, 10_000)),
      ]);
    }

    // Stop all workers
    await Promise.allSettled(
      this.workers.map((w, i) => {
        console.log(`[router] Stopping worker-${i}`);
        return w.client.stop();
      }),
    );
    this.workers = [];

    // Flush session map
    this.sessionMap.flush();
    console.log('[router] Shutdown complete');
  }
}

// ── Helpers ──

function isSettled(promise: Promise<any>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    Promise.resolve(false),
  ]);
}

function detectImageMime(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'image/webp';
  return 'image/png'; // fallback
}
