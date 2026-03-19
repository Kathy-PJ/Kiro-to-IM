/**
 * Embedded MCP Server — exposes Feishu tools to kiro-cli agent.
 *
 * Implements a Streamable HTTP MCP Server (like acp-link) that provides:
 *   - feishu_send_file: Upload and send files/images to Feishu chats
 *
 * The server listens on localhost and is registered with kiro-cli
 * via the mcpServers parameter in session/new.
 *
 * Architecture follows acp-link's mcp.rs + feishu_tools.rs.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

interface McpState {
  sessionId: string | null;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: string;
  tokenCache: { token: string; expiresAt: number } | null;
}

// ── Feishu API helpers ──

async function getToken(state: McpState): Promise<string> {
  if (state.tokenCache && Date.now() < state.tokenCache.expiresAt) {
    return state.tokenCache.token;
  }

  const domain = state.feishuDomain.includes('/open-apis')
    ? state.feishuDomain
    : state.feishuDomain + '/open-apis';

  const resp = await fetch(`${domain}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: state.feishuAppId, app_secret: state.feishuAppSecret }),
  });

  const data = await resp.json() as any;
  if (data.code !== 0) throw new Error(`Token error: ${data.msg}`);

  state.tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + ((data.expire || 7200) - 120) * 1000,
  };
  return state.tokenCache.token;
}

function isImageFile(filePath: string): boolean {
  const ext = filePath.toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].some(e => ext.endsWith(e));
}

async function uploadImage(state: McpState, fileName: string, data: Buffer): Promise<string> {
  const token = await getToken(state);
  const domain = state.feishuDomain.includes('/open-apis') ? state.feishuDomain : state.feishuDomain + '/open-apis';
  const boundary = '----FormBoundary' + crypto.randomUUID().replace(/-/g, '');

  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ];

  const bodyStart = Buffer.from(bodyParts[0] + bodyParts[1], 'utf-8');
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([bodyStart, data, bodyEnd]);

  const resp = await fetch(`${domain}/im/v1/images`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const result = await resp.json() as any;
  if (result.code !== 0) throw new Error(`Upload image failed: ${result.msg}`);
  return result.data?.image_key || '';
}

async function uploadFile(state: McpState, fileName: string, data: Buffer): Promise<string> {
  const token = await getToken(state);
  const domain = state.feishuDomain.includes('/open-apis') ? state.feishuDomain : state.feishuDomain + '/open-apis';

  // Detect file type
  const ext = path.extname(fileName).toLowerCase();
  const fileType = ['.xls', '.xlsx', '.ppt', '.pptx'].includes(ext) ? 'stream'
    : ['.doc', '.docx'].includes(ext) ? 'doc'
    : ['.pdf'].includes(ext) ? 'pdf' : 'stream';

  const boundary = '----FormBoundary' + crypto.randomUUID().replace(/-/g, '');
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ];

  const bodyStart = Buffer.from(bodyParts.join(''), 'utf-8');
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([bodyStart, data, bodyEnd]);

  const resp = await fetch(`${domain}/im/v1/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const result = await resp.json() as any;
  if (result.code !== 0) throw new Error(`Upload file failed: ${result.msg}`);
  return result.data?.file_key || '';
}

async function sendReply(state: McpState, messageId: string, msgType: string, content: string): Promise<void> {
  const token = await getToken(state);
  const domain = state.feishuDomain.includes('/open-apis') ? state.feishuDomain : state.feishuDomain + '/open-apis';

  const resp = await fetch(`${domain}/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ content, msg_type: msgType }),
  });

  const result = await resp.json() as any;
  if (result.code !== 0) throw new Error(`Send reply failed: ${result.msg}`);
}

// ── MCP Tool: feishu_send_file ──

async function handleSendFile(args: any, state: McpState): Promise<{ content: any[]; isError?: boolean }> {
  const filePath = args.file_path || '';
  const messageId = args.message_id || '';
  const fileName = args.file_name || path.basename(filePath) || 'file';

  if (!filePath || !messageId) {
    return { content: [{ type: 'text', text: 'file_path and message_id are required' }], isError: true };
  }

  try {
    const data = fs.readFileSync(filePath);

    if (isImageFile(filePath)) {
      const imageKey = await uploadImage(state, fileName, data);
      await sendReply(state, messageId, 'image', JSON.stringify({ image_key: imageKey }));
      console.log(`[mcp-server] Image sent: ${fileName} → ${imageKey}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'sent', type: 'image', image_key: imageKey }) }] };
    } else {
      const fileKey = await uploadFile(state, fileName, data);
      await sendReply(state, messageId, 'file', JSON.stringify({ file_key: fileKey }));
      console.log(`[mcp-server] File sent: ${fileName} → ${fileKey}`);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'sent', type: 'file', file_key: fileKey }) }] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-server] feishu_send_file failed: ${msg}`);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

// ── MCP JSON-RPC handlers ──

const TOOLS_LIST = [{
  name: 'feishu_send_file',
  description: 'Upload and send a file to the current Feishu chat thread. For image files (.png/.jpg/.gif/.webp/.bmp), sent as inline image; otherwise as file attachment. Extract message_id from [feishu_context] in the conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to upload' },
      message_id: { type: 'string', description: 'The Feishu message_id to reply to (from feishu_context)' },
      file_name: { type: 'string', description: 'Optional display name for the file' },
    },
    required: ['file_path', 'message_id'],
  },
}];

function handleRequest(method: string, params: any, id: any, state: McpState): any | Promise<any> {
  switch (method) {
    case 'initialize': {
      state.sessionId = crypto.randomUUID();
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'kiro-to-im-mcp', version: '0.1.0' },
        },
      };
    }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS_LIST } };
    case 'tools/call': {
      const toolName = params?.name || '';
      const args = params?.arguments || {};
      if (toolName === 'feishu_send_file') {
        return handleSendFile(args, state).then(result => ({
          jsonrpc: '2.0', id, result,
        }));
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── HTTP Server ──

export function startMcpServer(
  feishuAppId: string,
  feishuAppSecret: string,
  feishuDomain: string,
  port: number = 9800,
): Promise<http.Server> {
  const state: McpState = {
    sessionId: null,
    feishuAppId,
    feishuAppSecret,
    feishuDomain: feishuDomain || FEISHU_API_BASE,
    tokenCache: null,
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      if (req.method === 'GET') {
        res.writeHead(405);
        res.end('SSE not supported');
        return;
      }

      if (req.method === 'DELETE') {
        state.sessionId = null;
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf-8');

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // Notification (no id) → 202
      if (parsed.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const { id, method, params } = parsed;
      const result = await handleRequest(method, params, id, state);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (state.sessionId) headers['mcp-session-id'] = state.sessionId;

      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[mcp-server] Listening on http://127.0.0.1:${port}/mcp`);
      resolve(server);
    });

    server.on('error', reject);
  });
}
