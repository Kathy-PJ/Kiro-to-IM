/**
 * ACP Client — powered by the official @agentclientprotocol/sdk.
 *
 * This replaces our manual JSON-RPC/NDJSON implementation with the
 * official TypeScript SDK, matching how acp-link uses the official
 * Rust SDK (agent-client-protocol crate).
 *
 * The SDK handles:
 *   - NDJSON framing (ndJsonStream)
 *   - JSON-RPC 2.0 protocol
 *   - Method name mapping (session/new, session/prompt, etc.)
 *   - Request/response matching
 *   - Notification routing (session/update, session/request_permission)
 *   - Schema validation (zod)
 */

import { ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

// ── Public Types ──

export interface Implementation {
  name: string;
  version: string;
}

export interface InitializeResponse {
  protocolVersion: number | string;
  agentInfo: Implementation;
  agentCapabilities: Record<string, unknown>;
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: unknown;
  models?: unknown;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'error' | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
}

// Content blocks
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
  mimeType?: string;
}

export type ContentBlock = TextContent | ImageContent | ResourceLink;

// Stream events emitted to consumers
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; title: string };

// ── ACP Client Options ──

export interface AcpClientOptions {
  /** Path to kiro-cli executable */
  cmd: string;
  /** Arguments to pass to kiro-cli */
  args: string[];
  /** Working directory for kiro-cli process */
  cwd?: string;
  /** Auto-approve all permission requests (default: false) */
  autoApprove?: boolean;
  /** Extra environment variables to pass to the kiro-cli process */
  extraEnv?: Record<string, string>;
}

// ── ACP Client ──

/**
 * ACP Client using the official @agentclientprotocol/sdk.
 *
 * Manages a kiro-cli child process and communicates via ACP protocol.
 * The SDK handles all JSON-RPC framing, method routing, and schema validation.
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private _initialized = false;
  private options: AcpClientOptions;
  private stderrBuf = '';

  constructor(options: AcpClientOptions) {
    super();
    this.options = options;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Start the kiro-cli process and initialize the ACP connection.
   */
  async start(): Promise<InitializeResponse> {
    const { cmd, args, cwd } = this.options;

    this.process = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.extraEnv || {}) },
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to get stdio handles from kiro-cli process');
    }

    // Capture stderr for diagnostics
    this.process.stderr?.on('data', (data: Buffer) => {
      this.stderrBuf += data.toString('utf-8');
      if (this.stderrBuf.length > 4096) {
        this.stderrBuf = this.stderrBuf.slice(-4096);
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.emit('exit', code, signal);
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    // Create NDJSON stream from stdio (the SDK handles all framing)
    const stdout = Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(stdin, stdout);

    // Create client-side connection with our handler
    // The SDK routes notifications and requests to these callbacks
    const self = this;
    const autoApprove = this.options.autoApprove ?? false;
    this.connection = new ClientSideConnection(
      (_conn) => ({
        // Called when agent asks for permission to use a tool
        async requestPermission(params: any) {
          const option =
            params.options?.find((o: any) => o.kind === 'allow_always') ||
            params.options?.find((o: any) => o.kind === 'allow_once') ||
            params.options?.[0];

          const toolTitle = params.toolCall?.title || 'tool';

          if (autoApprove) {
            console.log(`[acp-client] Auto-approve permission: ${toolTitle} → ${option?.optionId}`);
            return {
              outcome: {
                outcome: 'selected' as const,
                optionId: option?.optionId ?? '',
              },
            };
          }

          // Forward to IM for user approval (text reply 1/2/3)
          const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          console.log(`[acp-client] Permission request → IM: ${toolTitle}, permId=${permId}`);
          self.emit('permission_request', { ...params, _permId: permId });

          return new Promise<any>((resolve) => {
            self.once(`permission_resolved_${permId}`, resolve);
          });
        },

        // Called on each streaming notification from agent
        async sessionUpdate(params: any) {
          const update = params.update || params;
          const updateType = update.sessionUpdate || update.type || '';

          if (updateType === 'agent_message_chunk' || updateType === 'agentMessageChunk') {
            if (update.content?.type === 'text') {
              self.emit('stream_event', {
                type: 'text',
                text: update.content.text,
              } as StreamEvent);
            }
          } else if (updateType === 'tool_call' || updateType === 'toolCall') {
            self.emit('stream_event', {
              type: 'tool_call',
              title: update.title || 'Tool call',
            } as StreamEvent);
          }
        },

        // Extension notifications (_kiro.dev/metadata, etc.) — ignore
        async extNotification(_method: string, _params: Record<string, unknown>) {
          // Silently ignore Kiro extension notifications
        },
      }),
      stream,
    );

    // Initialize ACP connection
    const initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'kiro-to-im',
        version: '0.1.0',
      },
    });

    this._initialized = true;
    return initResult as unknown as InitializeResponse;
  }

  /**
   * Create a new ACP session.
   */
  async newSession(cwd: string): Promise<string> {
    if (!this.connection) throw new Error('ACP client not initialized');
    const result = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });
    return (result as any).sessionId;
  }

  /**
   * Load (resume) an existing ACP session.
   */
  async loadSession(sessionId: string, cwd: string): Promise<string> {
    if (!this.connection) throw new Error('ACP client not initialized');
    const result = await this.connection.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    });
    return (result as any).sessionId;
  }

  /**
   * Send a prompt and return a stream event receiver.
   *
   * Architecture follows acp-link's Rust pattern:
   *   1. Create a push queue
   *   2. Wire up event listener
   *   3. Return the queue consumer immediately
   *   4. SDK sends the request and routes notifications to our sessionUpdate handler
   *   5. When the prompt response arrives, close the queue
   */
  async prompt(sessionId: string, content: ContentBlock[]): Promise<AsyncIterable<StreamEvent>> {
    if (!this.connection) throw new Error('ACP client not initialized');

    // Push queue (mirrors acp-link's mpsc::unbounded_channel)
    const queue: StreamEvent[] = [];
    let closed = false;
    let waiter: ((value: void) => void) | null = null;

    const push = (event: StreamEvent) => {
      queue.push(event);
      if (waiter) { const w = waiter; waiter = null; w(); }
    };

    const close = () => {
      closed = true;
      if (waiter) { const w = waiter; waiter = null; w(); }
    };

    // Wire up event listener BEFORE sending request
    const onChunk = (event: StreamEvent) => push(event);
    this.on('stream_event', onChunk);

    // Send prompt via SDK (handles all JSON-RPC details)
    const promptPromise = this.connection.prompt({
      sessionId,
      prompt: content,
    });

    // When prompt completes, close the queue
    promptPromise
      .then(() => { this.removeListener('stream_event', onChunk); close(); })
      .catch(() => { this.removeListener('stream_event', onChunk); close(); });

    // Return async iterable that drains the queue
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            while (queue.length === 0 && !closed) {
              await new Promise<void>(resolve => { waiter = resolve; });
            }
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            return { value: undefined as unknown as StreamEvent, done: true };
          },
        };
      },
    };
  }

  /**
   * Stop the kiro-cli process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);
        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.process = null;
    }
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  get isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Resolve a permission response from external handler (IM user reply).
   */
  resolvePermission(permId: string, optionId: string): void {
    this.emit(`permission_resolved_${permId}`, {
      outcome: { outcome: 'selected', optionId },
    });
  }
}

// ── Helper functions ──

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

export function imageBlock(data: string, mimeType: string): ContentBlock {
  return { type: 'image', data, mimeType } as ImageContent;
}

export function resourceLinkBlock(name: string, uri: string, mimeType?: string): ContentBlock {
  return { type: 'resource_link', name, uri, ...(mimeType ? { mimeType } : {}) } as ResourceLink;
}
