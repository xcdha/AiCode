'use strict';

/**
 * 本地 OpenAI 兼容网关。
 *
 * 路由：
 *   GET  /health                 健康检查
 *   GET  /v1/models              模型清单（所有供应商合并，带 `@昵称` 后缀）
 *   GET  /v1/me                  账号与积分概览
 *   POST /v1/chat/completions    对话（流式/非流式）
 *
 * 与 App 版一致：模型 ID 用 `模型名@供应商昵称` 形式，同名模型不会被合并掉。
 */

const http = require('http');
const registry = require('./registry');
const accounts = require('./accounts');
const sse = require('./sse');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

let server = null;
let listenPort = 0;
let apiKeys = [];

// ── 鉴权 ──────────────────────────────────────────────────────

/**
 * 校验 API Key。
 *
 * 没配密钥时放行（本机自用方便）；配了就强制校验。
 * 支持 `Authorization: Bearer xxx` 与 `x-api-key: xxx` 两种，与 App 版一致。
 */
function authorized(req) {
  const expected = apiKeys.filter((k) => String(k || '').trim());
  if (expected.length === 0) return true;
  const header = String(req.headers.authorization || '');
  let presented = '';
  if (header) {
    const idx = header.indexOf(' ');
    if (idx > 0 && header.slice(0, idx).toLowerCase() === 'bearer') {
      presented = header.slice(idx + 1).trim();
    }
  }
  if (!presented) presented = String(req.headers['x-api-key'] || '').trim();
  if (!presented) return false;
  return expected.includes(presented);
}

// ── 响应工具 ──────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendError(res, status, message, type, code) {
  sendJson(res, status, {
    error: {
      message: String(message || '请求失败'),
      type: type || 'proxy_error',
      code: code === undefined ? null : code,
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── 模型 ID 编解码 ────────────────────────────────────────────
//
// 对外是 `模型名@供应商昵称`，收到请求时再拆开路由到对应供应商。

function publicId(modelId, providerDisplayName) {
  return `${modelId}@${providerDisplayName}`;
}

function splitModelId(raw) {
  const text = String(raw || '');
  const at = text.lastIndexOf('@');
  if (at <= 0) return { model: text, owner: '' };
  return { model: text.slice(0, at), owner: text.slice(at + 1) };
}

/** 按昵称找供应商（也允许直接用 id）。 */
function providerByOwner(owner) {
  if (!owner) return null;
  const all = registry.allProviders();
  const byName = all.find((p) => p.displayName === owner);
  if (byName) return byName;
  return registry.provider(owner);
}

// ── 路由：模型清单 ────────────────────────────────────────────

async function handleModels(req, res) {
  if (!authorized(req)) return sendError(res, 401, 'A valid proxy API key is required');

  const providers = registry.allProviders();
  const results = await Promise.all(
    providers.map(async (p) => {
      const account = registry.pickAccount(p.id);
      if (!account) return [];
      try {
        const list = await p.fetchModels(account);
        if (!list || list.length === 0) {
          // 空列表往往是上游改版或凭证失效，不记日志就完全看不见
          accounts.log('warn', `${p.displayName} 模型目录返回 0 条`);
          return [];
        }
        return (list || []).map((m) => ({
          id: publicId(m.id, p.displayName),
          object: 'model',
          created: 0,
          owned_by: p.displayName,
          provider: p.id,
          name: m.name || m.id,
          context_length: m.contextWindow || 0,
          context_window: m.contextWindow || 0,
          max_context_tokens: m.contextWindow || 0,
          capabilities: {
            tools: m.supportsTools === true,
            tool_calls: m.supportsTools === true,
            reasoning: m.supportsReasoning === true,
            thinking: m.supportsReasoning === true,
          },
          supports_tools: m.supportsTools === true,
          supports_reasoning: m.supportsReasoning === true,
        }));
      } catch (e) {
        accounts.log('warn', `${p.displayName} 模型目录失败：${e.message}`);
        return [];
      }
    }),
  );

  const data = [];
  for (const list of results) data.push(...list);
  sendJson(res, 200, { object: 'list', data });
}

// ── 路由：账号概览 ────────────────────────────────────────────

function handleMe(req, res) {
  if (!authorized(req)) return sendError(res, 401, 'A valid proxy API key is required');
  const providers = registry.allProviders().map((p) => {
    const list = registry.listAccounts(p.id);
    return {
      id: p.id,
      name: p.displayName,
      accounts: list.length,
      enabled: list.filter((a) => a.enabled !== false).length,
      capabilities: p.capabilities || [],
    };
  });
  sendJson(res, 200, { object: 'proxy.me', providers, listenPort, uptime: Math.floor(process.uptime()) });
}

// ── 路由：对话 ────────────────────────────────────────────────

async function handleChat(req, res, rawBody) {
  if (!authorized(req)) return sendError(res, 401, 'A valid proxy API key is required');

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return sendError(res, 400, '请求体不是合法 JSON', 'invalid_request_error');
  }

  const requested = String(payload.model || '');
  const { model, owner } = splitModelId(requested);

  // 优先按 `@昵称` 定位；没带后缀就挑第一个有账号的供应商
  let provider = providerByOwner(owner);
  if (!provider) {
    const candidates = registry.allProviders().filter((p) => registry.count(p.id) > 0);
    provider = candidates[0] || null;
  }
  if (!provider) {
    return sendError(res, 404, '没有可用的供应商，请先在插件里添加账号', 'model_not_found');
  }

  const account = registry.pickAccount(provider.id);
  if (!account) {
    return sendError(res, 404, `${provider.displayName} 没有可用账号`, 'model_not_found');
  }

  const streaming = payload.stream === true;
  const inner = Object.assign({}, payload, { model: model || provider.defaultModel });

  // 上游只给流，客户端要非流式就在本地聚合
  let aggregator = null;
  if (!streaming) aggregator = sse.createAggregator(inner.model);

  let headersSent = false;
  const translator = sse.createTranslator({ model: inner.model, unwrap: true });

  const emit = (frames) => {
    if (aggregator) {
      aggregator.push(frames);
      return;
    }
    for (const frame of frames) {
      if (!headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        headersSent = true;
      }
      res.write(frame === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${frame}\n\n`);
    }
  };

  try {
    const result = await provider.openChat(account, JSON.stringify(inner), (line) => {
      emit(translator.translate(line));
    });
    if (result.error) {
      if (!headersSent && !aggregator) {
        return sendError(res, result.error.status || 502, result.error.message, 'upstream_error');
      }
      return sendError(res, result.error.status || 502, result.error.message, 'upstream_error');
    }

    if (result.status < 200 || result.status >= 300) {
      registry.cooldown(provider.id, account.uid, 30000);
      return sendError(
        res,
        result.status,
        `${provider.displayName} 返回 HTTP ${result.status}`,
        'upstream_error',
        result.status,
      );
    }

    if (aggregator) {
      const completion = aggregator.result();
      if (aggregator.isEmpty()) {
        return sendError(res, 502, '上游返回了空内容', 'upstream_error');
      }
      return sendJson(res, 200, completion);
    }

    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    accounts.log('error', `${provider.displayName} 对话失败：${e.message}`);
    registry.cooldown(provider.id, account.uid, 30000);
    if (!headersSent) {
      sendError(res, 502, e.message || '上游请求失败', 'upstream_error');
    } else {
      try {
        res.end();
      } catch (e2) {
        // 连接已断
      }
    }
  }
}

// ── 服务生命周期 ──────────────────────────────────────────────

function createHandler() {
  return async (req, res) => {
    // CORS 预检：浏览器里调试时会用上
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key',
      });
      res.end();
      return;
    }

    const url = String(req.url || '/').split('?')[0];

    try {
      if (req.method === 'GET' && (url === '/health' || url === '/')) {
        return sendJson(res, 200, {
          ok: true,
          service: 'pojia-gateway',
          providers: registry.allProviders().length,
          accounts: registry.listAccounts().length,
        });
      }
      if (req.method === 'GET' && url === '/v1/models') return handleModels(req, res);
      if (req.method === 'GET' && url === '/v1/me') return handleMe(req, res);
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const body = await readBody(req);
        return handleChat(req, res, body);
      }
      return sendError(res, 404, `未知路由 ${req.method} ${url}`, 'not_found');
    } catch (e) {
      accounts.log('error', `处理 ${url} 失败：${e.message}`);
      if (!res.headersSent) sendError(res, 500, e.message || '内部错误');
    }
  };
}

function start(port, keys) {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve({ port: listenPort, already: true });
      return;
    }
    apiKeys = Array.isArray(keys) ? keys : [];
    const p = Number(port) || 7864;
    const instance = http.createServer(createHandler());

    instance.on('error', (e) => {
      server = null;
      listenPort = 0;
      reject(new Error(e.code === 'EADDRINUSE' ? `端口 ${p} 已被占用` : e.message));
    });

    instance.listen(p, '127.0.0.1', () => {
      server = instance;
      listenPort = p;
      accounts.log('info', `网关已启动：http://127.0.0.1:${p}/v1`);
      resolve({ port: p });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve({ stopped: false });
    const instance = server;
    server = null;
    listenPort = 0;
    instance.close(() => resolve({ stopped: true }));
    setTimeout(() => resolve({ stopped: true }), 1000);
  });
}

function isRunning() {
  return server !== null;
}

function port() {
  return listenPort;
}

function setApiKeys(keys) {
  apiKeys = Array.isArray(keys) ? keys : [];
}

module.exports = {
  start,
  stop,
  isRunning,
  port,
  setApiKeys,
  publicId,
  splitModelId,
};
