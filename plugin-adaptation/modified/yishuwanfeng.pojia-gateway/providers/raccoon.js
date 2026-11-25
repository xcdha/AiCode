'use strict';

/**
 * 商汤「小浣熊」（xiaohuanxiong.com）。
 *
 * 登录：`/code/authorize` 走 WebView，回调带 `authorization_code`，
 *       再换 access/refresh token。
 * 对话：`/api/web/llm/v2/chat/completions`（v2 优先，404 回退 v1）。
 *       与 OpenAI 的差别：流式帧外面多包一层 `{"status":..,"data":{...}}`，
 *       且 `delta` 可能是字符串而非对象。
 * 积分：`/api/web/points/v1/balance`。
 * 签到：桌面端 `/api/web/desktop/v1/login/points/grant`，失败回退移动端。
 */

const http = require('../lib/http');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const HOST = 'https://xiaohuanxiong.com';
const APP_NAME = 'Raccoon';

const PATH_LOGIN = '/code/authorize';
const PATH_LOGIN_WITH_CODE = '/api/web/auth/v1/login_with_authorization_code';
const PATH_USER_INFO = '/api/web/auth/v1/user_info';
const PATH_REFRESH = '/api/web/auth/v1/refresh';
const PATH_CHAT = '/api/web/llm/v2/chat/completions';
const PATH_CHAT_V1 = '/api/web/llm/v1/chat/completions';
const PATH_MODELS = '/api/web/llm/v2/model_catalog';
const PATH_BALANCE = '/api/web/points/v1/balance';
const PATH_GRANT = '/api/web/desktop/v1/login/points/grant';
const PATH_GRANT_MOBILE = '/api/mobile/desktop/v1/login/points/grant';
const PATH_SETTING_INFO = '/api/web/user/v1/setting/info';
const PATH_BILLS = '/api/web/points/v1/bills';

const DEFAULT_MODEL = 'SenseNova-V6-Pro';
const POINTS_BILLS_LIMIT = 30;

// UA 用一个固定值：上游对 UA 敏感，换版本可能导致会话判定异常
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── 请求头 ────────────────────────────────────────────────────

function jsonHeaders(accessToken) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: HOST,
    Referer: HOST + '/',
  };
  if (accessToken) h.Authorization = 'Bearer ' + accessToken;
  return h;
}

function bearerHeaders(accessToken) {
  return {
    Accept: 'application/json',
    'User-Agent': UA,
    Referer: HOST + '/',
    Authorization: 'Bearer ' + accessToken,
  };
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const accessToken = obj.accessToken || '';
  const refreshToken = obj.refreshToken || '';
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: Number(obj.expiresAt || 0),
    uid: obj.uid || account.uid || '',
    nickname: obj.nickname || account.nickname || '',
  };
}

/** 从 JWT 里取一个声明。 */
function jwtClaim(token, names) {
  if (!token) return '';
  const parts = String(token).split('.');
  if (parts.length < 2) return '';
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    for (const name of names) {
      const v = obj[name];
      if (v !== undefined && v !== null && String(v)) return String(v);
    }
  } catch (e) {
    // 解析失败走空串
  }
  return '';
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const model = String(requested || '').trim();
  if (!model || model === 'auto') return DEFAULT_MODEL;
  return model;
}

/**
 * 把 OpenAI 请求体改写成小浣熊能接受的样子。
 *
 * 保留 messages / stream / temperature / top_p / max_tokens，
 * 其余字段上游不认识会报参数错误。
 */
function prepareBody(openAiBody, model) {
  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const out = {
    model,
    messages: src.messages || [],
    stream: src.stream !== false,
  };
  for (const key of ['temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty']) {
    if (src[key] !== undefined && src[key] !== null) out[key] = src[key];
  }
  if (Array.isArray(src.tools) && src.tools.length > 0) out.tools = src.tools;
  if (src.tool_choice !== undefined) out.tool_choice = src.tool_choice;
  return out;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const res = await http.get(HOST + PATH_MODELS, jsonHeaders(cred.accessToken), 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型接口 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text);
  if (!obj) throw new Error('模型响应不是合法 JSON');

  // 真实结构：data.categories[{type,default_model,models[]}]
  // 早期版本只有 data 直接是数组或 data.models，两种都要兼容。
  const data = obj.data || obj;
  let arr = [];
  if (Array.isArray(data)) {
    arr = data;
  } else if (Array.isArray(data.categories)) {
    for (const cat of data.categories) {
      if (!cat || !Array.isArray(cat.models)) continue;
      for (const m of cat.models) arr.push(m);
    }
  } else if (Array.isArray(data.models)) {
    arr = data.models;
  } else if (Array.isArray(data.list)) {
    arr = data.list;
  }

  const out = [];
  const seen = new Set();
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    // model_name 是真实 slug，name 可能是别名
    const id = String(m.model_name || m.name || m.model || m.id || '');
    if (!id || seen.has(id)) continue;
    // visible=false 的是内部模型（如 Raccoon-Work 系列），不对外暴露；
    // 但字段缺失时当作可见，避免上游改字段后整个列表变空。
    if (m.visible === false) continue;
    seen.add(id);

    const name = String(
      m.description || m.display_description || m.display_name || id,
    );
    // 思考能力在 params.raccoon_thinking.supported
    const thinking = m.params && m.params.raccoon_thinking;
    out.push({
      id,
      name,
      contextWindow: Number(m.context_window || m.max_context_tokens || 0) || 0,
      supportsTools: Array.isArray(m.tags) ? m.tags.includes('tools') : true,
      supportsReasoning: !!(thinking && thinking.supported === true),
    });
  }

  if (out.length === 0) {
    // 返回空数组会让供应商在列表里静默消失，完全看不出原因。
    // 带上响应结构提示，方便定位上游改版。
    const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
    throw new Error(`模型目录解析出 0 条（响应结构可能已变化；data keys=${keys}）`);
  }
  return out;
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 发起对话，逐行回调上游 SSE。
 *
 * 小浣熊的帧要逐行翻译（含外层 status 包裹），所以不能直接透传原始字节，
 * 这里把流交给 onLine 回调，由调用方决定翻译还是聚合。
 *
 * @returns {Promise<{status:number, headers:object, model:string, error?:object}>}
 */
async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) {
    return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };
  }
  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);
  const body = JSON.stringify(prepareBody(src, model));

  const splitter = require('../lib/sse').createLineSplitter(onLine);
  const attempt = async (path) =>
    http.stream(
      {
        url: HOST + path,
        headers: jsonHeaders(cred.accessToken),
        body,
        timeout: 300000,
      },
      splitter,
    );

  // v2 优先，404 时回退 v1
  const v2 = await attempt(PATH_CHAT);
  const res = v2.status === 404 ? await attempt(PATH_CHAT_V1) : v2;

  // 等流真的读完再返回：上层要拿完整结果做非流式聚合，
  // 不等就会在零帧时误判成「上游返回空内容」。
  if (res.done) await res.done;

  return { status: res.status, headers: res.headers, model };
}

// ── 积分 ──────────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const res = await http.get(HOST + PATH_BALANCE, jsonHeaders(cred.accessToken), 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`积分接口 HTTP ${res.status}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  // 字段名上游换过几轮，按可能性从高到低取
  const total = pickNumber(data, [
    'total_points',
    'totalPoints',
    'points',
    'balance',
    'total',
    'available_points',
  ]);
  return {
    credit: total,
    creditText: total >= 0 ? String(total) : '',
    raw: data,
  };
}

/** 积分流水。 */
async function fetchBills(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const url = `${HOST}${PATH_BILLS}?paging.limit=${POINTS_BILLS_LIMIT}&paging.offset=0&type=all`;
  const res = await http.get(url, jsonHeaders(cred.accessToken), 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`流水接口 HTTP ${res.status}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const arr = Array.isArray(data) ? data : data.bills || data.list || [];
  return arr.map((b) => {
    if (!b || typeof b !== 'object') return null;
    return {
      id: String(b.bill_id || b.id || ''),
      title: String(b.event_name || b.title || b.biz_type || ''),
      points: Number(b.points || 0),
      createdAt: Number(b.created_at || 0),
    };
  }).filter(Boolean);
}

// ── 签到 ──────────────────────────────────────────────────────

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };

  // 桌面端接口；失败回退移动端。两边都返回「已签到」时按成功处理——
  // 上游把重复签到当错误抛出，语义上仍是「今天已经签过了」。
  const attempts = [
    { path: PATH_GRANT, headers: jsonHeaders(cred.accessToken) },
    { path: PATH_GRANT_MOBILE, headers: jsonHeaders(cred.accessToken) },
  ];

  let lastMessage = '';
  for (const attempt of attempts) {
    try {
      const res = await http.postJson(HOST + attempt.path, {}, attempt.headers, 30000);
      const text = res.text || '';
      if (res.status >= 200 && res.status < 300) {
        const obj = safeJson(text) || {};
        const code = Number(obj.code === undefined ? 0 : obj.code);
        if (code === 0) {
          const gained = pickNumber(obj.data || obj, ['points', 'grant_points', 'reward']);
          return {
            ok: true,
            message: gained > 0 ? `签到成功，+${gained} 积分` : '签到成功',
            gained: gained > 0 ? gained : 0,
          };
        }
        lastMessage = String(obj.msg || obj.message || `code=${code}`);
        if (looksLikeAlreadyDone(lastMessage)) {
          return { ok: true, message: '今日已签到' };
        }
        continue;
      }
      lastMessage = `HTTP ${res.status}`;
      if (looksLikeAlreadyDone(text)) {
        return { ok: true, message: '今日已签到' };
      }
    } catch (e) {
      lastMessage = e.message || '请求失败';
    }
  }
  return { ok: false, message: lastMessage || '签到失败' };
}

// ── 登录 ──────────────────────────────────────────────────────

/**
 * 生成登录 URL。
 *
 * 回调地址指向 App 内不会真的访问的占位，只用于让上游把 code 带回来；
 * 实际 code 从 WebView 的跳转 URL 里截。
 */
function loginUrl(redirect) {
  const cb = redirect || 'https://xiaohuanxiong.com/';
  return `${HOST}${PATH_LOGIN}?appname=${encodeURIComponent(APP_NAME)}&redirect=${encodeURIComponent(cb)}`;
}

/** 用 authorization_code 换 token。 */
async function accountFromCode(code, redirect) {
  const res = await http.postJson(
    HOST + PATH_LOGIN_WITH_CODE,
    { authorization_code: code, appname: APP_NAME, redirect_url: redirect || '' },
    jsonHeaders(null),
    30000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`换取凭证失败 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const accessToken = data.access_token || data.accessToken || '';
  if (!accessToken) throw new Error('响应里没有 access_token');

  const uid =
    data.user_id || data.uid ||
    jwtClaim(accessToken, ['user_id', 'userId', 'uid', 'sub']) ||
    'raccoon-' + hashShort(accessToken);
  const secret = JSON.stringify({
    accessToken,
    refreshToken: data.refresh_token || data.refreshToken || '',
    expiresAt: toExpiry(data.expires_in || data.expiresIn),
    uid,
    nickname: data.nickname || data.username || '',
  });
  return makeAccount('raccoon', String(uid), data.nickname || data.username || '', secret);
}

/**
 * 从 cookie 建账号。
 *
 * 小浣熊的 WebView 登录走的是 code 换 token，cookie 本身不足以建会话，
 * 所以这里只在 cookie 里找到现成 token 时才算成功。
 */
async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  const token =
    jar.access_token || jar.authorization || jar.token || jar.ACCESS_TOKEN || '';
  if (!token) throw new Error('cookie 里没有 access_token，请改用登录按钮走 code 换 token');
  const uid =
    jar.user_id || jar.uid ||
    jwtClaim(token, ['user_id', 'userId', 'uid', 'sub']) ||
    'raccoon-' + hashShort(token);
  const secret = JSON.stringify({
    accessToken: token,
    refreshToken: jar.refresh_token || '',
    expiresAt: 0,
    uid,
    nickname: '',
  });
  return makeAccount('raccoon', String(uid), '', secret);
}

/** 从 App 导出的账号 JSON / 裸 token 粘贴导入。 */

// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.accessToken || s.access_token || s.token)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      accessToken: s.accessToken || s.access_token || s.token || '',
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

    const uid = importer.resolveUid(item, secret, 'raccoon');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('raccoon', uid, nickname, JSON.stringify(built), extraOf(built)));
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

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return -1;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return -1;
}

function toExpiry(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(Date.now() / 1000) + n;
}

function looksLikeAlreadyDone(text) {
  const s = String(text || '');
  return /已签到|已经签到|重复签到|already|signed/i.test(s);
}

function parseCookieString(cookie) {
  const out = {};
  if (!cookie) return out;
  for (const part of String(cookie).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function hashShort(text) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
}

function tryParseAccountsJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.accounts)) return obj.accounts;
    if (obj && typeof obj === 'object') return [obj];
  } catch (e) {
    // 尝试多条 JSON 相连
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

// ── 导出 ──────────────────────────────────────────────────────

module.exports = {
  id: 'raccoon',
  displayName: '小浣熊',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN, CAP.POINTS_BILLS],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  fetchBills,
  checkin,
  loginUrl,
  accountFromCode,
  accountFromCookie,
  importCredentials,
};
