/**
 * Feishu Adapter — Direct REST API + WebSocket message listener.
 *
 * Translates acp-link's feishu.rs to TypeScript:
 *   - WebSocket long-connection for receiving messages (protobuf frames)
 *   - reply_card() → POST /im/v1/messages/{id}/reply (reply_in_thread=true)
 *   - update_card() → PATCH /im/v1/messages/{id}
 *   - build_card() → { elements: [{ tag: "markdown", content }] }
 *   - get_tenant_access_token() with double-check cache
 *   - aggregate_thread() for thread context
 *
 * No CardKit, no streaming card SDK — just plain REST like acp-link.
 */

import WebSocket from 'ws';
import { BaseAdapter, type InboundMessage, type ReplyHandle } from './base.js';
import { loadConfig } from '../config.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_WS_BASE = 'https://open.feishu.cn';

// Token refresh 120s before expiry (matches acp-link TOKEN_REFRESH_SKEW)
const TOKEN_REFRESH_SKEW = 120_000;
// Default token TTL if not in response
const DEFAULT_TOKEN_TTL = 7200_000;
// WS heartbeat timeout (5 min, matches acp-link)
const WS_HEARTBEAT_TIMEOUT = 300_000;
// Message dedup window (30 min)
const DEDUP_WINDOW = 30 * 60 * 1000;

// ── Minimal Protobuf Encoder/Decoder for Feishu WS Frames ──

// Wire types
const VARINT = 0;
const LENGTH_DELIMITED = 2;

function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) v = 0n;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    result |= BigInt(byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

interface PbHeader {
  key: string;
  value: string;
}

interface PbFrame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: PbHeader[];
  payload?: Buffer;
}

function encodeHeader(h: PbHeader): Buffer {
  const keyBuf = Buffer.from(h.key, 'utf-8');
  const valBuf = Buffer.from(h.value, 'utf-8');
  const parts: Buffer[] = [];
  // field 1 (key): tag = (1 << 3) | 2 = 0x0a
  parts.push(Buffer.from([0x0a]));
  parts.push(encodeVarint(keyBuf.length));
  parts.push(keyBuf);
  // field 2 (value): tag = (2 << 3) | 2 = 0x12
  parts.push(Buffer.from([0x12]));
  parts.push(encodeVarint(valBuf.length));
  parts.push(valBuf);
  return Buffer.concat(parts);
}

function encodeFrame(frame: PbFrame): Buffer {
  const parts: Buffer[] = [];

  // field 1: seq_id (uint64, varint) → tag = (1 << 3) | 0 = 0x08
  if (frame.seqId > 0n) {
    parts.push(Buffer.from([0x08]));
    parts.push(encodeVarint(frame.seqId));
  }
  // field 2: log_id (uint64) → tag = 0x10
  if (frame.logId > 0n) {
    parts.push(Buffer.from([0x10]));
    parts.push(encodeVarint(frame.logId));
  }
  // field 3: service (int32) → tag = 0x18
  if (frame.service !== 0) {
    parts.push(Buffer.from([0x18]));
    parts.push(encodeVarint(frame.service));
  }
  // field 4: method (int32) → tag = 0x20
  if (frame.method !== 0) {
    parts.push(Buffer.from([0x20]));
    parts.push(encodeVarint(frame.method));
  }
  // field 5: headers (repeated, embedded) → tag = (5 << 3) | 2 = 0x2a
  for (const h of frame.headers) {
    const encoded = encodeHeader(h);
    parts.push(Buffer.from([0x2a]));
    parts.push(encodeVarint(encoded.length));
    parts.push(encoded);
  }
  // field 8: payload (bytes) → tag = (8 << 3) | 2 = 0x42
  if (frame.payload && frame.payload.length > 0) {
    parts.push(Buffer.from([0x42]));
    parts.push(encodeVarint(frame.payload.length));
    parts.push(frame.payload);
  }

  return Buffer.concat(parts);
}

function decodeFrame(buf: Buffer): PbFrame {
  const frame: PbFrame = {
    seqId: 0n, logId: 0n, service: 0, method: 0, headers: [],
  };
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = decodeVarint(buf, pos);
    pos = newPos;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);

    if (wireType === VARINT) {
      const [value, nextPos] = decodeVarint(buf, pos);
      pos = nextPos;
      if (fieldNumber === 1) frame.seqId = value;
      else if (fieldNumber === 2) frame.logId = value;
      else if (fieldNumber === 3) frame.service = Number(value);
      else if (fieldNumber === 4) frame.method = Number(value);
    } else if (wireType === LENGTH_DELIMITED) {
      const [len, lenPos] = decodeVarint(buf, pos);
      pos = lenPos;
      const dataLen = Number(len);
      const data = buf.subarray(pos, pos + dataLen);
      pos += dataLen;

      if (fieldNumber === 5) {
        // Decode embedded PbHeader
        frame.headers.push(decodeHeaderMsg(data));
      } else if (fieldNumber === 8) {
        frame.payload = Buffer.from(data);
      }
    } else {
      // Unknown wire type — skip (shouldn't happen with this schema)
      break;
    }
  }
  return frame;
}

function decodeHeaderMsg(buf: Buffer): PbHeader {
  const h: PbHeader = { key: '', value: '' };
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = decodeVarint(buf, pos);
    pos = newPos;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === LENGTH_DELIMITED) {
      const [len, lenPos] = decodeVarint(buf, pos);
      pos = lenPos;
      const str = buf.subarray(pos, pos + Number(len)).toString('utf-8');
      pos += Number(len);
      if (fieldNumber === 1) h.key = str;
      else if (fieldNumber === 2) h.value = str;
    } else {
      break;
    }
  }
  return h;
}

function getHeaderValue(frame: PbFrame, key: string): string {
  return frame.headers.find(h => h.key === key)?.value ?? '';
}

function buildPing(seq: bigint, serviceId: number): PbFrame {
  return {
    seqId: seq,
    logId: 0n,
    service: serviceId,
    method: 0, // CONTROL
    headers: [{ key: 'type', value: 'ping' }],
  };
}

// ── Feishu Event Types ──

interface FeishuEvent {
  header: { event_type: string };
  event: any;
}

interface MsgReceivePayload {
  sender: {
    sender_id: { open_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    root_id?: string;
    mentions?: Array<{ id: { user_id?: string } }>;
  };
}

// ── Feishu Adapter ──

export class FeishuAdapter extends BaseAdapter {
  readonly name = 'feishu';

  private appId: string;
  private appSecret: string;
  private domain: string;
  private allowedUsers?: string[];

  private tokenCache: { token: string; refreshAfter: number } | null = null;
  private seenIds = new Map<string, number>();
  private ws: WebSocket | null = null;
  private running = false;
  private wsSeq = 0n;

  constructor() {
    super();
    const config = loadConfig();
    this.appId = config.feishuAppId || '';
    this.appSecret = config.feishuAppSecret || '';
    this.domain = config.feishuDomain || 'https://open.feishu.cn';
    this.allowedUsers = config.feishuAllowedUsers;
  }

  validateConfig(): string | null {
    if (!this.appId) return 'Feishu APP_ID is required';
    if (!this.appSecret) return 'Feishu APP_SECRET is required';
    return null;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[feishu] Starting WebSocket listener...');
    this.connectLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── WebSocket Connection Loop ──

  private async connectLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectWs();
      } catch (err) {
        console.error(`[feishu] WS error: ${err instanceof Error ? err.message : err}, reconnecting in 5s...`);
      }
      if (this.running) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  private async connectWs(): Promise<void> {
    const { url, pingInterval } = await this.getWsEndpoint();
    console.log(`[feishu] WS connecting: ${url.substring(0, 60)}...`);

    const serviceId = this.parseServiceId(url);

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      let lastRecv = Date.now();
      let pingTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      // Fragment cache for multi-part messages
      const fragCache = new Map<string, { parts: (Buffer | null)[]; ts: number }>();

      const cleanup = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        ws.removeAllListeners();
      };

      ws.on('open', () => {
        console.log(`[feishu] WS connected (service_id=${serviceId})`);

        // Send initial ping
        this.wsSeq++;
        const ping = buildPing(this.wsSeq, serviceId);
        ws.send(encodeFrame(ping));

        // Periodic ping
        const intervalMs = Math.max(10, pingInterval) * 1000;
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          this.wsSeq++;
          ws.send(encodeFrame(buildPing(this.wsSeq, serviceId)));
          // Clean old fragments
          const cutoff = Date.now() - 300_000;
          for (const [k, v] of fragCache) {
            if (v.ts < cutoff) fragCache.delete(k);
          }
        }, intervalMs);

        // Heartbeat timeout check
        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastRecv > WS_HEARTBEAT_TIMEOUT) {
            console.warn('[feishu] WS heartbeat timeout, reconnecting...');
            ws.close();
          }
        }, 10_000);
      });

      ws.on('message', (data: Buffer) => {
        lastRecv = Date.now();

        let frame: PbFrame;
        try {
          frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
        } catch (err) {
          console.error(`[feishu] WS proto decode failed: ${err}`);
          return;
        }

        // method=0 → CONTROL (ping/pong)
        if (frame.method === 0) {
          const type = getHeaderValue(frame, 'type');
          if (type === 'pong' && frame.payload) {
            // Update ping interval from pong payload
            try {
              const cfg = JSON.parse(frame.payload.toString('utf-8'));
              if (cfg.PingInterval && pingTimer) {
                const newInterval = Math.max(10, cfg.PingInterval) * 1000;
                clearInterval(pingTimer);
                pingTimer = setInterval(() => {
                  if (ws.readyState !== WebSocket.OPEN) return;
                  this.wsSeq++;
                  ws.send(encodeFrame(buildPing(this.wsSeq, serviceId)));
                }, newInterval);
              }
            } catch { /* ignore parse error */ }
          }
          return;
        }

        // method=1 → DATA (event)
        const msgType = getHeaderValue(frame, 'type');
        const msgId = getHeaderValue(frame, 'message_id');
        const sum = parseInt(getHeaderValue(frame, 'sum') || '1', 10) || 1;
        const seqNum = parseInt(getHeaderValue(frame, 'seq') || '0', 10);

        // ACK within 3s (required by Feishu)
        const ack: PbFrame = {
          ...frame,
          payload: Buffer.from('{"code":200,"headers":{},"data":[]}'),
          headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
        };
        ws.send(encodeFrame(ack));

        // Handle fragmentation
        let payload: Buffer;
        if (sum === 1 || !msgId || seqNum >= sum) {
          payload = frame.payload || Buffer.alloc(0);
        } else {
          let entry = fragCache.get(msgId);
          if (!entry || entry.parts.length !== sum) {
            entry = { parts: new Array(sum).fill(null), ts: Date.now() };
            fragCache.set(msgId, entry);
          }
          entry.parts[seqNum] = frame.payload || null;
          if (entry.parts.every(p => p !== null)) {
            payload = Buffer.concat(entry.parts.filter(Boolean) as Buffer[]);
            fragCache.delete(msgId);
          } else {
            return; // Still waiting for fragments
          }
        }

        if (msgType !== 'event') return;

        // Parse event
        let event: FeishuEvent;
        try {
          event = JSON.parse(payload.toString('utf-8'));
        } catch (err) {
          console.error(`[feishu] WS event JSON parse failed: ${err}`);
          return;
        }

        if (event.header.event_type !== 'im.message.receive_v1') return;

        const recv = event.event as MsgReceivePayload;
        const sender = recv.sender;
        const msg = recv.message;

        // Skip bot messages
        if (sender.sender_type === 'app' || sender.sender_type === 'bot') return;

        // Dedup
        const now = Date.now();
        // Clean old entries
        for (const [k, ts] of this.seenIds) {
          if (now - ts > DEDUP_WINDOW) this.seenIds.delete(k);
        }
        if (this.seenIds.has(msg.message_id)) return;
        this.seenIds.set(msg.message_id, now);

        // Group chat: require @bot (bot mention has no user_id)
        if (msg.chat_type === 'group') {
          const hasBotMention = msg.mentions?.some(m => !m.id.user_id);
          if (!hasBotMention) return;
        }

        // Authorization check
        const senderId = sender.sender_id.open_id || '';
        if (this.allowedUsers && this.allowedUsers.length > 0) {
          if (!this.allowedUsers.includes(senderId)) {
            console.log(`[feishu] Unauthorized user: ${senderId}`);
            return;
          }
        }

        // Parse content
        const text = this.extractText(msg.message_type, msg.content);
        if (text === null) {
          console.log(`[feishu] Unsupported message type: ${msg.message_type}`);
          return;
        }

        const inbound: InboundMessage = {
          adapter: 'feishu',
          chatId: msg.chat_id,
          messageId: msg.message_id,
          userId: senderId,
          text,
          chatType: msg.chat_type === 'group' ? 'group' : 'p2p',
          rootId: msg.root_id || undefined,
        };

        // Parse image/file attachments
        if (msg.message_type === 'image') {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed.image_key) {
              inbound.images = [{ key: parsed.image_key, messageId: msg.message_id }];
            }
          } catch { /* ignore */ }
        } else if (msg.message_type === 'file') {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed.file_key) {
              inbound.files = [{
                key: parsed.file_key,
                name: parsed.file_name || 'file',
                messageId: msg.message_id,
              }];
            }
          } catch { /* ignore */ }
        }

        this.emit('message', inbound);
      });

      ws.on('close', () => {
        console.log('[feishu] WS closed');
        cleanup();
        resolve();
      });

      ws.on('error', (err) => {
        console.error(`[feishu] WS error: ${err.message}`);
        cleanup();
        reject(err);
      });
    });
  }

  private parseServiceId(url: string): number {
    try {
      const u = new URL(url);
      return parseInt(u.searchParams.get('device_id') || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  private extractText(msgType: string, content: string): string | null {
    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(content);
        const text = (parsed.text || '').replace(/@_user_\d+/g, '').trim();
        return text || null;
      } catch {
        return content.trim() || null;
      }
    }
    if (msgType === 'image') return '[image]';
    if (msgType === 'file') {
      try {
        const parsed = JSON.parse(content);
        return `[file: ${parsed.file_name || 'unknown'}]`;
      } catch {
        return '[file]';
      }
    }
    return null;
  }

  // ── REST API: Token ──

  async getTenantAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.refreshAfter) {
      return this.tokenCache.token;
    }

    const base = this.getApiBase();
    const resp = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    const data = await resp.json() as any;
    if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg}`);

    const ttl = ((data.expire || 7200) * 1000) - TOKEN_REFRESH_SKEW;
    this.tokenCache = {
      token: data.tenant_access_token,
      refreshAfter: Date.now() + ttl,
    };
    return this.tokenCache.token;
  }

  private getApiBase(): string {
    const base = this.domain.replace(/\/+$/, '');
    return base.includes('/open-apis') ? base : base + '/open-apis';
  }

  // ── REST API: WS Endpoint ──

  private async getWsEndpoint(): Promise<{ url: string; pingInterval: number }> {
    const resp = await fetch(`${FEISHU_WS_BASE}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', locale: 'zh' },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
    });

    const data = await resp.json() as any;
    if (data.code !== 0) {
      throw new Error(`Feishu WS endpoint failed: code=${data.code} msg=${data.msg}`);
    }

    return {
      url: data.data?.URL || '',
      pingInterval: data.data?.ClientConfig?.PingInterval || 120,
    };
  }

  // ── REST API: reply_card (like acp-link) ──

  async createReply(messageId: string, initialText: string): Promise<ReplyHandle> {
    const token = await this.getTenantAccessToken();
    const base = this.getApiBase();
    const card = FeishuAdapter.buildCard(initialText);

    const resp = await fetch(`${base}/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: 'interactive',
        reply_in_thread: true,
      }),
    });

    const data = await resp.json() as any;
    if (data.code !== 0) {
      throw new Error(`Feishu reply_card failed: code=${data.code} msg=${data.msg}`);
    }

    return {
      replyId: data.data?.message_id || '',
      threadId: data.data?.thread_id || '',
    };
  }

  // ── REST API: update_card (like acp-link) ──

  async updateReply(handle: ReplyHandle, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const base = this.getApiBase();
    const card = FeishuAdapter.buildCard(text);

    const resp = await fetch(`${base}/im/v1/messages/${handle.replyId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: 'interactive',
      }),
    });

    const data = await resp.json() as any;
    if (data.code !== 0) {
      throw new Error(`Feishu update_card failed: code=${data.code} msg=${data.msg}`);
    }
  }

  // ── REST API: send text message ──

  async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const base = this.getApiBase();

    if (replyTo) {
      const resp = await fetch(`${base}/im/v1/messages/${replyTo}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: JSON.stringify({ text }),
          msg_type: 'text',
        }),
      });
      const data = await resp.json() as any;
      return data.data?.message_id || '';
    }

    const resp = await fetch(`${base}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      }),
    });
    const data = await resp.json() as any;
    return data.data?.message_id || '';
  }

  // ── REST API: download resource ──

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Buffer> {
    const token = await this.getTenantAccessToken();
    const base = this.getApiBase();
    const url = `${base}/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) throw new Error(`Download resource failed: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  // ── Thread Aggregation (like acp-link's aggregate_thread) ──

  async aggregateThread(
    threadId: string,
    chatId: string,
  ): Promise<{
    texts: string[];
    images: Array<{ key: string; messageId: string }>;
    files: Array<{ key: string; name: string; messageId: string }>;
  }> {
    const token = await this.getTenantAccessToken();
    const base = this.getApiBase();

    const allMessages: any[] = [];
    let pageToken: string | null = null;

    while (true) {
      let url = `${base}/im/v1/messages?container_id_type=thread&container_id=${threadId}&page_size=50`;
      if (pageToken) url += `&page_token=${pageToken}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json() as any;
      if (data.code !== 0) throw new Error(`Get thread messages failed: ${data.msg}`);

      allMessages.push(...(data.data?.items || []));
      pageToken = data.data?.page_token || null;
      if (!pageToken) break;
    }

    const texts: string[] = [];
    const images: Array<{ key: string; messageId: string }> = [];
    const files: Array<{ key: string; name: string; messageId: string }> = [];

    for (const msg of allMessages) {
      const senderType = msg?.sender?.sender_type || '';
      if (senderType === 'app' || senderType === 'bot') continue;

      const msgId = msg.message_id || '';
      const msgType = msg.msg_type || '';
      const contentStr = msg.body?.content || '';

      if (msgType === 'text') {
        try {
          const parsed = JSON.parse(contentStr);
          const text = (parsed.text || '').trim();
          if (text) texts.push(text);
        } catch {
          if (contentStr.trim()) texts.push(contentStr.trim());
        }
      } else if (msgType === 'image') {
        try {
          const parsed = JSON.parse(contentStr);
          if (parsed.image_key) images.push({ key: parsed.image_key, messageId: msgId });
        } catch { /* skip */ }
      } else if (msgType === 'file') {
        try {
          const parsed = JSON.parse(contentStr);
          if (parsed.file_key) {
            files.push({ key: parsed.file_key, name: parsed.file_name || 'file', messageId: msgId });
          }
        } catch { /* skip */ }
      }
    }

    return { texts, images, files };
  }

  // ── Card Builder (matches acp-link's build_card) ──

  static buildCard(markdown: string): object {
    return {
      elements: [{
        tag: 'markdown',
        content: markdown,
      }],
    };
  }
}
