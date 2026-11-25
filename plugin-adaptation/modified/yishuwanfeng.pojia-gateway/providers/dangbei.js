'use strict';

/**
 * 当贝 AI（ai.dangbei.com）。
 *
 * 登录：WebView 打开网页版抠 token。
 * 对话：`POST /chatApi/v2/chat`（SSE，只取 `conversation.message.delta` 事件）。
 * 鉴权：自定义签名头族，不是 Bearer。
 *
 * 签名算法：`MD5(timestamp + params + nonce).toUpperCase()`
 *   - timestamp：秒级时间戳
 *   - params：GET 用 query 串，POST 用 body 原文
 *   - nonce：21 位随机串，字符集 [A-Za-z0-9_-]
 */

const crypto = require('crypto');
const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const BASE_URL = 'https://ai-api.dangbei.net/ai-search';
const APP_TYPE_WEB = '6';
const CLIENT_VER = '1.0.2';
const APP_VERSION = '1.3.9';
const BOT_CODE = 'AI_SEARCH';
const SIGN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

const DEFAULT_MODEL = 'deepseek-v3';

const PATH_USER_INFO = '/userInfoApi/v1/getUserInfo';
const PATH_MODEL_CONFIG = '/configApi/v1/getUserModelConfig';
const PATH_MODEL_CONFIG_ANON = '/configApi/v1/getChatModelConfig';
const PATH_CHAT = '/chatApi/v2/chat';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── 签名 ──────────────────────────────────────────────────────

function nonce() {
  const bytes = crypto.randomBytes(21);
  let out = '';
  for (let i = 0; i < 21; i++) out += SIGN_ALPHABET[bytes[i] % SIGN_ALPHABET.length];
  return out;
}

function sign(timestamp, params, nc) {
  return crypto.createHash('md5').update(`${timestamp}${params}${nc}`, 'utf8').digest('hex').toUpperCase();
}

/** 生成完整的签名头族。 */
function signedHeaders(token, accept) {
  const ts = Math.floor(Date.now() / 1000);
  const nc = nonce();
  return {
    timestamp: String(ts),
    nonce: nc,
    // 先占位，调用方按实际 params 重算
    sign: '',
    token: token || '',
    appType: APP_TYPE_WEB,
    lang: 'zh',
    'client-ver': CLIENT_VER,
    appVersion: APP_VERSION,
    deviceId: '',
    Origin: 'https://ai.dangbei.com',
    Referer: 'https://ai.dangbei.com/',
    Accept: accept || 'application/json',
    'User-Agent': UA,
    _ts: ts,
    _nonce: nc,
  };
}

/** 用给定 params 补齐签名，并剔除内部字段。 */
function finalizeHeaders(base, params) {
  const out = Object.assign({}, base);
  out.sign = sign(base._ts, params, base._nonce);
  delete out._ts;
  delete out._nonce;
  return out;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const token = obj.token || obj.accessToken || '';
  if (!token) return null;
  return { token, uid: obj.uid || account.uid || '', nickname: obj.nickname || '' };
}

function jwtClaim(token, names) {
  if (!token) return '';
  const parts = String(token).split('.');
  if (parts.length < 2) return '';
  try {
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const obj = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    for (const n of names) {
      const v = obj[n];
      if (v !== undefined && v !== null && String(v)) return String(v);
    }
  } catch (e) {
    // 忽略
  }
  return '';
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const m = String(requested || '').trim();
  if (!m || m === 'auto') return DEFAULT_MODEL;
  return m;
}

async function fetchModels(account) {
  const cred = parse(account);
  const path = cred && cred.token ? PATH_MODEL_CONFIG : PATH_MODEL_CONFIG_ANON;
  const base = signedHeaders(cred ? cred.token : '', 'application/json');

  // GET 的签名用 query 串；这里没有 query，传空串
  const headers = finalizeHeaders(base, '');
  const res = await http.get(BASE_URL + path, headers, 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型接口 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const arr = Array.isArray(data) ? data : data.list || data.models || data.modelList || [];

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = item.model || item.modelCode || item.code || item.id || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: String(id),
      name: String(item.modelName || item.name || id),
      contextWindow: Number(item.contextWindow || item.maxTokens || 0) || 0,
      supportsTools: false,
      supportsReasoning: item.supportThink === true || item.thinking === true,
    });
  }

  if (out.length === 0) {
    // 上游结构变动时至少给一个能用的默认模型，免得整个供应商从列表里消失
    out.push({ id: DEFAULT_MODEL, name: DEFAULT_MODEL, contextWindow: 0, supportsTools: false, supportsReasoning: false });
  }
  return out;
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 把 OpenAI 的 messages 压成单条 question。
 *
 * 当贝是网页对话接口，没有 messages 数组的概念，
 * 只能把历史拼成一段文本，并靠 conversationId 维持上下文。
 */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (messages.length === 1) return String(messages[0].content || '');
  const parts = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '用户';
    parts.push(`${role}：${String(m.content || '')}`);
  }
  return parts.join('\n\n');
}

async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);
  const question = flattenMessages(src.messages);
  const localId = sse.newId('db');

  const payload = {
    stream: true,
    botCode: BOT_CODE,
    conversationId: '',
    question,
    model,
    chatOption: {
      searchKnowledge: false,
      searchAllKnowledge: false,
      searchSharedKnowledge: false,
    },
    knowledgeList: [],
    anonymousKey: '',
    uuid: localId,
    chatId: localId,
    files: [],
    reference: [],
    role: 'user',
    status: 'local',
    content: question,
    userAction: 'chat',
    agentId: '',
  };
  const bodyText = JSON.stringify(payload);

  // POST 的签名用 body 原文
  const headers = finalizeHeaders(signedHeaders(cred.token, 'text/event-stream'), bodyText);
  headers['Content-Type'] = 'application/json';

  // 只把 conversation.message.delta 的正文喂出去，其余事件忽略
  let currentEvent = '';
  const splitter = sse.createLineSplitter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.slice(6).trim();
      return;
    }
    if (!trimmed.startsWith('data:')) return;
    if (currentEvent !== 'conversation.message.delta') return;

    const raw = trimmed.slice(5).trim();
    const obj = safeJson(raw);
    if (!obj) return;
    const delta = extractDelta(obj);
    if (!delta) return;

    onLine(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        }),
    );
  });

  const res = await http.stream(
    { url: BASE_URL + PATH_CHAT, headers, body: bodyText, timeout: 600000 },
    splitter,
  );
  if (res.done) await res.done;

  if (res.status < 200 || res.status >= 300) {
    return {
      status: res.status,
      headers: res.headers,
      model,
      error: { status: res.status, message: `当贝返回 HTTP ${res.status}` },
    };
  }
  onLine('data: [DONE]');
  return { status: res.status, headers: res.headers, model };
}

/** 从 delta 事件里取正文。上游换过几种字段名，逐个试。 */
function extractDelta(obj) {
  const data = obj.data || obj;
  for (const key of ['content', 'text', 'delta', 'answer']) {
    const v = data[key];
    if (typeof v === 'string' && v) return v;
  }
  // 有些版本把正文放在 choices 里
  if (Array.isArray(data.choices)) {
    const first = data.choices[0];
    if (first && first.delta && typeof first.delta.content === 'string') return first.delta.content;
  }
  return '';
}

// ── 账号与积分 ────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const bodyText = '{}';
  const headers = finalizeHeaders(signedHeaders(cred.token, 'application/json'), bodyText);
  headers['Content-Type'] = 'application/json';

  const res = await http.request({
    method: 'POST',
    url: BASE_URL + PATH_USER_INFO,
    headers,
    body: bodyText,
    timeout: 30000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`用户信息 HTTP ${res.status}`);

  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  let credit = -1;
  let creditText = '';
  for (const key of ['remainCount', 'remain', 'balance', 'points', 'integral', 'leftCount']) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) {
      credit = n;
      creditText = String(n);
      break;
    }
  }
  return { credit, creditText, raw: data };
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl() {
  return 'https://ai.dangbei.com/chat';
}

async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  const token =
    jar.token || jar.access_token || jar.authorization || jar.dangbei_token || '';
  if (!token) throw new Error('cookie 里没有 token，请在网页控制台复制 token');

  const uid =
    jar.userId || jar.uid || jwtClaim(token, ['user_id', 'userId', 'uid', 'sub']) ||
    'dangbei-' + hashShort(token);
  const secret = JSON.stringify({ token, uid, nickname: '' });
  return makeAccount('dangbei', String(uid), '', secret);
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.token || s.accessToken || s.access_token)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      token: s.token || s.accessToken || s.access_token || '',
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

    const uid = importer.resolveUid(item, secret, 'dangbei');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('dangbei', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 工具 ──────────────────────────────────────────────────────

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function parseCookieString(cookie) {
  const out = {};
  if (!cookie) return out;
  for (const part of String(cookie).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function hashShort(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
}

function parseAccountsJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.accounts)) return obj.accounts;
    if (obj && typeof obj === 'object') return [obj];
  } catch (e) {
    // 多段 JSON 相连
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
          try {
            out.push(JSON.parse(text.slice(start, i + 1)));
          } catch (e2) {
            // 跳过
          }
          start = -1;
        }
      }
    }
    return out;
  }
  return [];
}

module.exports = {
  id: 'dangbei',
  displayName: '当贝',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [CAP.CREDIT_REFRESH],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  loginUrl,
  accountFromCookie,
  importCredentials,
};
