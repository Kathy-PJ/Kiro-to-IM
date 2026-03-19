/**
 * Abstract adapter interface for IM channels.
 *
 * Each adapter (Feishu, Discord, Telegram, QQ) implements this interface
 * to provide platform-specific message receiving and sending.
 *
 * Architecture matches acp-link:
 *   - Each adapter has a listen() → emits InboundMessage to a callback
 *   - createReply() creates an initial reply (card/message)
 *   - updateReply() updates the reply with streaming text (300ms throttle)
 *   - No session lock — concurrent messages handled independently
 */

import { EventEmitter } from 'node:events';

// ── Inbound Message (from IM to router) ──

export interface InboundMessage {
  /** Adapter channel type */
  adapter: string;
  /** Chat/conversation ID */
  chatId: string;
  /** Original message ID */
  messageId: string;
  /** Sender user ID */
  userId: string;
  /** Message text content */
  text: string;
  /** Chat type: 'p2p' or 'group' */
  chatType: 'p2p' | 'group';
  /** Root message ID if this message is inside a thread */
  rootId?: string;
  /** Image attachments */
  images?: Array<{ key: string; messageId: string }>;
  /** File attachments */
  files?: Array<{ key: string; name: string; messageId: string }>;
}

// ── Reply Handle (adapter creates, router uses to update) ──

export interface ReplyHandle {
  /** ID of the reply message (used for updates) */
  replyId: string;
  /** Thread ID (Feishu-specific: created when replying in thread) */
  threadId?: string;
}

// ── Abstract Adapter ──

export abstract class BaseAdapter extends EventEmitter {
  abstract readonly name: string;

  /**
   * Start the adapter: connect to IM platform, begin receiving messages.
   * Must call `this.emit('message', msg: InboundMessage)` for each inbound message.
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter gracefully.
   */
  abstract stop(): Promise<void>;

  /**
   * Validate that the adapter's configuration is complete.
   * Returns null if valid, or an error string.
   */
  abstract validateConfig(): string | null;

  /**
   * Create an initial reply to a message (e.g. Feishu card, Discord message).
   * Returns a handle used for subsequent updates.
   *
   * @param messageId - The message to reply to
   * @param initialText - Initial text/markdown content ("..." placeholder)
   */
  abstract createReply(messageId: string, initialText: string): Promise<ReplyHandle>;

  /**
   * Update an existing reply with new text (streaming card update).
   * Called every ~300ms during streaming.
   *
   * @param handle - The reply handle from createReply()
   * @param text - Full accumulated text so far
   */
  abstract updateReply(handle: ReplyHandle, text: string): Promise<void>;

  /**
   * Send a standalone text message (not a reply update).
   * Used for error messages, permission requests, etc.
   *
   * @param chatId - Target chat ID
   * @param text - Message text
   * @param replyTo - Optional message ID to reply to
   */
  abstract sendText(chatId: string, text: string, replyTo?: string): Promise<string>;

  /**
   * Download a resource (image/file) from the IM platform.
   * Optional — only needed for platforms that support attachments.
   */
  async downloadResource(
    _messageId: string,
    _fileKey: string,
    _type: 'image' | 'file',
  ): Promise<Buffer> {
    throw new Error('downloadResource not implemented');
  }

  /**
   * Aggregate thread context (collect all messages in a thread).
   * Optional — only Feishu implements this.
   */
  async aggregateThread(
    _threadId: string,
    _chatId: string,
  ): Promise<{ texts: string[]; images: Array<{ key: string; messageId: string }>; files: Array<{ key: string; name: string; messageId: string }> }> {
    return { texts: [], images: [], files: [] };
  }
}

// ── Adapter Registry ──

const adapterFactories = new Map<string, () => BaseAdapter>();

export function registerAdapter(name: string, factory: () => BaseAdapter): void {
  adapterFactories.set(name, factory);
}

export function createAdapter(name: string): BaseAdapter | null {
  const factory = adapterFactories.get(name);
  return factory ? factory() : null;
}

export function getRegisteredAdapters(): string[] {
  return Array.from(adapterFactories.keys());
}
