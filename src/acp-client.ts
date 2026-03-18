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
  protocol_version: string;
  agent_info: Implementation;
  agent_capabilities: AgentCapabilities;
}

export interface NewSessionResponse {
  session_id: string;
}

export interface LoadSessionResponse {
  session_id: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'error';

export interface PromptResponse {
  stop_reason: StopReason;
}

// Content blocks
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mime_type: string;
}

export interface ResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
  mime_type?: string;
}

export type ContentBlock = TextContent | ImageContent | ResourceLink;

// Permission types
export interface PermissionOption {
  option_id: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  options: PermissionOption[];
  tool_name?: string;
  description?: string;
}

export interface PermissionResponse {
  outcome: {
    type: 'selected';
    option_id: string;
  };
}

// Session notification types
export interface AgentMessageChunk {
  type: 'agent_message_chunk';
  content: ContentBlock;
}

export interface ToolCallNotification {
  type: 'tool_call';
  tool_call_id: string;
  title: string;
}

export type SessionUpdate = AgentMessageChunk | ToolCallNotification | { type: string };

export interface SessionNotification {
  session_id: string;
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
    const initResult = await this.sendRequest<InitializeResponse>('initialize', {
      protocol_version: '2025-01-01',
      client_info: {
        name: 'kiro-to-im',
        version: '0.1.0',
      },
    });

    this._initialized = true;
    return initResult;
  }

  /**
   * Create a new ACP session.
   */
  async newSession(cwd: string): Promise<string> {
    const result = await this.sendRequest<NewSessionResponse>('new_session', {
      working_directory: cwd,
    });
    return result.session_id;
  }

  /**
   * Load (resume) an existing ACP session.
   */
  async loadSession(sessionId: string, cwd: string): Promise<string> {
    const result = await this.sendRequest<LoadSessionResponse>('load_session', {
      session_id: sessionId,
      working_directory: cwd,
    });
    return result.session_id;
  }

  /**
   * Send a prompt and return a stream event receiver.
   * The returned async iterable yields StreamEvents until the prompt completes.
   */
  async prompt(sessionId: string, content: ContentBlock[]): Promise<AsyncIterable<StreamEvent>> {
    const events: StreamEvent[] = [];
    let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;
    let done = false;

    // Set up event listeners for this prompt
    const onChunk = (event: StreamEvent) => {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
      } else {
        events.push(event);
      }
    };

    const onPromptDone = () => {
      done = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: undefined as unknown as StreamEvent, done: true });
      }
    };

    this.on('stream_event', onChunk);
    this.once('prompt_done', onPromptDone);

    // Send the prompt request (don't await — we want to start consuming events immediately)
    const promptPromise = this.sendRequest<PromptResponse>('prompt', {
      session_id: sessionId,
      content: content.map(block => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text };
          case 'image':
            return { type: 'image', data: block.data, mime_type: block.mime_type };
          case 'resource_link':
            return {
              type: 'resource_link',
              name: block.name,
              uri: block.uri,
              ...(block.mime_type ? { mime_type: block.mime_type } : {}),
            };
          default:
            return block;
        }
      }),
    });

    promptPromise
      .then(() => {
        this.removeListener('stream_event', onChunk);
        onPromptDone();
      })
      .catch((err) => {
        this.removeListener('stream_event', onChunk);
        this.removeListener('prompt_done', onPromptDone);
        done = true;
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = null;
          resolve({ value: undefined as unknown as StreamEvent, done: true });
        }
        this.emit('prompt_error', err);
      });

    // Return async iterable
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<StreamEvent>> {
            if (events.length > 0) {
              return Promise.resolve({ value: events.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
            }
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
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
      case 'request_permission': {
        const params = request.params as PermissionRequest;
        if (this.options.autoApprove) {
          // Auto-approve: prefer AllowAlways > AllowOnce > first option
          const option = this.selectBestPermissionOption(params.options);
          if (option) {
            this.sendResponse(request.id, {
              outcome: { type: 'selected', option_id: option.option_id },
            });
          } else {
            this.sendResponse(request.id, {
              outcome: { type: 'selected', option_id: params.options[0]?.option_id ?? '' },
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
      case 'session_notification': {
        const params = notification.params as SessionNotification;
        const update = params.update;

        if (update.type === 'agent_message_chunk') {
          const chunk = update as AgentMessageChunk;
          if (chunk.content.type === 'text') {
            this.emit('stream_event', { type: 'text', text: chunk.content.text } as StreamEvent);
          }
        } else if (update.type === 'tool_call') {
          const tc = update as ToolCallNotification;
          const title = tc.title || 'Tool call';
          this.emit('stream_event', { type: 'tool_call', title } as StreamEvent);
        }
        break;
      }
      default:
        // Unknown notification — ignore
        break;
    }
  }

  /**
   * Resolve a permission response from external handler.
   */
  resolvePermission(requestId: number, optionId: string): void {
    this.sendResponse(requestId, {
      outcome: { type: 'selected', option_id: optionId },
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
  return { type: 'image', data, mime_type: mimeType } as ImageContent;
}

export function resourceLinkBlock(name: string, uri: string, mimeType?: string): ContentBlock {
  return { type: 'resource_link', name, uri, ...(mimeType ? { mime_type: mimeType } : {}) } as ResourceLink;
}
