/**
 * Session Map — persistent thread/chat → ACP session_id mapping.
 *
 * Translates acp-link's SessionMap:
 *   - thread_id → session_id (Feishu thread to ACP session)
 *   - chat_id → thread_id → session_id (for non-thread adapters)
 *   - JSON file persistence
 *   - Expiry/cleanup for old entries
 */

import fs from 'node:fs';
import path from 'node:path';
import { KTI_HOME } from './config.js';

const DATA_DIR = path.join(KTI_HOME, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

interface SessionEntry {
  sessionId: string;
  threadId?: string;
  createdAt: number;
  lastUsed: number;
}

/**
 * Persistent mapping from routing keys (thread_id, chat_id) to ACP session IDs.
 * Like acp-link's SessionMap with JSON persistence.
 */
export class SessionMap {
  /** routingKey → SessionEntry */
  private map = new Map<string, SessionEntry>();
  /** messageId → threadId (for initial message → thread mapping) */
  private threadMap = new Map<string, string>();
  private dirty = false;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const data = JSON.parse(raw);

      if (data.sessions) {
        for (const [key, entry] of Object.entries(data.sessions)) {
          this.map.set(key, entry as SessionEntry);
        }
      }
      if (data.threads) {
        for (const [key, threadId] of Object.entries(data.threads)) {
          this.threadMap.set(key, threadId as string);
        }
      }
      console.log(`[session-map] Loaded ${this.map.size} sessions, ${this.threadMap.size} thread mappings`);
    } catch {
      // First run — no file yet
    }
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = {
        sessions: Object.fromEntries(this.map),
        threads: Object.fromEntries(this.threadMap),
      };
      const tmp = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, SESSIONS_FILE);
      this.dirty = false;
    } catch (err) {
      console.error(`[session-map] Failed to flush: ${err}`);
    }
  }

  // ── Session ID Lookup/Insert ──

  /**
   * Get the ACP session_id for a routing key (thread_id or chat_id).
   */
  getSessionId(routingKey: string): string | undefined {
    const entry = this.map.get(routingKey);
    if (entry) {
      entry.lastUsed = Date.now();
      this.dirty = true;
    }
    return entry?.sessionId;
  }

  /**
   * Store a new routing_key → session_id mapping.
   */
  insert(routingKey: string, sessionId: string, threadId?: string): void {
    this.map.set(routingKey, {
      sessionId,
      threadId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });
    this.dirty = true;
    this.flush();
  }

  // ── Thread Mapping (Feishu: message_id → thread_id) ──

  /**
   * Map a root message_id to its thread_id.
   * Called when reply_card returns a thread_id.
   */
  mapThread(messageId: string, threadId: string): void {
    this.threadMap.set(messageId, threadId);
    this.dirty = true;
    this.flush();
  }

  /**
   * Get the thread_id for a root message_id.
   */
  getThreadId(messageId: string): string | undefined {
    return this.threadMap.get(messageId);
  }

  // ── Cleanup ──

  /**
   * Remove entries older than `days` days.
   */
  cleanupExpired(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [key, entry] of this.map) {
      if (entry.lastUsed < cutoff) {
        this.map.delete(key);
        removed++;
      }
    }

    // Clean old thread mappings too
    for (const [key] of this.threadMap) {
      // Thread mappings don't have timestamps, use session map as proxy
      // If the session for this thread was cleaned up, clean the thread mapping too
    }

    if (removed > 0) {
      this.dirty = true;
      this.flush();
      console.log(`[session-map] Cleaned up ${removed} expired entries`);
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}
