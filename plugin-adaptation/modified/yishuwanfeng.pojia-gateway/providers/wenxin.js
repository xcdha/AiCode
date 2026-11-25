'use strict';

/**
 * 文心（百度）网页版：chat.baidu.com。
 *
 * 鉴权：Cookie（BDUSS 为登录态核心）。
 *
 * 三步流程：
 *   1. GET 首页 HTML，正则抠出 `<script name="aiTabFrameBaseData">` 里的 JSON，
 *      拿 token 与 lid（会话标识）。
 *   2. 拼 chat_token = base64("{token}|{md5(query)}|{ts}|{lid}") + "-{lid}-3"
 *   3. POST /aichat/api/conversation，SSE 逐事件解析。
 *
 * 正文在 `data.message.content.generator`：
 *   component=`markdown-yiyan` 时取 `data.value`（增量）
 *   component=`thinkingSteps` 时取 `data.reasoningContentArr`（思考过程）
 */

const crypto = require('crypto');
const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const HOME_URL = 'https://chat.baidu.com/';
const CONVERSATION_URL = 'https://chat.baidu.com/aichat/api/conversation';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 内置模型清单：id → 上游 usedModel 组合。 */
const MODELS = [
  { id: 'smartmode', label: '智能模式', modelName: 'smartMode', deepSearch: '0', thinkMode: '0', rank: 1 },
  { id: 'smartmode-thinking', label: '智能模式 · 深度搜索', modelName: 'smartMode', deepSearch: '1', thinkMode: '1', rank: 2 },
  { id: 'ernie-5.1', label: '文心 5.1', modelName: 'ERINE-5.1', deepSearch: '0', thinkMode: '0', rank: 1 },
  { id: 'ernie-5.1-thinking', label: '文心 5.1 · 深度思考', modelName: 'ERINE-5.1', deepSearch: '1', thinkMode: '1', rank: 2 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4 Pro', modelName: 'DeepSeek-V4', deepSearch: '0', thinkMode: '1', rank: 1 },
  { id: 'deepseek-v4-pro-nothinking', label: 'DeepSeek-V4 Pro · 关闭思考', modelName: 'DeepSeek-V4', deepSearch: '0', thinkMode: '0', rank: 1 },
  { id: 'deepseek-v4-flash', label: 'DeepSeek-V4 Flash', modelName: 'DeepSeek-V4-Flash', deepSearch: '0', thinkMode: '1', rank: 1 },
  { id: 'deepseek-v4-flash-nothinking', label: 'DeepSeek-V4 Flash · 关闭思考', modelName: 'DeepSeek-V4-Flash', deepSearch: '0', thinkMode: '0', rank: 1 },
];

const DEFAULT_MODEL = 'smartmode';

function resolveModel(requested) {
  const m = String(requested || '').trim();
  if (!m || m === 'auto') return DEFAULT_MODEL;
  return m;
}

function modelOf(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const cookie = obj.cookie || '';
  if (!cookie) return null;
  return { cookie, uid: obj.uid || account.uid || '', nickname: obj.nickname || '' };
}

// ── 会话初始化 ────────────────────────────────────────────────

/**
 * 拉首页 HTML，抠出会话数据。
 *
 * 百度首页会下发新的 cookie（BDUSS 之外的辅助字段），
 * 要把 Set-Cookie 合并进现有 cookie，否则后续对话会被判未登录。
 */
async function loadSession(cookie) {
  const res = await http.get(
    HOME_URL,
    {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': UA,
      Cookie: cookie,
    },
    30000,
  );
  if (res.status < 200 || res.status >= 400) {
    throw new Error(`文心首页 HTTP ${res.status}`);
  }

  const merged = mergeCookie(cookie, res.headers['set-cookie']);
  const data = extractBaseData(res.text);
  if (!data) {
    throw new Error('无法从文心首页提取会话数据（页面结构可能已变化）');
  }
  const userInfo = data.userInfo || {};
  return {
    cookies: merged,
    token: String(data.token || ''),
    lid: String(data.lid || ''),
    isLogin: Number(userInfo.isUserLogin || 0) === 1 || merged.includes('BDUSS='),
    nickname: String(userInfo.name || ''),
  };
}

/** 从首页 HTML 里抠 aiTabFrameBaseData 的 JSON。 */
function extractBaseData(html) {
  const re = /<script[^>]*name="aiTabFrameBaseData"[^>]*>([\s\S]*?)<\/script>/;
  const m = re.exec(String(html || ''));
  if (!m) return null;
  return safeJson(m[1].trim());
}

// ── chat_token ────────────────────────────────────────────────

function md5Hex(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

/** chat_token = base64("{token}|{md5(query)}|{ts}|{lid}") + "-{lid}-3"。 */
function chatToken(token, lid, query, tsMillis) {
  const payload = `${token}|${md5Hex(query)}|${tsMillis}|${lid}`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  return `${encoded}-${lid}-3`;
}

// ── 模型 ──────────────────────────────────────────────────────

async function fetchModels() {
  return MODELS.map((m) => ({
    id: m.id,
    name: m.label,
    contextWindow: 0,
    supportsTools: false,
    supportsReasoning: m.thinkMode === '1',
  }));
}

// ── 对话 ──────────────────────────────────────────────────────

/** 组装上游请求体。字段极多，都是网页版固定值。 */
function buildPayload(query, model, ct, ts) {
  const rank = model.rank;
  return {
    message: { query },
    srcid: '',
    order: '',
    tplname: '',
    dqaKey: '',
    re_rank: String(rank),
    ori_lid: '',
    sa: 'bkb',
    enter_type: 'chat_site',
    chatInfo: {
      setype: 'csaitab',
      chat_samples: 'WISE_NEW_CSAITAB',
      chat_token: ct,
      scene: '',
    },
    isPrivateChat: false,
    usedModel: {
      modelName: model.modelName,
      modelFunction: { deepSearch: model.deepSearch, thinkMode: model.thinkMode },
    },
    landingPageSwitch: '',
    landingPage: 'aitab',
    ecomFrom: '',
    hasLocPermission: '',
    isInnovate: 2,
    applid: '',
    a_lid: '',
    showMindMap: false,
    deepDecisionInfo: { isDeepDecision: 0 },
    inputMethod: 'chat_search',
    isRebuild: false,
    searchInfo: {
      query: '',
      agentInfo: {
        agent_id: [''],
        params: JSON.stringify({ agt_rk: rank, agt_sess_cnt: 1 }),
      },
      agentInfoList: [],
      qtype: 0,
    },
    from: '',
    antiExtJson: JSON.stringify({ inputT: null, ck1: ts, ck9: 500, ck10: 400 }),
  };
}

/** X-Chat-Message 审计头：只放前若干字符，超长会被上游拒绝。 */
function xChatMessage(query, model, ts) {
  const cut = String(query).slice(0, 120);
  return JSON.stringify({
    message: cut,
    usedModel: model.modelName,
    ts,
  });
}

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
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析（缺 cookie）' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const modelId = resolveModel(src.model);
  const model = modelOf(modelId);
  const query = flattenMessages(src.messages);

  let session;
  try {
    session = await loadSession(cred.cookie);
  } catch (e) {
    return { status: 502, model: modelId, error: { status: 502, message: e.message } };
  }
  if (!session.isLogin) {
    return { status: 401, model: modelId, error: { status: 401, message: '文心未登录（cookie 里没有 BDUSS）' } };
  }

  const ts = Date.now();
  const ct = chatToken(session.token, session.lid, query, ts);
  const body = JSON.stringify(buildPayload(query, model, ct, ts));

  const splitter = sse.createLineSplitter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // 事件名单独一行，正文在随后的 data: 行
    if (trimmed.startsWith('event:')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    const frame = safeJson(payload);
    if (!frame) return;
    const dataObj = frame.data;
    if (!dataObj || typeof dataObj !== 'object') return;

    const message = dataObj.message || dataObj;
    const content = message.content;
    if (!content || typeof content !== 'object') return;

    // 思考过程
    if (typeof content.thinking === 'string' && content.thinking) {
      onLine(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { reasoning_content: content.thinking }, finish_reason: null }],
          }),
      );
    }

    const generator = content.generator;
    if (!generator) return;
    const component = String(generator.component || '');
    const genData = generator.data || {};

    if (component === 'markdown-yiyan') {
      const value = typeof genData.value === 'string' ? genData.value : '';
      if (value) {
        onLine(
          'data: ' +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: value }, finish_reason: null }],
            }),
        );
      }
      return;
    }

    if (component === 'thinkingSteps') {
      const arr = genData.reasoningContentArr;
      if (Array.isArray(arr)) {
        const text = arr.map((x) => String(x || '')).join('');
        if (text) {
          onLine(
            'data: ' +
              JSON.stringify({
                choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
              }),
            );
        }
      }
    }
  });

  try {
    const res = await http.stream(
      {
        url: CONVERSATION_URL,
        headers: {
          'User-Agent': UA,
          Accept: 'text/event-stream',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Referer: 'https://wenxin.baidu.com/',
          Origin: 'https://wenxin.baidu.com',
          'Content-Type': 'application/json',
          'X-Chat-Message': xChatMessage(query, model, ts),
          isDeepseek: '1',
          landingPageSwitch: '',
          personifiedSwitch: '0',
          source: 'pc_csaitab',
          Cookie: session.cookies,
        },
        body,
        timeout: 300000,
      },
      splitter,
    );
  if (res.done) await res.done;

    if (res.status < 200 || res.status >= 300) {
      return {
        status: res.status,
        headers: res.headers,
        model: modelId,
        error: { status: res.status, message: `文心返回 HTTP ${res.status}` },
      };
    }
    onLine('data: [DONE]');
    return { status: res.status, headers: res.headers, model: modelId };
  } catch (e) {
    return { status: 502, model: modelId, error: { status: 502, message: e.message } };
  }
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl() {
  return 'https://wappass.baidu.com/passport/?login&u=https%3A%2F%2Fwenxin.baidu.com%2F';
}

async function accountFromCookie(cookie) {
  if (!String(cookie || '').includes('BDUSS=')) {
    throw new Error('cookie 里没有 BDUSS，请先登录百度账号');
  }
  const jar = parseCookieString(cookie);
  const bduss = jar.BDUSS || '';
  const uid = jar.BAIDUID || 'wenxin-' + hashShort(bduss || cookie);
  return makeAccount('wenxin', String(uid), '', JSON.stringify({
    cookie,
    uid: String(uid),
    nickname: '',
  }));
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return ((s) => {
      const c = s.cookie || s.Cookie || '';
      return typeof c === 'string' && c.includes('BDUSS=');
    })(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return {
    cookie: s.cookie || s.Cookie || '',
    uid,
    nickname: nick,
  };
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

    const uid = importer.resolveUid(item, secret, 'wenxin');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('wenxin', uid, nickname, JSON.stringify(built), extraOf(built)));
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

/** 把 Set-Cookie 响应头合并进现有 cookie 串（同名覆盖）。 */
function mergeCookie(existing, setCookieHeaders) {
  const map = new Map();
  for (const [k, v] of Object.entries(parseCookieString(existing))) map.set(k, v);

  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
    ? [setCookieHeaders]
    : [];
  for (const raw of list) {
    const first = String(raw).split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
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
  id: 'wenxin',
  displayName: '文心',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  loginUrl,
  accountFromCookie,
  importCredentials,

  _internal: { extractBaseData, chatToken, md5Hex, buildPayload },
};
