'use strict';

/**
 * 美团 CatPaw（ai.catpaw.meituan.com，走 catx.nocode.cn 的 agent 网关）。
 *
 * 鉴权不是 Bearer 也不是 JWT，而是会话 Cookie 里的 `X-Passport-Token`，
 * 且 uid 是独立请求头（不在 token 里，必须成对取到）。没有刷新机制，过期只能重登。
 *
 * 三轮协议：
 *   1. POST /api/agent/conversation/round   提交本轮消息（JSON，一问一答）
 *   2. POST /api/agent/conversation/turn    建 SSE 流，消费回答
 *   3. POST /api/agent/conversation/event   工具结果回报（本实现不做工具循环，跳过）
 *
 * 关键：上游 turn 的 SSE 给的是**全量文本**，不是增量——
 * 每次都要与上一次相比取后缀，否则客户端会看到重复内容。
 *
 * conversationId 由客户端自己生成（UUID 去连字符），不是上游下发。
 */

const crypto = require('crypto');
const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const BASE_URL = 'https://ai.catpaw.meituan.com';
const SOURCE = 'CatX';
const MODE = 'CATX_APP';
const TOOL_VERSION = '2.0.2';
const CLIENT_VERSION = '1.0.1';
const APP_KEY = 'fe_com.sankuai.catpaw.external.front';
const PERMISSION_MODE = 'unsafeBypassPermissions';

const P = {
  round: '/api/agent/conversation/round',
  turn: '/api/agent/conversation/turn',
  modelTypes: '/api/agent/maas/model-types',
  balance: '/api/gateway/credit/balance',
};

const DEFAULT_MODEL = '';

// ── 工具 ──────────────────────────────────────────────────────

function newRequestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function headers(cred, accept) {
  const h = {
    Accept: accept,
    'Content-Type': 'application/json',
    // M-TRACEID 每次请求都是新的
    'M-TRACEID': newRequestId(),
    'M-APPKEY': APP_KEY,
    'gray-set': 'new-agent-sdk',
    enableHeartBeat: 'true',
    'X-Agent-Version': CLIENT_VERSION,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (cred.token) h.Cookie = `X-Passport-Token=${cred.token}`;
  if (cred.uid) h['user-uid'] = cred.uid;
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const token = obj.token || obj.passportToken || '';
  if (!token) return null;
  return {
    token,
    uid: obj.uid || account.uid || '',
    loginName: obj.loginName || '',
    region: 'cn',
  };
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const m = String(requested || '').trim();
  return m && m !== 'auto' ? m : DEFAULT_MODEL;
}

/** jsTruthy：上游把布尔有时给成字符串 "true"。 */
function jsTruthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  if (typeof v === 'number') return v !== 0;
  return false;
}

/**
 * 拉模型目录。
 *
 * 过滤两类：
 *   - provider === USER_CUSTOM：用户自建模型依赖客户端本地 apiKey，网关没有凭证
 *   - extendedInfo.isAuto：auto 档位入口，不是真实模型
 *
 * id 取 modelTypeName（真实名字），不是 id 也不是 catPawModelType（都是内部标识）。
 */
async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');

  const res = await http.get(BASE_URL + P.modelTypes, headers(cred, 'application/json'), 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型目录 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const root = safeJson(res.text);
  if (!root) throw new Error('模型目录响应不是合法 JSON');

  // 数据可能在 data / data.list / data.modelTypes 几处
  const data = root.data;
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    arr = Array.isArray(data.list) ? data.list
      : Array.isArray(data.modelTypes) ? data.modelTypes
      : Array.isArray(data.records) ? data.records
      : [];
  }

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;

    const extended = item.extendedInfo && typeof item.extendedInfo === 'object' ? item.extendedInfo : null;
    if (extended && jsTruthy(extended.isAuto)) continue;

    const provider = String(item.provider || '').trim();
    if (provider && provider.toUpperCase() === 'USER_CUSTOM') continue;

    const id = String(item.modelTypeName || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const caption = String((extended && extended.modelCaptionZhCN) || '').trim();
    const description = String(item.description || '').trim();
    const name = caption || description || id;

    // 思考能力：顶层 supportThinking；缺省时看 parameterDefinitions 里有没有 effort
    let supportsReasoning = false;
    if (item.supportThinking !== undefined) {
      supportsReasoning = jsTruthy(item.supportThinking);
    } else if (Array.isArray(item.parameterDefinitions)) {
      supportsReasoning = item.parameterDefinitions.some(
        (d) => d && String(d.id || '') === 'effort',
      );
    }

    const modelType = Number(item.modelTypeId !== undefined ? item.modelTypeId : item.modelType);
    out.push({
      id,
      name,
      contextWindow: Number(item.contextWindow || item.maxContextTokens || 0) || 0,
      supportsTools: true,
      supportsReasoning,
      // 上游要数字 modelType 才能建会话，留在内部字段里
      modelType: Number.isFinite(modelType) ? modelType : null,
    });
  }

  // 缓存一份 id → modelType 供对话时查
  modelTypeCache = out;
  return out.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    supportsTools: m.supportsTools,
    supportsReasoning: m.supportsReasoning,
  }));
}

let modelTypeCache = [];

async function modelTypeOf(cred, modelId) {
  // 先查缓存，没有再拉一次
  let entry = modelTypeCache.find((m) => m.id === modelId);
  if (!entry) {
    try {
      await fetchModels({ secret: JSON.stringify({ token: cred.token, uid: cred.uid }) });
      entry = modelTypeCache.find((m) => m.id === modelId);
    } catch (e) {
      // 拉不到就用手动值
    }
  }
  if (entry && entry.modelType !== null) return entry.modelType;
  // 兜底：上游也接受数字字符串直接当 modelType 用（多数客户端就这么干）
  const n = Number(modelId);
  return Number.isFinite(n) ? n : null;
}

// ── 对话 ──────────────────────────────────────────────────────

/** 把 OpenAI messages 转成上游的 round messages 形状。 */
function toRoundMessages(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    let content = m.content;
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content }];
    } else if (!Array.isArray(content)) {
      content = [];
    }
    out.push({ role, content });
  }
  return out;
}

/**
 * 从上游事件里取 message。
 *
 * 事件形状：{message} / {data:{message}} / {result:{message}}，三处都要看。
 */
function responseMessage(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.message) return event.message;
  if (event.data && typeof event.data === 'object' && event.data.message) return event.data.message;
  if (event.result && typeof event.result === 'object' && event.result.message) return event.result.message;
  return null;
}

function responseError(event) {
  if (!event || typeof event !== 'object') return null;
  const nested = event.data && typeof event.data === 'object' ? event.data : null;
  const result = event.result && typeof event.result === 'object' ? event.result : null;

  let err = null;
  if (event.error) err = event.error;
  else if (nested && nested.error) err = nested.error;
  else if (result && result.error) err = result.error;
  if (!err || typeof err !== 'object') return null;

  const message =
    String(err.message || err.msg || '') ||
    `上游返回错误 code=${err.code === undefined ? 'unknown' : err.code}`;
  const status = Number(err.httpStatus);
  return { message, status: Number.isFinite(status) ? status : 502 };
}

/** 全量 → 增量：非前缀时整体重发（宁多发不丢）。 */
function suffixAfter(current, previous) {
  if (current === previous) return null;
  return current.startsWith(previous) ? current.slice(previous.length) : current;
}

async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);
  const modelType = await modelTypeOf(cred, model);
  if (modelType === null) {
    return { status: 400, model, error: { status: 400, message: `模型 ${model} 找不到对应的 modelType` } };
  }

  const conversationId = newRequestId();
  const roundMessages = toRoundMessages(src.messages);

  // 第一步：提交本轮消息
  const roundBody = {
    conversationId,
    source: SOURCE,
    messages: roundMessages,
    modelType,
    mode: MODE,
    permissionMode: PERMISSION_MODE,
    toolVersion: TOOL_VERSION,
  };
  try {
    const roundRes = await http.postJson(
      BASE_URL + P.round,
      roundBody,
      headers(cred, 'application/json'),
      60000,
    );
    if (roundRes.status < 200 || roundRes.status >= 300) {
      return {
        status: roundRes.status,
        model,
        error: { status: roundRes.status, message: `round 阶段 HTTP ${roundRes.status}：${roundRes.text.slice(0, 200)}` },
      };
    }
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: `round 阶段失败：${e.message}` } };
  }

  // 第二步：建 turn 流
  let text = '';
  let reasoning = '';
  let sawError = null;

  const splitter = sse.createLineSplitter((line) => {
    const payload = sse.dataPayload(line);
    if (payload === null || payload === '[DONE]') return;
    const event = safeJson(payload);
    if (!event) return;

    const err = responseError(event);
    if (err) {
      sawError = err;
      return;
    }

    const message = responseMessage(event);
    if (!message || typeof message !== 'object') return;

    // content 是块数组：只取 type=text 的块，分别累加正文与思考
    let textValue = '';
    let reasoningValue = '';
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue;
        if (String(block.type || '') !== 'text') continue;
        if (typeof block.text === 'string') textValue += block.text;
        if (typeof block.reasoningContent === 'string') reasoningValue += block.reasoningContent;
      }
    }

    const textDelta = suffixAfter(textValue, text);
    const reasoningDelta = suffixAfter(reasoningValue, reasoning);
    text = textValue;
    reasoning = reasoningValue;

    const delta = {};
    if (textDelta) delta.content = textDelta;
    if (reasoningDelta) delta.reasoning_content = reasoningDelta;
    if (Object.keys(delta).length === 0) return;

    onLine(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: null }],
        }),
    );
  });

  try {
    const turnBody = Object.assign({}, roundBody, {
      turnRequestId: newRequestId(),
      conversationId,
    });
    const res = await http.stream(
      {
        url: BASE_URL + P.turn,
        headers: headers(cred, 'text/event-stream'),
        body: JSON.stringify(turnBody),
        timeout: 900000,
      },
      splitter,
    );
  if (res.done) await res.done;

    if (res.status < 200 || res.status >= 300) {
      return {
        status: res.status,
        headers: res.headers,
        model,
        error: { status: res.status, message: `turn 阶段 HTTP ${res.status}` },
      };
    }
    if (sawError) {
      return {
        status: sawError.status,
        headers: res.headers,
        model,
        error: { status: sawError.status, message: sawError.message },
      };
    }
    onLine('data: [DONE]');
    return { status: res.status, headers: res.headers, model };
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: `turn 阶段失败：${e.message}` } };
  }
}

// ── 积分 ──────────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');

  const res = await http.get(BASE_URL + P.balance, headers(cred, 'application/json'), 30000);
  if (res.status < 200 || res.status >= 300) throw new Error(`额度接口 HTTP ${res.status}`);

  const root = safeJson(res.text) || {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  let credit = -1;
  for (const k of ['balance', 'remaining', 'credits', 'remain', 'total']) {
    const n = Number(data[k]);
    if (Number.isFinite(n)) {
      credit = n;
      break;
    }
  }
  return { credit, creditText: credit >= 0 ? String(credit) : '', raw: data };
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl() {
  return 'https://catx.nocode.cn/';
}

async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  // 凭证是 X-Passport-Token，且 uid 必须成对取到
  const token = jar['X-Passport-Token'] || jar.passportToken || jar.token || '';
  const uid = jar['user-uid'] || jar.uid || jar.userUid || '';
  if (!token) throw new Error('cookie 里没有 X-Passport-Token，请先登录 CatPaw');
  if (!uid) throw new Error('缺 uid：CatPaw 的凭证需要 X-Passport-Token 与 user-uid 成对');

  return makeAccount('catpaw', String(uid), '', JSON.stringify({ token, uid, loginName: '' }));
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.token || s.passportToken)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      token: s.token || s.passportToken || '',
      uid,
      loginName: s.loginName || nick,
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

    const uid = importer.resolveUid(item, secret, 'catpaw');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('catpaw', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 工具函数 ──────────────────────────────────────────────────

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

function parseAccountsJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.accounts)) return obj.accounts;
    if (obj && typeof obj === 'object') return [obj];
  } catch (e) {
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
  id: 'catpaw',
  displayName: '美团',
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

  _internal: { suffixAfter, toRoundMessages, responseMessage, jsTruthy },
};
