/**
 * ACP (Agent Client Protocol) TypeScript Client
 *
 * Implements the client side of the ACP protocol over stdio,
 * communicating with kiro-cli via JSON-RPC 2.0 with LSP-style framing.
 *
 * Ported from the Rust implementation in acp-link.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ── Protocol Types ──

export interface Implementation {
  name: string;
  version: string;
}

export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embedded_context: boolean;
}

export interface AgentCapabilities {
  prompt_capabilities: PromptCapabilities;
}

export interface InitializeResponse {
  protocolVersion: number | string;
  agentInfo: Implementation;
  agentCapabilities: AgentCapabilities;
}

export interface NewSessionResponse {
  sessionId: string;
}

export interface LoadSessionResponse {
  sessionId: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'error';

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
  data: string; // base64
  mimeType: string;
}

export interface ResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
  mimeType?: string;
}

export type ContentBlock = TextContent | ImageContent | ResourceLink;

// Permission types
export interface PermissionOption {
  optionId: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  options: PermissionOption[];
  toolName?: string;
  description?: string;
}

export interface PermissionResponse {
  outcome: {
    type: 'selected';
    optionId: string;
  };
}

// Session notification types
export interface AgentMessageChunk {
  type: 'agentMessageChunk';
  content: ContentBlock;
}

export interface ToolCallNotification {
  type: 'toolCall';
  toolCallId: string;
  title: string;
}

export type SessionUpdate = AgentMessageChunk | ToolCallNotification | { type: string };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// Stream events emitted to consumers
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; title: string };

// ── JSON-RPC Types ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── NDJSON Wire Protocol ──

/**
 * Parse newline-delimited JSON (NDJSON) messages from a buffer.
 *
 * The ACP protocol (agent-client-protocol crate) uses NDJSON framing:
 * each JSON-RPC message is a single line terminated by '\n'.
 * This was verified from the official Rust SDK:
 *   https://github.com/agentclientprotocol/rust-sdk/blob/main/src/agent-client-protocol/src/rpc.rs
 *
 * Reading: BufReader::read_line() → parse JSON
 * Writing: serde_json::to_writer() → append '\n' → flush
 */
class MessageBuffer {
  private buffer = '';

  append(data: Buffer): JsonRpcMessage[] {
    this.buffer += data.toString('utf-8');
    const messages: JsonRpcMessage[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue; // Skip empty lines

      try {
        messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // Skip malformed JSON lines
      }
    }

    return messages;
  }
}

/**
 * Encode a JSON-RPC message as NDJSON (single line + newline).
 */
function encodeMessage(msg: JsonRpcMessage): Buffer {
  const line = JSON.stringify(msg) + '\n';
  return Buffer.from(line, 'utf-8');
}

// ── ACP Client ──

export interface AcpClientOptions {
  /** Path to kiro-cli executable */
  cmd: string;
  /** Arguments to pass to kiro-cli */
  args: string[];
  /** Working directory for kiro-cli process */
  cwd?: string;
  /** Auto-approve permission requests (default: true) */
  autoApprove?: boolean;
  /** Extra environment variables to pass to the kiro-cli process (e.g. AWS credentials) */
  extraEnv?: Record<string, string>;
}

/**
 * ACP Client — manages a kiro-cli child process and communicates
 * via the Agent Client Protocol (JSON-RPC 2.0 over stdio).
 */
export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private msgBuffer = new MessageBuffer();
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private _initialized = false;
  private options: AcpClientOptions;
  private stderrBuf = '';

  constructor(options: AcpClientOptions) {
    super();
    this.options = {
      autoApprove: true,
      ...options,
    };
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

    // Handle stdout (ACP messages)
    this.process.stdout.on('data', (data: Buffer) => {
      const messages = this.msgBuffer.append(data);
      for (const msg of messages) {
        this.handleMessage(msg);
      }
    });

    // Capture stderr for diagnostics
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.stderrBuf += text;
      // Keep last 4KB
      if (this.stderrBuf.length > 4096) {
        this.stderrBuf = this.stderrBuf.slice(-4096);
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.emit('exit', code, signal);
      // Check stderr for auth-related failures
      const authError = this.detectAuthError();
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        const baseMsg = `kiro-cli process exited (code: ${code}, signal: ${signal})`;
        const errMsg = authError
          ? `${baseMsg} — Authentication error: ${authError}`
          : baseMsg;
        pending.reject(new Error(errMsg));
        this.pendingRequests.delete(id);
      }
      if (authError) {
        this.emit('auth_error', authError);
      }
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    // Initialize ACP connection
    // Method: "initialize", params: { protocolVersion (number), clientInfo }
    // kiro-cli v1.27.2 uses protocolVersion: 1 (number), not "2025-01-01" (string)
    const initResult = await this.sendRequest<InitializeResponse>('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'kiro-to-im',
        version: '0.1.0',
      },
    });

    this._initialized = true;
    return initResult;
  }

  /**
   * Create a new ACP session.
   * Method: "session/new" (singular!), params: { cwd, mcpServers }
   * kiro-cli v1.27.2 requires mcpServers field (can be empty array).
   */
  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest<NewSessionResponse>('session/new', {
      cwd,
      mcpServers: [],
    });
    return result.sessionId;
  }

  /**
   * Load (resume) an existing ACP session.
   * Method: "session/load" (singular!), params: { sessionId, cwd, mcpServers }
   */
  async loadSession(sessionId: string, cwd: string): Promise<string> {
    const result = await this.sendRequest<LoadSessionResponse>('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
    return result.sessionId;
  }

  /**
   * Send a prompt and return a stream event receiver.
   * Method: "session/prompt" (singular!), params: { sessionId, prompt: ContentBlock[] }
   *
   * Architecture follows acp-link's Rust pattern:
   *   1. Create a push queue (channel)
   *   2. Wire up event listener to push into queue
   *   3. Return the queue consumer immediately
   *   4. Send the JSON-RPC request (streaming notifications arrive via listener)
   *   5. When the response arrives, close the queue
   *
   * This avoids race conditions where events arrive before the consumer starts.
   */
  async prompt(sessionId: string, content: ContentBlock[]): Promise<AsyncIterable<StreamEvent>> {
    // Push queue: events are pushed by the listener, consumed by the async iterable.
    // This mirrors acp-link's mpsc::unbounded_channel pattern.
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

    // Build the prompt content
    const promptContent = content.map(block => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'image':
          return { type: 'image', data: block.data, mimeType: block.mimeType };
        case 'resource_link':
          return {
            type: 'resource_link',
            name: block.name,
            uri: block.uri,
            ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          };
        default:
          return block;
      }
    });

    // Send request — response arrives AFTER all notifications
    const promptPromise = this.sendRequest<PromptResponse>('session/prompt', {
      sessionId,
      prompt: promptContent,
    });

    // When prompt completes (or fails), close the queue
    promptPromise
      .then(() => {
        this.removeListener('stream_event', onChunk);
        close();
      })
      .catch(() => {
        this.removeListener('stream_event', onChunk);
        close();
      });

    // Return async iterable that drains the queue
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            // Drain buffered events first (critical for same-tick delivery)
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
      // Wait for exit with timeout
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

  // ── Private Methods ──

  /**
   * Scan stderr buffer for authentication-related error patterns.
   * Returns a human-readable auth error description, or null if none detected.
   */
  private detectAuthError(): string | null {
    const stderr = this.stderrBuf.toLowerCase();
    const patterns: Array<{ pattern: RegExp; message: string }> = [
      { pattern: /not\s+logged\s+in/i, message: 'Not logged in. Run: kiro-cli auth login' },
      { pattern: /token\s+(expired|invalid)/i, message: 'Auth token expired. Run: kiro-cli auth login' },
      { pattern: /unauthorized|401/i, message: 'Unauthorized (HTTP 401). Re-authenticate with: kiro-cli auth login' },
      { pattern: /forbidden|403/i, message: 'Forbidden (HTTP 403). Check your account permissions.' },
      { pattern: /credential/i, message: 'Credential error. Check AWS credentials or run: kiro-cli auth login' },
      { pattern: /aws.*sso.*expired/i, message: 'AWS SSO session expired. Run: aws sso login' },
      { pattern: /no\s+valid\s+credential/i, message: 'No valid credentials found. Run: kiro-cli auth login' },
      { pattern: /signin|sign\s*in/i, message: 'Sign-in required. Run: kiro-cli auth login' },
    ];

    for (const { pattern, message } of patterns) {
      if (pattern.test(stderr)) {
        return message;
      }
    }
    return null;
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error('kiro-cli stdin not writable'));
      }

      const id = this.nextId++;
      const msg: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });

      const encoded = encodeMessage(msg);
      this.process.stdin.write(encoded, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to kiro-cli stdin: ${err.message}`));
        }
      });
    });
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.process?.stdin?.writable) return;

    const msg: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.process.stdin.write(encodeMessage(msg));
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`ACP error: ${response.error.message} (code: ${response.error.code})`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Request from agent (callbacks)
    if ('id' in msg && 'method' in msg) {
      const request = msg as JsonRpcRequest;
      this.handleAgentRequest(request);
      return;
    }

    // Notification from agent
    if ('method' in msg && !('id' in msg)) {
      const notification = msg as JsonRpcNotification;
      this.handleAgentNotification(notification);
    }
  }

  private handleAgentRequest(request: JsonRpcRequest): void {
    switch (request.method) {
      case 'request_permission':
      case 'requestPermission': {
        const params = request.params as PermissionRequest;
        if (this.options.autoApprove) {
          // Auto-approve: prefer AllowAlways > AllowOnce > first option
          const option = this.selectBestPermissionOption(params.options);
          if (option) {
            this.sendResponse(request.id, {
              outcome: { type: 'selected', optionId: option.optionId },
            });
          } else {
            this.sendResponse(request.id, {
              outcome: { type: 'selected', optionId: params.options[0]?.optionId ?? '' },
            });
          }
        } else {
          // Emit permission request for external handling
          this.emit('permission_request', {
            id: request.id,
            ...params,
          });
        }
        break;
      }
      default:
        // Unknown method — respond with error
        if (this.process?.stdin?.writable) {
          const errorResponse: JsonRpcResponse = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Method not found: ${request.method}` },
          };
          this.process.stdin.write(encodeMessage(errorResponse));
        }
    }
  }

  private handleAgentNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'session/update':
      case 'session_notification':
      case 'sessionNotification': {
        const params = notification.params as Record<string, unknown>;
        // kiro-cli v1.27.2 uses { sessionUpdate: "agent_message_chunk", content: {...} }
        // Official ACP schema uses { update: { type: "agentMessageChunk", content: {...} } }
        // Handle both formats:
        const update = (params.update as Record<string, unknown>) || params;
        const updateType = (update.sessionUpdate as string) || (update.type as string) || '';

        if (updateType === 'agent_message_chunk' || updateType === 'agentMessageChunk') {
          const content = update.content as Record<string, unknown>;
          if (content?.type === 'text') {
            this.emit('stream_event', { type: 'text', text: content.text as string } as StreamEvent);
          }
        } else if (updateType === 'tool_call' || updateType === 'toolCall') {
          const title = (update.title as string) || 'Tool call';
          this.emit('stream_event', { type: 'tool_call', title } as StreamEvent);
        }
        break;
      }
      default:
        // Kiro-specific notifications (_kiro.dev/metadata, _kiro.dev/commands/available, etc.)
        // are informational — log but don't error
        if (notification.method?.startsWith('_kiro.dev/')) {
          // Silently ignore Kiro extension notifications
        }
        break;
    }
  }

  /**
   * Resolve a permission response from external handler.
   */
  resolvePermission(requestId: number, optionId: string): void {
    this.sendResponse(requestId, {
      outcome: { type: 'selected', optionId },
    });
  }

  /**
   * Select the best permission option:
   * AllowAlways > AllowOnce > first option
   */
  private selectBestPermissionOption(options: PermissionOption[]): PermissionOption | undefined {
    return (
      options.find(o => o.kind === 'allow_always') ||
      options.find(o => o.kind === 'allow_once') ||
      options[0]
    );
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
