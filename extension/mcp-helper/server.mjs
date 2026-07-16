import http from 'node:http';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;
const MAX_EXPORT_FILE_BYTES = 5 * 1024 * 1024;

/** MCP HTTP/WS 路径只认 pathname，忽略 query（Cursor Streamable HTTP 会对 /mcp?... 带会话参数） */
function isMcpRequestPath(reqUrl) {
  if (!reqUrl || typeof reqUrl !== 'string') return false;
  try {
    return new URL(reqUrl, 'http://127.0.0.1').pathname === '/mcp';
  } catch {
    const base = reqUrl.split('?')[0] || '';
    return base === '/mcp';
  }
}

const args = process.argv.slice(2);
let cliDefaultPort = 9527;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    cliDefaultPort = parseInt(args[i + 1], 10);
    i++;
  }
}

function normalizePort(p) {
  const n = parseInt(p, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return 9527;
  return n;
}

let currentPort = 0;
let httpListening = false;

// ==================== 工具定义缓存 & 调用回调 ====================

let cachedTools = [];
const pendingCalls = new Map();

function broadcastToolsListChanged() {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  });
  for (const [clientId, res] of httpClients.entries()) {
    try {
      if (res.writableEnded) {
        httpClients.delete(clientId);
        continue;
      }
      res.write(`event: message\ndata: ${payload}\n\n`);
    } catch {
      httpClients.delete(clientId);
    }
  }
}

// ==================== Native Messaging（stdin/stdout） ====================

function readNMMessage() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let headerBuf = Buffer.alloc(0);

    const onReadable = () => {
      while (true) {
        const chunk = stdin.read();
        if (!chunk) break;
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= 4) {
          const msgLen = headerBuf.readUInt32LE(0);
          if (headerBuf.length >= 4 + msgLen) {
            const body = headerBuf.subarray(4, 4 + msgLen);
            headerBuf = headerBuf.subarray(4 + msgLen);
            try {
              resolve(JSON.parse(body.toString('utf-8')));
            } catch (e) {
              reject(e);
            }
            stdin.removeListener('readable', onReadable);
            return;
          }
        }
      }
    };

    stdin.on('readable', onReadable);
    stdin.on('end', () => {
      stdin.removeListener('readable', onReadable);
      resolve(null);
    });
    stdin.on('error', reject);
  });
}

function writeNMMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function listenStdin() {
  while (true) {
    const msg = await readNMMessage();
    if (msg === null) {
      log('stdin 已关闭，退出');
      process.exit(0);
    }
    handleNMMessage(msg);
  }
}

/** fileName must be plain basename (no separators / ..). */
function safeResolveUnderExportDir(dirPath, fileName) {
  if (!dirPath || typeof dirPath !== 'string' || !fileName || typeof fileName !== 'string') return null;
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.includes('..') || /[/\\\\]/.test(trimmed)) return null;
  const bn = path.basename(trimmed);
  if (bn !== trimmed) return null;
  const base = path.resolve(dirPath.trim());
  const full = path.resolve(base, bn);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

function handleNMMessage(msg) {
  switch (msg.type) {
    case 'PING': {
      writeNMMessage({ type: 'PONG' });
      break;
    }
    case 'SYNC_TOOLS': {
      const toolsObj = msg.tools || {};
      cachedTools = Object.entries(toolsObj)
        .filter(([, v]) => v.enabled !== false)
        .map(([, v]) => {
          const { _meta, ...rest } = v;
          return rest;
        });
      log(`已同步 ${cachedTools.length} 个工具`);
      broadcastToolsListChanged();
      break;
    }
    case 'CALL_RESULT': {
      const { callId, result } = msg;
      if (pendingCalls.has(callId)) {
        const { resolve } = pendingCalls.get(callId);
        pendingCalls.delete(callId);
        resolve(result);
      }
      break;
    }
    case 'START_SERVER': {
      startHttpServer(msg.port != null ? msg.port : cliDefaultPort);
      break;
    }
    case 'STOP_SERVER': {
      stopHttpServer();
      break;
    }
    case 'SHUTDOWN': {
      log('收到 SHUTDOWN 命令，退出');
      if (httpListening) {
        server.close(() => process.exit(0));
      } else {
        process.exit(0);
      }
      break;
    }
    case 'LIST_EXPORT_DIR': {
      const { requestId, dirPath } = msg;
      (async () => {
        try {
          if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
            writeNMMessage({ type: 'LIST_EXPORT_DIR_RESULT', requestId, ok: false, error: '目录路径为空' });
            return;
          }
          const resolved = path.resolve(dirPath.trim());
          await fs.stat(resolved);
          const entries = await fs.readdir(resolved, { withFileTypes: true });
          const files = [];
          for (const ent of entries) {
            if (!ent.isFile()) continue;
            if (!ent.name.toLowerCase().endsWith('.json')) continue;
            const fp = path.join(resolved, ent.name);
            const st = await fs.stat(fp);
            files.push({ name: ent.name, mtimeMs: st.mtimeMs });
          }
          files.sort((a, b) => a.name.localeCompare(b.name));
          writeNMMessage({ type: 'LIST_EXPORT_DIR_RESULT', requestId, ok: true, files });
        } catch (e) {
          writeNMMessage({
            type: 'LIST_EXPORT_DIR_RESULT',
            requestId,
            ok: false,
            error: e && e.message ? e.message : String(e),
          });
        }
      })();
      break;
    }
    case 'READ_EXPORT_FILE': {
      const { requestId, dirPath, fileName } = msg;
      (async () => {
        try {
          if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
            writeNMMessage({ type: 'READ_EXPORT_FILE_RESULT', requestId, ok: false, error: '目录路径为空' });
            return;
          }
          const full = safeResolveUnderExportDir(dirPath, fileName || '');
          if (!full) {
            writeNMMessage({ type: 'READ_EXPORT_FILE_RESULT', requestId, ok: false, error: '非法文件名或路径' });
            return;
          }
          const st = await fs.stat(full);
          if (st.size > MAX_EXPORT_FILE_BYTES) {
            writeNMMessage({ type: 'READ_EXPORT_FILE_RESULT', requestId, ok: false, error: `文件超过 ${MAX_EXPORT_FILE_BYTES} 字节` });
            return;
          }
          const text = await fs.readFile(full, 'utf8');
          writeNMMessage({ type: 'READ_EXPORT_FILE_RESULT', requestId, ok: true, text });
        } catch (e) {
          writeNMMessage({
            type: 'READ_EXPORT_FILE_RESULT',
            requestId,
            ok: false,
            error: e && e.message ? e.message : String(e),
          });
        }
      })();
      break;
    }
    case 'WRITE_EXPORT_FILE': {
      const { requestId, dirPath, fileName, text } = msg;
      (async () => {
        try {
          if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
            writeNMMessage({ type: 'WRITE_EXPORT_FILE_RESULT', requestId, ok: false, error: '目录路径为空' });
            return;
          }
          if (typeof text !== 'string') {
            writeNMMessage({ type: 'WRITE_EXPORT_FILE_RESULT', requestId, ok: false, error: '内容无效' });
            return;
          }
          const byteLen = Buffer.byteLength(text, 'utf8');
          if (byteLen > MAX_EXPORT_FILE_BYTES) {
            writeNMMessage({
              type: 'WRITE_EXPORT_FILE_RESULT',
              requestId,
              ok: false,
              error: `内容超过 ${MAX_EXPORT_FILE_BYTES} 字节`,
            });
            return;
          }
          const base = path.resolve(dirPath.trim());
          await fs.mkdir(base, { recursive: true });
          const full = safeResolveUnderExportDir(dirPath, fileName || '');
          if (!full) {
            writeNMMessage({ type: 'WRITE_EXPORT_FILE_RESULT', requestId, ok: false, error: '非法文件名或路径' });
            return;
          }
          await fs.writeFile(full, text, 'utf8');
          writeNMMessage({ type: 'WRITE_EXPORT_FILE_RESULT', requestId, ok: true, savedPath: full });
        } catch (e) {
          writeNMMessage({
            type: 'WRITE_EXPORT_FILE_RESULT',
            requestId,
            ok: false,
            error: e && e.message ? e.message : String(e),
          });
        }
      })();
      break;
    }
  }
}

// ==================== MCP 协议处理核心 ====================

function processMCPMessage(msg, sendResponse, clientInfo) {
  // MCP 通知：JSON-RPC 可无 id，但 Streamable HTTP 仍必须结束响应，否则客户端会一直等待（无法进入 tools/list）
  if (msg.method === 'notifications/initialized') {
    sendResponse({ __mcpNotificationAck: true });
    return;
  }

  // initialize
  if (msg.method === 'initialize') {
    if (AUTH_TOKEN) {
      const clientToken = msg.params?.clientInfo?.token
        || msg.params?._meta?.token
        || msg.params?.token;
      if (clientToken !== AUTH_TOKEN) {
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32001, message: 'Unauthorized' },
        });
        return false;
      }
    }
    sendResponse({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'ai-request-analyzer-mcp', version: '1.0.0' },
      },
    });
    return true;
  }

  // tools/list
  if (msg.method === 'tools/list') {
    sendResponse({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: cachedTools },
    });
    return true;
  }

  // tools/call
  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const arguments_ = msg.params?.arguments || {};
    const callId = crypto.randomUUID();

    const timeout = setTimeout(() => {
      if (pendingCalls.has(callId)) {
        pendingCalls.delete(callId);
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `工具调用超时: ${toolName}` }],
            isError: true,
          },
        });
      }
    }, 30000);

    pendingCalls.set(callId, {
      resolve(result) {
        clearTimeout(timeout);
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: false,
          },
        });
      },
    });

    writeNMMessage({
      type: 'CALL_REQUEST',
      callId,
      toolName,
      arguments: arguments_,
    });
    return true;
  }

  // 未知方法
  sendResponse({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
  return true;
}

// ==================== Streamable HTTP 传输 ====================

const httpClients = new Map();

function requestPathname(reqUrl) {
  if (!reqUrl || typeof reqUrl !== 'string') return '/';
  try {
    return new URL(reqUrl, 'http://127.0.0.1').pathname;
  } catch {
    return reqUrl.split('?')[0] || '/';
  }
}

function handleHTTPRequest(req, res) {
  const url = req.url;
  const pathname = requestPathname(url);

  if (pathname === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: currentPort, tools: cachedTools.length }));
    return;
  }

  if (!isMcpRequestPath(url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  // POST: JSON-RPC 请求
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // 如果是初始化请求，返回普通 JSON 响应
      // 如果是通知或需要流式响应的，用 SSE

      const isNotification = msg.id === undefined || msg.id === null;

      if (isNotification || msg.method === 'notifications/initialized') {
        processMCPMessage(msg, (resp) => {
          if (resp && resp.__mcpNotificationAck) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp));
        });
        return;
      }

      // 普通请求：直接返回 JSON 响应
      processMCPMessage(msg, (resp) => {
        if (resp && resp.__mcpNotificationAck) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(resp));
      });
    });
    return;
  }

  // GET: SSE 流（用于服务端向客户端推送）
  if (req.method === 'GET') {
    const clientId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 发送一个初始事件表示连接建立
    res.write(`event: endpoint\ndata: /mcp?clientId=${clientId}\n\n`);

    httpClients.set(clientId, res);

    req.on('close', () => {
      httpClients.delete(clientId);
    });

    // 保持连接活跃
    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        return;
      }
      res.write(':keepalive\n\n');
    }, 30000);

    req.on('close', () => clearInterval(keepAlive));
    return;
  }

  // 其他方法
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
}

// ==================== WebSocket 传输（保持兼容） ====================

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsHandshake(key) {
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const first = buf[0];
  const second = buf[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLen = second & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
  offset += masked ? 4 : 0;

  if (buf.length < offset + payloadLen) return null;

  let payload = buf.subarray(offset, offset + payloadLen);
  if (masked && maskKey) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return { fin, opcode, payload, frameLen: offset + payloadLen };
}

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf-8');
  const maskBit = 0;
  let header;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = maskBit | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code = 1000, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf-8'));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2, 'utf-8');
  const header = Buffer.alloc(2);
  header[0] = 0x88;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

function encodePongFrame(data = '') {
  const payload = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(2);
  header[0] = 0x8a;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

const wsClients = new Set();

function handleWSConnection(socket) {
  let authed = !AUTH_TOKEN;
  let buffer = Buffer.alloc(0);

  wsClients.add(socket);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const frame = decodeFrame(buffer);
      if (!frame) break;

      buffer = buffer.subarray(frame.frameLen);

      switch (frame.opcode) {
        case 0x1: {
          const text = frame.payload.toString('utf-8');
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          processMCPMessage(msg, (resp) => {
            if (resp && resp.__mcpNotificationAck) return;
            socket.write(encodeTextFrame(JSON.stringify(resp)));
          }, { authed });
          if (!authed) authed = true;
          break;
        }
        case 0x9: {
          socket.write(encodePongFrame(frame.payload.toString('utf-8')));
          break;
        }
        case 0x8: {
          socket.write(encodeCloseFrame());
          socket.end();
          wsClients.delete(socket);
          break;
        }
        case 0xa:
          break;
      }
    }
  });

  socket.on('close', () => {
    wsClients.delete(socket);
  });

  socket.on('error', (err) => {
    log(`WebSocket 连接错误: ${err.message}`);
    wsClients.delete(socket);
  });
}

// ==================== HTTP Server ====================

const server = http.createServer(handleHTTPRequest);

server.on('upgrade', (req, socket, head) => {
  if (!isMcpRequestPath(req.url)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write(wsHandshake(key));
  handleWSConnection(socket);
});

function startHttpServer(targetPort) {
  const port = normalizePort(targetPort);
  if (httpListening && currentPort === port) {
    writeNMMessage({ type: 'SERVER_STARTED', port });
    return;
  }

  const onListenError = (err) => {
    server.removeListener('error', onListenError);
    httpListening = false;
    currentPort = 0;
    const msg =
      err && err.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用`
        : (err && err.message ? err.message : String(err));
    writeNMMessage({ type: 'SERVER_START_FAILED', port, error: msg });
  };

  const onListenSuccess = () => {
    server.removeListener('error', onListenError);
    httpListening = true;
    currentPort = port;
    log(`MCP Server 启动，监听 localhost:${port}/mcp`);
    log('支持传输: Streamable HTTP (POST/GET) + WebSocket');
    if (AUTH_TOKEN) log('鉴权 Token 已配置');
    else log('未配置鉴权 Token，允许所有连接');
    writeNMMessage({ type: 'SERVER_STARTED', port });
  };

  const bindListen = () => {
    server.once('error', onListenError);
    server.listen(port, '127.0.0.1', onListenSuccess);
  };

  if (httpListening) {
    server.close(() => {
      httpListening = false;
      currentPort = 0;
      bindListen();
    });
  } else {
    bindListen();
  }
}

function stopHttpServer() {
  if (!httpListening) {
    writeNMMessage({ type: 'SERVER_STOPPED' });
    return;
  }
  server.close(() => {
    httpListening = false;
    currentPort = 0;
    writeNMMessage({ type: 'SERVER_STOPPED' });
  });
}

// ==================== 启动 stdin 监听 ====================

process.stdin.resume();
listenStdin().catch((err) => {
  log(`stdin 监听错误: ${err.message}`);
  process.exit(1);
});

// 兼容旧扩展：2 秒内未收到 START_SERVER 则按 CLI/默认端口启动
setTimeout(() => {
  if (!httpListening) {
    startHttpServer(cliDefaultPort);
  }
}, 2000);

// ==================== 工具函数 ====================

function log(msg) {
  process.stderr.write(`[MCP-Helper] ${new Date().toISOString()} ${msg}\n`);
}
