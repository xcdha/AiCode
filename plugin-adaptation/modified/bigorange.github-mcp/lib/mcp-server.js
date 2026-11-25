'use strict';

const http = require('http');
const crypto = require('crypto');
const store = require('./store');
const tools = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-mcp', title: 'GitHub MCP', version: '1.0.0' };

let server = null;
let currentPort = 0;
let currentHost = '';
let startedAt = 0;
let requestCount = 0;
let lastError = '';
const sessions = new Set();

// 以端口实际可连为准：重载后旧进程可能还占着端口，内存里的 server 却为空
async function statusLive() {
  const current = status();
  if (current.running) return current;
  const config = store.readConfig();
  const port = Number(config.port) || 9999;
  const alive = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/__whoami', method: 'GET', timeout: 900 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).server === 'github-mcp');
          } catch (e) {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
  if (alive) {
    return Object.assign({}, current, {
      running: true,
      url: `http://127.0.0.1:${port}/mcp`,
      port,
      external: true,
    });
  }
  return current;
}

function status() {
  const config = store.readConfig();
  return {
    running: !!server,
    url: server ? `http://${displayHost(currentHost)}:${currentPort}/mcp` : '',
    port: server ? currentPort : Number(config.port) || 0,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    requests: requestCount,
    sessions: sessions.size,
    lastError: lastError || null,
  };
}

function displayHost(host) {
  return !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

function log(level, message) {
  process.stderr.write(`[github-mcp] ${level}: ${message}\n`);
}

function jsonResponse(res, statusCode, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(
    statusCode,
    Object.assign(
      {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      },
      extraHeaders || {},
    ),
  );
  res.end(body);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function toolText(payload, isError) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], isError: !!isError };
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    const version = SUPPORTED_VERSIONS.indexOf(requested) >= 0 ? requested : PROTOCOL_VERSION;
    return {
      response: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'GitHub 数据访问工具。先用 status 检查登录状态；未登录时让用户在插件配置页登录，或调用 login 传入 Personal Access Token。列表类工具用于「登录后自动获取仓库项目」。',
      }),
      session: true,
    };
  }

  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) {
    return { response: null, isNotification: true };
  }

  if (method === 'ping') return { response: rpcResult(id, {}) };

  if (method === 'tools/list') {
    return { response: rpcResult(id, { tools: tools.mcpToolList() }) };
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await tools.invoke(name, args);
      return { response: rpcResult(id, toolText(result)) };
    } catch (e) {
      const message2 = String((e && e.message) || e);
      const code = e && e.code;
      const hint =
        code === 'NOT_LOGGED_IN'
          ? '\n\n提示：在 Guru「设置 → 插件 → GitHub MCP → 打开配置」中登录，或在客户端里调用 login 工具。'
          : '';
      return { response: rpcResult(id, toolText(`调用失败：${message2}${hint}`, true)) };
    }
  }

  if (method === 'resources/list') return { response: rpcResult(id, { resources: [] }) };
  if (method === 'prompts/list') return { response: rpcResult(id, { prompts: [] }) };

  if (isNotification) return { response: null, isNotification: true };
  return { response: rpcError(id, -32601, `Method not found: ${method}`) };
}

async function readBody(req, limitBytes) {
  const cap = limitBytes || 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/__whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'github-mcp', pid: process.pid, port: currentPort }));
    return;
  }

  // 端口接管：同一插件的新实例启动时，让占着端口的旧实例自行退出
  if (url.pathname === '/__shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    log('info', '收到接管请求，进程退出以释放端口');
    setTimeout(() => process.exit(0), 60);
    return;
  }

  if (url.pathname !== '/mcp' && url.pathname !== '/') {
    jsonResponse(res, 404, rpcError(null, -32601, 'Not Found'));
    return;
  }

  requestCount += 1;

  if (req.method === 'GET') {
    // 不提供服务端推送流；告知客户端用 POST
    res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SSE stream not supported, use POST with JSON-RPC' }));
    return;
  }

  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST, DELETE' });
    res.end();
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    jsonResponse(res, 413, rpcError(null, -32600, String(e.message || e)));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    jsonResponse(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }

  const extraHeaders = {};
  const batch = Array.isArray(parsed);
  const messages = batch ? parsed : [parsed];
  const responses = [];
  let wantSession = false;

  for (const message of messages) {
    let outcome;
    try {
      outcome = await handleMessage(message);
    } catch (e) {
      outcome = { response: rpcError(message && message.id, -32603, String((e && e.message) || e)) };
    }
    if (outcome.session) wantSession = true;
    if (outcome.response) responses.push(outcome.response);
  }

  // 客户端带着有效会话时，所有响应都回显同一个 id；否则新建
  let sid = req.headers['mcp-session-id'];
  const validSession = sid && sessions.has(sid);
  if (!validSession && (wantSession || sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    sessions.add(sid);
    if (sessions.size > 32) {
      const first = sessions.values().next().value;
      sessions.delete(first);
    }
  }
  if (sid && (validSession || wantSession)) extraHeaders['Mcp-Session-Id'] = sid;

  if (!responses.length) {
    res.writeHead(202, extraHeaders);
    res.end();
    return;
  }

  jsonResponse(res, 200, batch ? responses : responses[0], extraHeaders);
}

function start() {
  if (server) return Promise.resolve(status());
  const config = store.readConfig();
  const port = Number(config.port) || 9999;
  const host = config.host || '127.0.0.1';
  return listen(port, host, 0);

  function listen(listenPort, listenHost, attempt) {
    return new Promise((resolve, reject) => {
      const instance = http.createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
          lastError = String((e && e.message) || e);
          log('error', lastError);
          try {
            jsonResponse(res, 500, rpcError(null, -32603, lastError));
          } catch (x) {
            /* 响应已发出 */
          }
        });
      });
      instance.keepAliveTimeout = 30000;

      instance.on('error', async (e) => {
        const code = e && e.code;
        // 端口被自己插件的旧实例占着：请求它退出，等端口释放后重试一次
        if (code === 'EADDRINUSE' && attempt === 0 && hostIsLoopback(listenHost)) {
          const taken = await isOwnServer(listenPort);
          if (taken) {
            log('info', `端口 ${listenPort} 由旧实例占用，请求其退出后接管`);
            await requestShutdown(listenPort);
            await new Promise((r) => setTimeout(r, 400));
            listen(listenPort, listenHost, 1).then(resolve, reject);
            return;
          }
        }
        lastError =
          code === 'EADDRINUSE'
            ? `端口 ${listenPort} 已被其他程序占用，请到插件配置页换一个端口。`
            : String((e && e.message) || e);
        server = null;
        const error = new Error(lastError);
        error.code = code;
        reject(error);
      });

      instance.listen(listenPort, listenHost, () => {
        server = instance;
        currentPort = instance.address().port;
        currentHost = listenHost;
        startedAt = Date.now();
        lastError = '';
        log('info', `MCP 服务已监听 http://${displayHost(listenHost)}:${currentPort}/mcp`);
        resolve(status());
      });
    });
  }
}

function hostIsLoopback(host) {
  return !host || host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::';
}

// 判断占着端口的服务是不是本插件自己的实例
function isOwnServer(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/__whoami', method: 'GET', timeout: 1200 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            resolve(info && info.server === 'github-mcp');
          } catch (e) {
            resolve(false);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function requestShutdown(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/__shutdown', method: 'POST', timeout: 1500 },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

function stop() {
  if (!server) return Promise.resolve(status());
  const instance = server;
  server = null;
  return new Promise((resolve) => {
    instance.close(() => {
      sessions.clear();
      log('info', 'MCP 服务已停止');
      resolve(status());
    });
    setTimeout(() => resolve(status()), 1500);
  });
}

async function restart(patch) {
  const wasRunning = !!server;
  if (wasRunning) await stop();
  if (patch) store.writeConfig(patch);
  return start();
}

module.exports = { start, stop, restart, status, statusLive };
