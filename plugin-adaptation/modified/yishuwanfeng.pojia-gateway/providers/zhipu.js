'use strict';

/**
 * 智谱（AutoClaw 加速域，autoglm-acceleration-api.zhipuai.cn）。
 *
 * 两类站点：
 *  - 用户中心（userapi）：登录 / 刷新 / 积分 / 任务中心 / 模型目录，
 *    鉴权 = 客户端指纹签名 `X-Auth-Sign = MD5(appId&ts&appKey)` + `authorization: Bearer`；
 *  - LLM 代理（`/autoclaw-proxy/proxy/autoclaw/chat/completions`）：透传 OpenAI，
 *    鉴权用 `X-Authorization`，路由 ID 走 `X-Request-Model`。
 *
 * refresh_token 一次性：上游每刷一次就换新的、旧值立刻失效。所以只在
 * 「距 access_token 的 JWT exp 不足 5 分钟」或「已被上游判定登录态失效」时才刷，
 * 刷完必须把新的一对 token 写回账号并落盘，否则下一次刷新会用废值把账号刷死。
 */

const crypto = require('crypto');
const importer = require('../lib/importer');
const https = require('https');
const httpNative = require('http');
const { URL } = require('url');

const http = require('../lib/http');
const sse = require('../lib/sse');
const accounts = require('../lib/accounts');
const registry = require('../lib/registry');
const { makeAccount, parseSecret } = accounts;
const { CAP } = registry;

const HOST = 'https://autoglm-acceleration-api.zhipuai.cn';
const CHAT_URL = HOST + '/autoclaw-proxy/proxy/autoclaw/chat/completions';
const CATALOG_URL = HOST + '/autoclaw-proxy/proxy/autoclaw-model-config';

const PATH_SEND_CODE = '/userapi/v1/agent-send-code';
const PATH_LOGIN = '/userapi/v1/agent-login';
const PATH_REFRESH = '/userapi/v1/refresh';
const PATH_REFRESH_FALLBACK = '/userapi/v1/agent-refresh';
const PATH_WALLET_V2 = '/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw';
const PATH_WALLET_V1 =
  '/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all';
// 任务中心两个接口都不发 X-Tm：带 win 上游按桌面端裁剪，实测只回 4 条（不带回全部 7 条）
const PATH_TASK_LIST = '/autoclaw-proxy/proxy/autoclaw-task-list';
const PATH_TASK_COMPLETE = '/autoclaw-proxy/proxy/autoclaw-task-complete';

// 客户端指纹（与官方桌面客户端内嵌值一致，别改）
const AUTH_APP_ID = '100003';
const AUTH_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5';
const CLIENT_VERSION = '1.18.5';
// 转发链路的版本号与 userapi 刻意不同，这是实测被接受的组合
const DESKTOP_VERSION = '1.17.8';

const DEFAULT_MODEL = 'glm-5.3';
const DEFAULT_ROUTE = 'zai_auto';
const ROUTE_PREFIXES = ['zaicoding_', 'zai_'];

const DAILY_SIGNIN_TASK_ID = 'daily_signin';
// 这三个任务在 App 侧完不成（要邀请好友 / PC 客户端），列表与一键领取都剔除
const HIDDEN_TASK_IDS = ['invite_friends', 'download_pc_app', 'upgrade_pc_app'];

// 临期阈值：refresh_token 一次性，提前量给小了会在并发请求里连刷两把
const REFRESH_SKEW_SECONDS = 300;
const AUTH_EXPIRED_CODES = [400000, 410000];
const SIGNATURE_ERROR_CODE = 400002;

const REQUEST_TIMEOUT = 20000;
const CHAT_TIMEOUT = 180000;
const CATALOG_TTL = 5 * 60 * 1000;

const STATIC_MODELS = [
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    routeId: 'zaicoding_glm-5.3',
    features: ['reasoning', 'tool'],
    contextLength: 1048576,
    maxOutput: 307200,
    credits: '',
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM-5.3-Flash',
    routeId: 'zai_glm-5.3-flash',
    features: ['reasoning', 'vision', 'tool'],
    contextLength: 1048576,
    maxOutput: 131072,
    credits: '',
  },
];

// ── 工具 ──────────────────────────────────────────────────────

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function cloneJson(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function uuid4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20)
  );
}

function newDeviceId() {
  return crypto.randomBytes(32).toString('hex');
}

function stripBearer(value) {
  const text = String(value || '').trim();
  if (text.length > 6 && text.slice(0, 6).toLowerCase() === 'bearer' && /\s/.test(text[6])) {
    return text.slice(7).trim();
  }
  return text;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function formatNumber(value) {
  if (value === null || value === undefined) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n % 1 === 0 && Math.abs(n) < 9007199254740992) return String(n);
  return String(n);
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const raw = obj[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function apiError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function log(level, message) {
  accounts.log(level, message);
}

// ── JWT ──────────────────────────────────────────────────────

function jwtPayload(token) {
  const raw = stripBearer(token);
  const parts = raw.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

function jwtUserId(token) {
  const payload = jwtPayload(token);
  if (!payload) return '';
  const value = payload.user_id;
  if (value === undefined || value === null) return '';
  return String(value);
}

function jwtExpiry(token) {
  const payload = jwtPayload(token);
  if (!payload) return 0;
  const n = Number(payload.exp || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── 请求头 ────────────────────────────────────────────────────

/**
 * userapi 域的签名头。timestamp 是秒，签名 = MD5("{appId}&{ts}&{appKey}")。
 * `X-Harness-Type: zcode` 只在这里保留——转发链路刻意不发（见 chatHeaders）。
 */
function signedHeaders(token, opts) {
  const o = opts || {};
  const timestamp = String(nowSeconds());
  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Version': CLIENT_VERSION,
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Harness-Type': 'zcode',
    'X-Tm': 'win',
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'X-Auth-Appid': AUTH_APP_ID,
    'X-Auth-TimeStamp': timestamp,
    'X-Auth-Sign': md5(AUTH_APP_ID + '&' + timestamp + '&' + AUTH_APP_KEY),
    'X-Trace-Id': uuid4(),
  };
  if (o.omitTm) delete headers['X-Tm'];
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

/** 转发链路头：刻意不含 X-Harness-Type（2026-09-22 起 zcode 值稳定 403/406）。 */
function chatHeaders(token, routeModelId) {
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Tm': 'win',
    'X-Version': DESKTOP_VERSION,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    x_trace_id: 'autoclaw-desktop',
    'X-Authorization': 'Bearer ' + token,
    'X-Request-Id': uuid4(),
    'X-Request-Model': routeModelId,
  };
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const accessToken = stripBearer(obj.accessToken || obj.access_token || '');
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: String(obj.refreshToken || obj.refresh_token || '').trim(),
    deviceId: String(obj.deviceId || obj.device_id || '').trim(),
    expiresAt: Number(obj.expiresAt || 0) || jwtExpiry(accessToken),
    userId: String(obj.userId || obj.user_id || '') || jwtUserId(accessToken),
    phone: String(obj.phone || ''),
    uid: String(account.uid || ''),
  };
}

function secretOf(cred) {
  return JSON.stringify({
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken || '',
    deviceId: cred.deviceId || '',
    expiresAt: Number(cred.expiresAt || 0) || jwtExpiry(cred.accessToken),
    userId: cred.userId || jwtUserId(cred.accessToken),
    phone: cred.phone || '',
  });
}

/**
 * 把刷新后的凭证写回账号。
 *
 * 池子里存的就是这个对象引用，改完直接落盘即可；不落盘的话进程重启会拿着
 * 已经作废的 refresh_token 去刷，账号就废了。
 */
function persist(account) {
  try {
    accounts.saveAll(registry.listAccounts());
  } catch (e) {
    log('warn', '智谱凭证落盘失败：' + e.message);
  }
}

function applyCred(account, cred) {
  account.secret = secretOf(cred);
  const secret = parse(account);
  return secret || cred;
}

// ── 刷新（单飞 + 临期判定）────────────────────────────────────

const refreshLocks = new Map();

function isAuthRejected(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  const code = Number((res.obj && res.obj.code) || 0);
  return AUTH_EXPIRED_CODES.indexOf(code) >= 0;
}

/**
 * 是否值得现在刷：只有明确知道 5 分钟内到期才动手。
 * 拿不到 exp 时返回 false —— 宁可等上游回 401 再刷，也别白烧一枚一次性 token。
 */
function isExpiring(cred) {
  const expiry = Number(cred.expiresAt || 0) || jwtExpiry(cred.accessToken);
  if (!expiry) return false;
  return expiry - nowSeconds() <= REFRESH_SKEW_SECONDS;
}

/**
 * 真正执行刷新。同一账号并发请求共用一次调用：refresh_token 一次性，
 * 两个并发刷新里必然有一个拿到 token_rejected，会误判成账号失效。
 */
function refreshOnce(account, reason) {
  const key = String(account.uid || '') || 'zhipu-anonymous';
  const running = refreshLocks.get(key);
  if (running) return running;

  const task = (async () => {
    const cred = parse(account);
    if (!cred || !cred.refreshToken) return null;
    try {
      const next = await callRefresh(cred);
      const merged = {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken || cred.refreshToken,
        deviceId: cred.deviceId,
        expiresAt: jwtExpiry(next.accessToken),
        userId: jwtUserId(next.accessToken) || cred.userId,
        phone: cred.phone,
        uid: cred.uid,
      };
      const applied = applyCred(account, merged);
      persist(account);
      log('info', '智谱凭证已刷新（' + reason + '）');
      return applied;
    } catch (e) {
      log('warn', '智谱凭证刷新失败（' + reason + '）：' + e.message);
      return null;
    } finally {
      refreshLocks.delete(key);
    }
  })();

  refreshLocks.set(key, task);
  return task;
}

async function callRefresh(cred) {
  const body = { refresh_token: cred.refreshToken, source_id: 'autoclaw' };
  if (cred.deviceId) body.device_id = cred.deviceId;

  let res = await requestJson('POST', PATH_REFRESH, { token: cred.accessToken, body });
  // 400002 是签名校验失败：降级到 agent-refresh 重试一次（同一链路）
  if (Number((res.obj && res.obj.code) || 0) === SIGNATURE_ERROR_CODE) {
    res = await requestJson('POST', PATH_REFRESH_FALLBACK, { token: cred.accessToken, body });
  }
  const obj = res.obj || {};
  const code = Number(obj.code || 0);
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const access = stripBearer(data.access_token || '');
  if (code !== 0 || !access) {
    const message =
      String(obj.msg || obj.message || '').trim() || '服务器未返回新 token';
    const unauthorized = code === 401 || AUTH_EXPIRED_CODES.indexOf(code) >= 0;
    throw apiError(unauthorized ? 'token_rejected' : 'upstream', '刷新失败 code=' + code + '：' + message);
  }
  return { accessToken: access, refreshToken: stripBearer(data.refresh_token || '') };
}

/** 临期才刷；返回值可能仍是原凭证。 */
async function ensureFresh(account, cred) {
  if (!cred || !cred.refreshToken) return cred;
  if (!isExpiring(cred)) return cred;
  const next = await refreshOnce(account, '临期');
  return next || cred;
}

/**
 * 带鉴权发一次请求；登录态被拒时强制刷一次新 token 再试。
 *
 * 重试前先重读账号：如果别的并发请求已经刷过（accessToken 变了），
 * 就直接用新的，不再消耗一次一次性 refresh_token。
 */
async function withAuth(account, run) {
  const initial = parse(account);
  if (!initial) throw apiError('token_rejected', '凭证无法解析');
  let cred = await ensureFresh(account, initial);
  let res = await run(cred);

  if (!isAuthRejected(res)) return res;

  let retry = cred;
  if (cred.refreshToken) {
    const current = parse(account);
    if (current && current.accessToken && current.accessToken !== cred.accessToken) {
      retry = current;
    } else {
      retry = (await refreshOnce(account, '登录态被拒')) || cred;
    }
    res = await run(retry);
  }
  if (isAuthRejected(res)) throw apiError('token_rejected', '登录态已失效，请重新登录');
  return res;
}

// ── HTTP ──────────────────────────────────────────────────────

/**
 * 发 userapi 请求。返回 {status, obj, text}；HTTP 401/403 与业务码判定交给调用方，
 * 因为「被拒」既可能来自 HTTP 状态，也可能来自 200 响应里的 400000/410000。
 */
async function requestJson(method, path, opts) {
  const o = opts || {};
  const headers = signedHeaders(o.token, { omitTm: o.omitTm === true });
  const url = String(path).indexOf('http') === 0 ? path : HOST + path;
  const res =
    method === 'POST'
      ? await http.postJson(url, o.body === undefined ? {} : o.body, headers, o.timeout || REQUEST_TIMEOUT)
      : await http.get(url, headers, o.timeout || REQUEST_TIMEOUT);
  return { status: res.status, obj: safeJson(res.text), text: res.text };
}

/**
 * 打开上游 SSE，等**整个流结束**才 resolve。
 *
 * lib/http 的 stream() 在响应头到达时就 resolve，调用方（gateway.js）拿到返回
 * 值就会写 [DONE] 并关掉响应——长流会被截断。所以这里自己实现，语义改成
 * 「读到 EOF 才算完」。
 *
 * 非 2xx 时body 收进 head 供错误文案用，不调 onLine。
 */
function openSse(opts, onLine) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(opts.url);
    } catch (e) {
      reject(new Error('URL 非法：' + opts.url));
      return;
    }
    const lib = urlObj.protocol === 'https:' ? https : httpNative;
    const headers = Object.assign({ 'Accept-Encoding': 'identity' }, opts.headers || {});
    const bodyBuf = Buffer.from(String(opts.body || ''), 'utf8');
    if (!headers['Content-Length']) headers['Content-Length'] = bodyBuf.length;

    const req = lib.request(
      {
        method: opts.method || 'POST',
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        headers,
      },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let head = '';
        const splitter = ok
          ? sse.createLineSplitter((line) => {
              try {
                onLine(line);
              } catch (e) {
                log('warn', '智谱流式回调抛错：' + e.message);
              }
            })
          : null;

        res.on('data', (chunk) => {
          if (ok) splitter(chunk);
          else if (head.length < 8192) head += chunk.toString('utf8');
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode || 0, headers: res.headers, head });
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      },
    );

    const timeout = opts.timeout || CHAT_TIMEOUT;
    const timer = setTimeout(() => req.destroy(new Error('流式请求超时（' + timeout + 'ms）')), timeout);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(bodyBuf);
    req.end();
  });
}

// ── 模型 ──────────────────────────────────────────────────────

let remoteModels = [];
let remoteAt = 0;

function catalog() {
  return remoteModels.length > 0 ? remoteModels : STATIC_MODELS;
}

function stripRoutePrefix(routeId) {
  const text = String(routeId || '');
  for (const prefix of ROUTE_PREFIXES) {
    if (text.indexOf(prefix) === 0 && text.length > prefix.length) return text.slice(prefix.length);
  }
  return text;
}

/** 是否形如路由 ID：首字符小写字母，单词字符后接 `_`，尾巴 1..127 个 `[A-Za-z0-9._:-]`。 */
function isRouteId(value) {
  const text = String(value || '');
  if (!text || !/[a-z]/.test(text[0])) return false;
  let i = 1;
  while (i < text.length && /[a-z0-9]/.test(text[i])) i++;
  if (i >= text.length || text[i] !== '_') return false;
  const tail = text.slice(i + 1);
  if (!tail || tail.length > 127) return false;
  return /^[A-Za-z0-9._:-]+$/.test(tail);
}

function entryByCatalogName(name) {
  const lower = String(name).toLowerCase();
  const list = catalog();
  return (
    list.find((m) => String(m.id).toLowerCase() === lower) ||
    list.find((m) => String(m.label).toLowerCase() === lower) ||
    list.find((m) => String(m.routeId).toLowerCase() === lower) ||
    null
  );
}

function resolveRoute(rawModel) {
  const name = String(rawModel || '').trim();
  if (!name) {
    return { routeModelId: DEFAULT_ROUTE, bodyModelId: stripRoutePrefix(DEFAULT_ROUTE), requestedModel: DEFAULT_ROUTE };
  }
  const hit = entryByCatalogName(name);
  if (hit) {
    return { routeModelId: hit.routeId, bodyModelId: stripRoutePrefix(hit.routeId), requestedModel: name };
  }
  if (ROUTE_PREFIXES.some((p) => name.indexOf(p) === 0) || isRouteId(name)) {
    return { routeModelId: name, bodyModelId: stripRoutePrefix(name), requestedModel: name };
  }
  return { routeModelId: DEFAULT_ROUTE, bodyModelId: stripRoutePrefix(DEFAULT_ROUTE), requestedModel: name };
}

/** 对外暴露的模型名 = 路由 ID（对齐 Kotlin 的 resolveModel）。 */
function resolveModel(requested) {
  return resolveRoute(requested).routeModelId;
}

function normalizeRemote(array) {
  const out = [];
  const list = Array.isArray(array) ? array : [];
  for (const raw of list) {
    if (typeof raw === 'string') {
      const routeId = raw.trim();
      if (!routeId) continue;
      const id = stripRoutePrefix(routeId);
      out.push({ id, label: id.toUpperCase(), routeId, features: ['tool'], contextLength: 0, maxOutput: 0, credits: '' });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const routeId = String(raw.id || '').trim();
    if (!routeId) continue;
    const id = stripRoutePrefix(routeId);
    const label = String(raw.name || '').trim() || id.toUpperCase();
    const input = Array.isArray(raw.input) ? raw.input : [];
    const features = ['tool'];
    if (input.indexOf('image') >= 0) features.push('vision');
    // reasoning 缺省按 true（只有显式 false 才降级）
    if (raw.reasoning === undefined ? true : raw.reasoning !== false) features.push('reasoning');
    out.push({
      id,
      label,
      routeId,
      features,
      contextLength: Number(raw.contextWindow || 0) || 0,
      maxOutput: Number(raw.maxTokens || 0) || 0,
      credits: String(raw.creditConsumptionLevel || '').trim(),
    });
  }
  return out;
}

async function refreshCatalog(account) {
  const res = await withAuth(account, (cred) =>
    requestJson('GET', CATALOG_URL, { token: cred.accessToken }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '模型目录返回 HTTP ' + res.status);
  }
  const obj = res.obj;
  if (!obj || typeof obj !== 'object') throw apiError('upstream', '模型目录响应不是合法 JSON');
  const list = normalizeRemote(obj.models);
  if (list.length > 0) {
    remoteModels = list;
    remoteAt = Date.now();
  }
  return list;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw apiError('token_rejected', '凭证无法解析');
  if (remoteModels.length === 0 || Date.now() - remoteAt >= CATALOG_TTL) {
    try {
      await refreshCatalog(account);
    } catch (e) {
      log('warn', '智谱模型目录刷新失败：' + e.message);
    }
  }
  return catalog().map((m) => ({
    id: m.id,
    name: m.label,
    contextWindow: Number(m.contextLength || 0) || 0,
    supportsTools: (m.features || []).indexOf('tool') >= 0,
    supportsReasoning: (m.features || []).indexOf('reasoning') >= 0,
  }));
}

// ── system 提示规范化（上游白名单闸门）───────────────────────
//
// 上游要求首条 system 以固定身份句 + `## Tooling` 开头，且不允许出现外来
// harness 的身份句（`You are ZCode` / `You are Claude Code` …）。判定是
// 大小写不敏感的字面匹配，所以只改写主语、逐字保留客户端提示词。

const IDENTITY_LINE = 'You are a personal assistant running inside OpenClaw.';
const IDENTITY_PREFIX =
  IDENTITY_LINE + '\n\n' +
  '## Tooling\n' +
  'Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n';

// 长的在前：短的在前会把长匹配串切碎
const FOREIGN_IDENTITIES = [
  ['You are ZCode, an interactive coding agent', 'You are an interactive coding agent'],
  ['You are a coding agent running in the Codex CLI tool', 'You are a coding agent running in a terminal CLI tool'],
  ['You are a coding agent running in the Codex CLI', 'You are a coding agent running in a terminal CLI'],
  ['You are running as a coding agent in the Codex CLI', 'You are running as a coding agent in a terminal CLI'],
  ['You are Claude Code', 'You are a coding assistant'],
  ['You are ZCode', 'You are an interactive coding agent'],
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI agent powered by a local coding harness'],
  ['You are Codex', 'You are a coding agent'],
];

/** 只折叠 ASCII 大写，避免 Unicode 变体被折成 ASCII 造成误匹配。 */
function asciiLower(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[i];
  }
  return out;
}

function replaceAllIgnoreAsciiCase(text, from, to) {
  const hay = asciiLower(text);
  const needle = asciiLower(from);
  if (!needle) return null;
  let idx = hay.indexOf(needle);
  if (idx < 0) return null;
  const parts = [];
  let pos = 0;
  while (idx >= 0) {
    parts.push(text.slice(pos, idx), to);
    pos = idx + from.length;
    idx = hay.indexOf(needle, pos);
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

function rewriteIdentities(text) {
  let current = String(text);
  for (const pair of FOREIGN_IDENTITIES) {
    const next = replaceAllIgnoreAsciiCase(current, pair[0], pair[1]);
    if (next !== null) current = next;
  }
  return current;
}

function isSystemRole(message) {
  const role = String((message && message.role) || '');
  return role === 'system' || role === 'developer';
}

function joinPrefix(original) {
  if (!original) return IDENTITY_PREFIX;
  return IDENTITY_PREFIX + '\n' + original;
}

function prependPrefix(message) {
  const content = message.content;
  if (content === undefined || content === null) {
    message.content = IDENTITY_PREFIX;
    return;
  }
  if (typeof content === 'string') {
    if (content.indexOf(IDENTITY_LINE) !== 0) message.content = joinPrefix(content);
    return;
  }
  if (Array.isArray(content)) {
    let index = -1;
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        index = i;
        break;
      }
    }
    if (index < 0) {
      message.content = [{ type: 'text', text: IDENTITY_PREFIX }].concat(content);
      return;
    }
    const part = content[index];
    if (part.text.indexOf(IDENTITY_LINE) !== 0) part.text = joinPrefix(part.text);
    return;
  }
  // null / 对象 / 数字：这种 content 当 system 提示本来就不成立，直接换成前缀
  message.content = IDENTITY_PREFIX;
}

function rewriteMessageIdentities(message) {
  const content = message.content;
  if (typeof content === 'string') {
    message.content = rewriteIdentities(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        part.text = rewriteIdentities(part.text);
      }
    }
  }
}

function normalizePrompt(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (!isSystemRole(message)) continue;
    rewriteMessageIdentities(message);
  }
  const first = messages.length > 0 ? messages[0] : null;
  if (first && typeof first === 'object' && isSystemRole(first)) {
    prependPrefix(first);
    return;
  }
  // 首条不是 system：补一条只带前缀的 system，后面消息的位置一律不动
  body.messages = [{ role: 'system', content: IDENTITY_PREFIX }].concat(messages);
}

// ── 对话 ──────────────────────────────────────────────────────

async function openChat(account, openAiBody, onLine) {
  const initial = parse(account);
  if (!initial) {
    return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };
  }
  const src = typeof openAiBody === 'string' ? safeJson(openAiBody) : openAiBody;
  if (!src || typeof src !== 'object') {
    return { status: 400, model: '', error: { status: 400, message: '请求体不是合法 JSON' } };
  }

  const route = resolveRoute(src.model);
  const out = {};
  for (const key of Object.keys(src)) out[key] = src[key];
  out.model = route.bodyModelId;
  // 统一按流式取：客户端要非流式时由上层聚合，省掉两条上游路径的差异
  out.stream = true;
  // messages 要深拷：normalizePrompt 是就地改写，不能把调用方的 body 改掉
  out.messages = cloneJson(src.messages);
  normalizePrompt(out);
  const payload = JSON.stringify(out);

  let cred = (await ensureFresh(account, initial)) || initial;
  let result = await openSse(
    {
      url: CHAT_URL,
      headers: chatHeaders(cred.accessToken, route.routeModelId),
      body: payload,
      timeout: CHAT_TIMEOUT,
    },
    onLine,
  );

  // 401/403 时流里不会有任何有效帧，换新 token 重试是安全的
  if (result.status === 401 || result.status === 403) {
    const current = parse(account);
    let next = current;
    if (!current || current.accessToken === cred.accessToken) {
      next = (await refreshOnce(account, '对话被拒')) || cred;
    }
    if (next && next.accessToken !== cred.accessToken) {
      cred = next;
      result = await openSse(
        {
          url: CHAT_URL,
          headers: chatHeaders(cred.accessToken, route.routeModelId),
          body: payload,
          timeout: CHAT_TIMEOUT,
        },
        onLine,
      );
    }
  }

  if (result.status < 200 || result.status >= 300) {
    const detail = String(result.head || '').trim().slice(0, 160);
    return {
      status: result.status,
      model: route.requestedModel,
      error: {
        status: result.status === 401 || result.status === 403 ? 401 : 502,
        message:
          result.status === 406
            ? '上游判定 system 提示词不合规（逐字白名单闸门），不是账号问题'
            : '上游返回 HTTP ' + result.status + (detail ? '：' + detail : ''),
      },
    };
  }
  return { status: 200, headers: result.headers, model: route.requestedModel };
}

// ── 积分 ──────────────────────────────────────────────────────

function jsTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalizeWalletsV2(data) {
  const array = data && Array.isArray(data.wallets) ? data.wallets : [];
  const entries = [];
  for (const item of array) {
    if (!item || typeof item !== 'object') continue;
    if (!jsTruthy(item.display)) continue;
    const balance = pickNumber(item, ['balance']);
    const view = String(item.balance_view || '').trim() || formatNumber(balance);
    const name =
      String(item.display_name || '').trim() ||
      String(item.public_wallet_type || '').trim() ||
      '积分';
    entries.push({
      priority: item.priority === undefined || item.priority === null ? Number.MAX_SAFE_INTEGER : Number(item.priority),
      wallet: {
        name,
        balance,
        view,
        type: String(item.public_wallet_type || '').trim() || null,
      },
    });
  }
  entries.sort((a, b) => a.priority - b.priority);
  return entries.map((e) => e.wallet);
}

const WALLET_LABELS = {
  daily: '赠送积分',
  monthly: '订阅积分',
  long_term: '通用积分',
  annual: '通用积分',
  campaign: '活动积分',
};

function normalizeWalletsV1(data) {
  const array = data && Array.isArray(data.wallet_instances) ? data.wallet_instances : [];
  const merged = new Map();
  const order = [];
  for (const item of array) {
    if (!item || typeof item !== 'object') continue;
    if (String(item.status || '').toLowerCase() !== 'active') continue;
    if (!jsTruthy(item.display)) continue;
    const scope =
      String(item.wallet_scope || '')
        .toLowerCase()
        .replace('wallet_scope_', '') || 'other';
    if (!merged.has(scope)) {
      merged.set(scope, { balance: 0 });
      order.push(scope);
    }
    const entry = merged.get(scope);
    entry.balance += pickNumber(item, ['balance']) || 0;
  }
  return order.map((scope) => {
    const entry = merged.get(scope);
    return {
      name: WALLET_LABELS[scope] || '其他积分',
      balance: entry.balance,
      view: formatNumber(entry.balance),
      type: scope,
    };
  });
}

/** 余额：v2 主链路 → v1 兜底（v2 业务码非 0 或没有 wallets 数组时）。 */
async function fetchBalance(account) {
  const v2 = await withAuth(account, (cred) =>
    requestJson('GET', PATH_WALLET_V2, { token: cred.accessToken }),
  );
  if (v2.status < 200 || v2.status >= 300) {
    throw apiError('upstream', '积分查询失败（HTTP ' + v2.status + '）');
  }
  const obj2 = v2.obj || {};
  const data2 = obj2.data && typeof obj2.data === 'object' ? obj2.data : null;
  if (Number(obj2.code || 0) === 0 && data2 && Array.isArray(data2.wallets)) {
    const total = pickNumber(data2, ['total_balance']);
    return { total, display: formatNumber(total), wallets: normalizeWalletsV2(data2) };
  }

  const v1 = await withAuth(account, (cred) =>
    requestJson('GET', PATH_WALLET_V1, { token: cred.accessToken }),
  );
  if (v1.status < 200 || v1.status >= 300) {
    throw apiError('upstream', '积分查询失败（HTTP ' + v1.status + '）');
  }
  const obj1 = v1.obj || {};
  const data1 = obj1.data && typeof obj1.data === 'object' ? obj1.data : null;
  if (Number(obj1.code || 0) !== 0 || !data1) {
    const message = String(obj1.msg || '').trim() || '积分查询返回异常 code=' + obj1.code;
    throw apiError('upstream', message);
  }
  const total = pickNumber(data1, ['total_balance']);
  return { total, display: formatNumber(total), wallets: normalizeWalletsV1(data1) };
}

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw apiError('token_rejected', '凭证无法解析');
  const balance = await fetchBalance(account);
  return {
    credit: balance.total === null ? -1 : balance.total,
    creditText: balance.display,
    raw: { total: balance.total, wallets: balance.wallets },
  };
}

// ── 任务中心 / 签到 ───────────────────────────────────────────

function taskTitle(taskId) {
  return taskId === DAILY_SIGNIN_TASK_ID ? '每日签到' : taskId;
}

async function fetchTasks(account) {
  const res = await withAuth(account, (cred) =>
    requestJson('GET', PATH_TASK_LIST, { token: cred.accessToken, omitTm: true }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '任务列表失败（HTTP ' + res.status + '）');
  }
  const obj = res.obj || {};
  const code = Number(obj.code || 0);
  if (code !== 0) {
    const message = String(obj.msg || '').trim() || '任务列表返回异常 code=' + obj.code;
    throw apiError('upstream', message);
  }
  const array = Array.isArray(obj.data) ? obj.data : [];
  const out = [];
  for (const item of array) {
    if (!item || typeof item !== 'object') continue;
    const taskId = String(item.task_id || '').trim();
    if (!taskId) continue;
    const title = String(item.title || '').trim() || String(item.name || '').trim();
    const completed = item.completed === true || String(item.status || '').toLowerCase() === 'completed';
    const reward =
      pickNumber(item, ['reward_points', 'points']) ||
      pickNumber(item.reward, ['points']) ||
      0;
    out.push({
      taskId,
      title,
      completed,
      rewardPoints: reward > 0 ? reward : 0,
      status: String(item.status || '').trim(),
    });
  }
  return out;
}

/**
 * 完成任务并领奖。`already_completed` 表示本次没领到（不能当成功），
 * 但也不算失败——调用方据此区分「已办」与「出错」。
 */
async function completeTask(account, taskId) {
  const res = await withAuth(account, (cred) =>
    requestJson('POST', PATH_TASK_COMPLETE, {
      token: cred.accessToken,
      body: { task_id: taskId },
      omitTm: true,
    }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '任务领取失败（HTTP ' + res.status + '）');
  }
  const obj = res.obj || {};
  const code = Number(obj.code || 0);
  if (code !== 0) {
    return {
      claimed: false,
      rewardPoints: 0,
      message: String(obj.msg || '').trim() || '领取失败（code=' + code + '）',
      alreadyCompleted: false,
    };
  }
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const alreadyCompleted = data.already_completed === true;
  const reportedSuccess = data.success === true;
  const rewardPoints = Number(data.reward_points || 0) || 0;
  const claimed = rewardPoints > 0 || (reportedSuccess && !alreadyCompleted);
  let message;
  if (claimed && rewardPoints > 0) message = '领取成功，获得 ' + rewardPoints + ' 积分';
  else if (claimed) message = '领取成功';
  else if (alreadyCompleted) message = taskId === DAILY_SIGNIN_TASK_ID ? '今天已签到' : '该任务已完成';
  else message = '未领取到奖励';
  return { claimed, rewardPoints, message, alreadyCompleted };
}

async function taskList(account) {
  const cred = parse(account);
  if (!cred) return { tasks: [], error: '凭证无法解析' };
  try {
    const raw = await fetchTasks(account);
    const tasks = raw
      .filter((t) => HIDDEN_TASK_IDS.indexOf(t.taskId) < 0)
      .map((t) => ({
        code: t.taskId,
        title: t.title || taskTitle(t.taskId),
        description: '',
        current: t.completed ? 1 : 0,
        target: 1,
        status: t.status || (t.completed ? 'completed' : ''),
        locked: false,
        claimed: t.completed,
        rewardCredit: t.rewardPoints,
      }));
    return { tasks, error: '' };
  } catch (e) {
    return { tasks: [], error: e.message || '任务列表拉取失败' };
  }
}

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  try {
    const result = await completeTask(account, DAILY_SIGNIN_TASK_ID);
    if (result.claimed) {
      return { ok: true, message: result.message, gained: result.rewardPoints };
    }
    if (result.alreadyCompleted) return { ok: true, message: '今天已签到' };
    return { ok: false, message: result.message };
  } catch (e) {
    return { ok: false, message: e.message || '签到失败' };
  }
}

async function runTasks(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  let pending;
  try {
    pending = (await fetchTasks(account))
      .filter((t) => HIDDEN_TASK_IDS.indexOf(t.taskId) < 0)
      .filter((t) => !t.completed)
      .filter((t) => t.taskId !== DAILY_SIGNIN_TASK_ID);
  } catch (e) {
    return { ok: false, message: e.message || '任务列表拉取失败' };
  }
  if (pending.length === 0) return { ok: true, message: '没有可领取的任务' };

  const claimed = [];
  const failed = [];
  let earned = 0;
  for (const task of pending) {
    const label = task.title || task.taskId;
    try {
      const result = await completeTask(account, task.taskId);
      if (result.claimed) {
        earned += result.rewardPoints;
        claimed.push(result.rewardPoints > 0 ? label + '+' + result.rewardPoints : label);
      } else if (!result.alreadyCompleted) {
        failed.push(label + '：' + result.message);
      }
    } catch (e) {
      failed.push(label + '：' + e.message);
    }
  }
  const parts = [];
  if (claimed.length > 0) parts.push('成功 ' + claimed.length + ' 个（' + claimed.join('；') + '）');
  if (earned > 0) parts.push('共 +' + earned + ' 积分');
  if (failed.length > 0) parts.push('失败 ' + failed.length + ' 个（' + failed.join('；') + '）');
  return { ok: claimed.length > 0, message: parts.join('；') || '没有领取到奖励' };
}

// ── 短信登录（插件侧暂无验证码界面，保留给手工调用/将来的 UI）────

function normalizePhone(raw) {
  const trimmed = String(raw || '').replace(/[\s-]/g, '');
  let digits = trimmed.indexOf('+86') === 0 ? trimmed.slice(3) : trimmed;
  if (trimmed.indexOf('+86') !== 0 && digits.indexOf('86') === 0 && digits.length === 13) {
    digits = digits.slice(2);
  }
  return /^1[2-9]\d{9}$/.test(digits) ? digits : '';
}

function normalizeCode(raw) {
  const text = String(raw || '').trim();
  if (!/^\d{6}$/.test(text)) return 0;
  return Number(text);
}

function describeLoginError(code, upstreamMsg) {
  const table = {
    400001: '请求参数有误，请检查手机号与验证码格式后重试',
    630202: '验证码不正确，请检查后重试',
    630101: '获取验证码过于频繁，请稍后再试',
    410000: '登录态已失效，请重新登录',
    400000: '登录态已失效，请重新登录',
    400002: '请求签名校验失败（本机时钟可能有偏差），请校准系统时间后重试',
    631002: '上游要求过风控验证，本次登录无法在此完成',
    630014: '风控验证未通过，请稍后重试',
  };
  if (table[code]) return table[code];
  const msg = String(upstreamMsg || '').trim();
  return msg ? '登录失败：' + msg : '登录失败（上游 code=' + code + '）';
}

/** 发短信验证码；返回的 deviceId 必须原样传给 loginWithSmsCode。 */
async function sendSmsCode(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw apiError('invalid_request_error', '请填写 11 位中国大陆手机号');
  const deviceId = newDeviceId();
  const res = await requestJson('POST', PATH_SEND_CODE, {
    body: { phone: normalized, source_id: 'autoclaw', device_id: deviceId },
  });
  const obj = res.obj || {};
  const code = Number(obj.code || 0);
  if (code !== 0) {
    log('warn', '智谱验证码被拒 code=' + code + '：' + String(obj.msg || '').slice(0, 300));
    throw apiError('invalid_request_error', describeLoginError(code, obj.msg));
  }
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  if (data.result !== true) throw apiError('upstream', '验证码发送失败，请稍后重试');
  return deviceId;
}

/** 手机号 + 验证码登录，返回账号对象（可直接 registry.addAccount）。 */
async function loginWithSmsCode(phone, code, deviceId) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw apiError('invalid_request_error', '请填写 11 位中国大陆手机号');
  const codeNumber = normalizeCode(code);
  if (!codeNumber) throw apiError('invalid_request_error', '请填写 6 位数字验证码');
  const device = String(deviceId || '').trim() || newDeviceId();
  // code 必须是 JSON 数字，传字符串稳定得 400001；路径不能带尾斜杠（307 会被拒）
  const res = await requestJson('POST', PATH_LOGIN, {
    body: { phone: normalized, code: codeNumber, platform: 'web', source_id: 'autoclaw', device_id: device },
  });
  const obj = res.obj || {};
  const status = Number(obj.code || 0);
  if (status !== 0) {
    log('warn', '智谱登录被拒 code=' + status + '：' + String(obj.msg || '').slice(0, 300));
    throw apiError('invalid_request_error', describeLoginError(status, obj.msg));
  }
  const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
  if (!data) throw apiError('upstream', '登录成功但上游没有返回凭证');
  const accessToken = stripBearer(data.access_token || '');
  if (!accessToken) throw apiError('upstream', '登录成功但上游没有返回 access_token');
  const cred = {
    accessToken,
    refreshToken: stripBearer(data.refresh_token || ''),
    deviceId: device,
    expiresAt: jwtExpiry(accessToken),
    userId: jwtUserId(accessToken),
    phone: maskPhone(normalized),
    uid: jwtUserId(accessToken) || maskPhone(normalized),
  };
  return makeAccount(
    'zhipu',
    String(cred.uid),
    cred.phone,
    secretOf(cred),
  );
}

function maskPhone(phone) {
  const text = String(phone || '');
  if (text.length < 7) return text;
  return text.slice(0, 3) + '****' + text.slice(text.length - 4);
}

// ── 导入 ──────────────────────────────────────────────────────

function tryParseAccountsJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.accounts)) return obj.accounts;
    if (obj && typeof obj === 'object') return [obj];
    return [];
  } catch (e) {
    // 多条 JSON 相连：按花括号配对逐个抠
    const out = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const obj = safeJson(text.slice(start, i + 1));
          if (obj) out.push(obj);
          start = -1;
        }
      }
    }
    return out;
  }
}

function accountFromImport(obj, fallbackToken) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const accessToken = stripBearer(
    src.accessToken || src.access_token || src.token || fallbackToken || '',
  );
  if (!accessToken) return null;

  const userId = String(src.userId || src.user_id || '').trim() || jwtUserId(accessToken);
  const phone = String(src.phone || '').trim();
  // 裸 token 且 JWT 里没有 user_id：不能用它建账号（去重指纹会撞），直接跳过
  if (!userId && !phone && !obj) return null;

  const cred = {
    accessToken,
    refreshToken: String(src.refreshToken || src.refresh_token || '').trim(),
    deviceId: String(src.deviceId || src.device_id || '').trim() || newDeviceId(),
    expiresAt: Number(src.expiresAt || 0) || jwtExpiry(accessToken),
    userId,
    phone,
    uid: userId || phone || accessToken.slice(-8),
  };
  return makeAccount(
    'zhipu',
    String(cred.uid),
    String(src.nickname || '').trim() || phone || '账号 ' + String(cred.uid).slice(0, 8),
    secretOf(cred),
  );
}

/**
 * 导入智谱凭证：App 导出 JSON（单个 / 数组 / {accounts:[]} / 多条相连）
 * 或每行一个裸 access_token。同名 uid 去重。
 */

// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.cookie || s.Cookie || s.token || s.accessToken || s.access_token)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      cookie: s.cookie || s.Cookie || '',
      token: s.token || s.accessToken || s.access_token || '',
      refreshToken: s.refreshToken || s.refresh_token || '',
      expiresAt: Number(s.expiresAt || 0),
      uid,
      nickname: nick,
    })(s, uid, nick);
}

function extraOf() {
  return {};
}


function importCredentials(raw) {
  const parsed = importer.parseInput(raw);
  const list = [];

  for (const item of parsed.items) {
    const secret = importer.normalizeSecret(item.secret);
    if (!hasCredential(secret)) continue;

    const uid = importer.resolveUid(item, secret, 'zhipu');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('zhipu', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 导出 ──────────────────────────────────────────────────────

module.exports = {
  id: 'zhipu',
  displayName: '智谱',
  authKind: 'SMS_CODE',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN, CAP.TASKS],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  taskList,
  runTasks,
  sendSmsCode,
  loginWithSmsCode,
  importCredentials,

  // 测试用：无副作用的纯函数
  _internal: {
    makeTimestampSign: (ts) => md5(AUTH_APP_ID + '&' + ts + '&' + AUTH_APP_KEY),
    resolveRoute,
    normalizePrompt,
    normalizeWalletsV2,
    normalizeWalletsV1,
    jwtUserId,
    jwtExpiry,
    newDeviceId,
  },
};
