'use strict';

/**
 * 讯飞星辰 / AStudio（Astron Studio）。
 *
 * 三个域各管各的，不能混用：
 *   会话域  https://agent.xfyun.cn/xingchen-studio          登录、签到、积分、换模型凭据（Cookie）
 *   目录域  https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager  模型清单（Bearer）
 *   推理域  https://maas-api.cn-huabei-1.xf-yun.com/v1      chat/completions（Bearer）
 *
 * 两套凭据：
 *   - 会话：ssoSessionId（长期），Cookie 里**必须同时发** ssoSessionId 与 sso_sessionid 两种写法
 *   - 模型：modelBearer（短期），由 `bot/models/configs` 换来，401 时重换
 *
 * 签到顺序极易搞反：
 *   1. POST /tenant-app/v2/init-app   ← 真正的发奖动作，当日首次调用入账
 *   2. POST /client-popups/complete   ← 只关到账横幅，不发积分
 * 只做第 2 步是领不到积分的。
 */

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const WORKSPACE = 'https://agent.xfyun.cn/xingchen-studio';
const MODEL_MANAGER = 'https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager';
const INFERENCE = 'https://maas-api.cn-huabei-1.xf-yun.com/v1';

const STUDIO_VERSION = '3.5.2';
const CLIENT_TYPE = '21';
const USER_AGENT = `AStudio/${STUDIO_VERSION} (Windows)`;

const P = {
  modelConfigs: '/bot/models/configs',
  userInfo: '/userInfo',
  initApp: '/tenant-app/v2/init-app',
  balance: '/points/balance',
  pointsSummary: '/points/summary',
  membership: '/membership/me',
  popups: '/client-popups/pending',
  popupComplete: '/client-popups/complete',
  downloadReward: '/client-download-reward/claim',
  models: '/models',
  chat: '/chat/completions',
};

// 只处理这三种运营弹窗；DAILY_REWARD_DIALOG 只是通知，完成它不发积分
const SUPPORTED_POPUPS = new Set(['DAILY_REWARD_DIALOG', 'BETA_CLAIM', 'DOWNLOAD_REWARD']);

// ── 请求头 ────────────────────────────────────────────────────

/** 会话域：只认 Cookie。 */
function sessionHeaders(cred) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'client-type': CLIENT_TYPE,
    'studio-version': STUDIO_VERSION,
    Cookie: cred.cookie(),
  };
}

/** 目录域与推理域：只认 Bearer。 */
function bearerHeaders(bearer, uid) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: 'Bearer ' + bearer,
  };
  if (uid) h['x-uid'] = uid;
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

/**
 * 组装会话 Cookie。
 *
 * 抓包确认上游对两种大小写都认，但只发一种时偶发认不出登录态，
 * 所以两个都发——这是踩过的坑，别「优化」成一个。
 */
function buildCookie(ssoSessionId, accountId, token) {
  const parts = [];
  if (ssoSessionId) {
    parts.push('ssoSessionId=' + ssoSessionId);
    parts.push('sso_sessionid=' + ssoSessionId);
  }
  if (accountId) parts.push('account_id=' + accountId);
  if (token) parts.push('token=' + token);
  return parts.join('; ');
}

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const ssoSessionId = obj.ssoSessionId || obj.sso_sessionid || '';
  const accountId = obj.accountId || obj.account_id || '';
  if (!ssoSessionId && !accountId) return null;
  // 抓包证实 token 的值就是 ssoSessionId，缺 token 时用它补
  const token = obj.token || ssoSessionId;

  return {
    ssoSessionId,
    accountId,
    token,
    uid: obj.uid || accountId,
    nickname: obj.nickname || '',
    mobile: obj.mobile || '',
    modelBearer: obj.modelBearer || '',
    baseUrl: obj.baseUrl || INFERENCE,
    cookie() {
      return buildCookie(ssoSessionId, accountId, token);
    },
  };
}

function secretOf(cred) {
  return JSON.stringify({
    ssoSessionId: cred.ssoSessionId,
    accountId: cred.accountId,
    token: cred.token,
    uid: cred.uid,
    nickname: cred.nickname,
    mobile: cred.mobile,
    modelBearer: cred.modelBearer,
    baseUrl: cred.baseUrl,
  });
}

// ── envelope 解析 ─────────────────────────────────────────────
//
// 上游响应统一是 {code, message, data}。取 data 时**必须先判断是不是对象**：
// Gson 在数组上取 getAsJsonObject 会抛异常（不是返回 null），
// JS 里 JSON.parse 后 data 可能是数组也可能缺失，两种情况都要处理。

function envelope(text) {
  const root = safeJson(text);
  if (!root) return { ok: false, desc: '响应不是合法 JSON', root: null };
  const code = Number(root.code === undefined ? 0 : root.code);
  if (code !== 0) {
    return { ok: false, desc: String(root.message || root.msg || `code=${code}`), root };
  }
  return { ok: true, desc: '', root };
}

/** 安全取 data：是对象返回对象，是数组返回数组，都没有返回 null。 */
function dataOf(root) {
  if (!root || typeof root !== 'object') return null;
  const d = root.data;
  if (d === undefined || d === null) return null;
  return d;
}

// ── 换模型凭据 ────────────────────────────────────────────────

/**
 * 用会话换 modelBearer + baseUrl。
 *
 * 响应 `data` 是数组，每项带 `api_key` / `base_url` / `is_current` / `is_default`。
 * 优先 is_current，其次 is_default，最后取第一条。
 *
 * base_url 实测是 /v2 不是 /v1，写死会 404。
 */
async function fetchModelCredential(cred) {
  const res = await http.get(WORKSPACE + P.modelConfigs, sessionHeaders(cred), 30000);
  if (res.status === 401 || res.status === 403) {
    throw new Error('登录已失效，请重新登录');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`获取模型凭据失败：HTTP ${res.status}`);
  }

  const { ok, desc, root } = envelope(res.text);
  if (!ok) throw new Error(desc || '获取模型凭据被拒');

  const data = dataOf(root);
  const arr = Array.isArray(data) ? data : (root && root.configs) || [];
  if (!Array.isArray(arr) || arr.length === 0) return { bearer: '', baseUrl: '' };

  let first = null;
  let current = null;
  let byDefault = null;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const entry = { bearer: String(item.api_key || ''), baseUrl: String(item.base_url || '') };
    if (!first) first = entry;
    if (item.is_current === true && !current) current = entry;
    if (item.is_default === true && !byDefault) byDefault = entry;
  }
  return current || byDefault || first || { bearer: '', baseUrl: '' };
}

/** 拿一个可用的 bearer；凭证里的失效时现换。 */
async function ensureBearer(cred, account) {
  if (cred.modelBearer) return { bearer: cred.modelBearer, baseUrl: cred.baseUrl };
  const fetched = await fetchModelCredential(cred);
  if (fetched.bearer) {
    cred.modelBearer = fetched.bearer;
    cred.baseUrl = fetched.baseUrl || INFERENCE;
    if (account) {
      account.secret = secretOf(cred);
      accountsDirty = true;
    }
  }
  return { bearer: cred.modelBearer, baseUrl: cred.baseUrl };
}

// 标记账号需要回写；由 registry 统一持久化
let accountsDirty = false;
function takeDirty() {
  const d = accountsDirty;
  accountsDirty = false;
  return d;
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const m = String(requested || '').trim();
  return m && m !== 'auto' ? m : '';
}

/** 拉模型配置（主来源，带 slug / base_url / api_key）。 */
async function fetchModelConfigs(cred) {
  const res = await http.get(WORKSPACE + P.modelConfigs, sessionHeaders(cred), 30000);
  if (res.status < 200 || res.status >= 300) return [];

  const { ok, root } = envelope(res.text);
  if (!ok || !root) return [];

  const data = dataOf(root);
  const arr = Array.isArray(data) ? data : [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const slug = String(item.model || item.slug || '');
    if (!slug) continue;
    out.push({
      slug,
      displayName: String(item.name || item.display_name || slug),
      contextWindow: 0,
      baseUrl: String(item.base_url || ''),
      apiKey: String(item.api_key || ''),
      supportsTools: true,
      supportsReasoning: false,
      reasoningLevels: [],
    });
  }
  return out;
}

/**
 * 从目录域补能力。
 *
 * 响应是 `{data:{models:[...]}}`，不是 data 直接为数组——
 * 按顶层数组解析会拿到 0 条，上下文与能力全丢。
 */
async function fetchCapabilities(bearer) {
  if (!bearer) return new Map();
  const out = new Map();
  try {
    const res = await http.get(MODEL_MANAGER + P.models, bearerHeaders(bearer), 30000);
    if (res.status < 200 || res.status >= 300) return out;

    const root = safeJson(res.text);
    if (!root) return out;
    const data = root.data;
    // data 必须是对象且带 models 数组
    const arr = data && typeof data === 'object' && !Array.isArray(data) ? data.models : null;
    if (!Array.isArray(arr)) return out;

    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const slug = String(item.model || item.slug || item.id || '');
      if (!slug) continue;
      if (item.supported_in_api === false) continue;

      const levels = [];
      if (Array.isArray(item.supported_reasoning_levels)) {
        for (const lv of item.supported_reasoning_levels) {
          const effort = lv && lv.effort;
          if (effort) levels.push(String(effort));
        }
      }
      out.set(slug, {
        slug,
        displayName: String(item.display_name || item.name || ''),
        contextWindow: Number(item.context_window || item.max_context_tokens || 0) || 0,
        supportsReasoning: levels.length > 0 || item.supports_reasoning === true,
        reasoningLevels: levels,
      });
    }
  } catch (e) {
    // 目录域拉了不影响主流程
  }
  return out;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');

  const configs = await fetchModelConfigs(cred);
  if (configs.length === 0) throw new Error('模型配置为空（登录可能已失效）');

  let bearer = cred.modelBearer;
  if (!bearer) {
    try {
      const fetched = await fetchModelCredential(cred);
      bearer = fetched.bearer;
    } catch (e) {
      // 换不到也能列出模型，只是没有能力信息
    }
  }
  const caps = await fetchCapabilities(bearer);

  // 两个接口的 slug 不一致（xopdeepseekv4pro vs xopdeepseekv4pro0813），
  // 只按 slug 匹配会让部分模型没有能力，再用 display_name 兜一层
  const byName = new Map();
  for (const cap of caps.values()) {
    if (cap.displayName) byName.set(cap.displayName.trim().toLowerCase(), cap);
  }

  return configs.map((m) => {
    const cap = caps.get(m.slug) || byName.get(m.displayName.trim().toLowerCase());
    if (!cap) {
      // 目录域没拉到就当作支持工具：声明 false 会让客户端根本不传 tools，
      // 模型只能把调用写成文本，反倒真的不能用
      return {
        id: m.slug,
        name: m.displayName,
        contextWindow: 0,
        supportsTools: true,
        supportsReasoning: false,
      };
    }
    return {
      id: m.slug,
      name: m.displayName,
      contextWindow: cap.contextWindow,
      supportsTools: true,
      supportsReasoning: cap.supportsReasoning,
    };
  });
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 注入推理档位。
 *
 * 只有 `thinking:{type:"enabled"}` 能触发 reasoning_content；
 * 叠加 `reasoning_effort:"max"` 后思考长度从 66 字涨到 390 字。
 * 客户端显式指定就不覆盖。
 */
function rewriteModel(bodyObj, model, supportsReasoning) {
  const obj = Object.assign({}, bodyObj);
  if (model) obj.model = model;
  if (supportsReasoning) {
    if (obj.thinking === undefined || obj.thinking === null) {
      obj.thinking = { type: 'enabled' };
    }
    if (obj.reasoning_effort === undefined || obj.reasoning_effort === null) {
      obj.reasoning_effort = 'max';
    }
  }
  return obj;
}

/**
 * 推理域实际下发的 base_url 是 /v2，但同一 bearer 打 /v1 也能 200。
 * 这里优先用配置里给的，没有就回退 v1。
 */
function inferenceBase(baseUrl) {
  const b = String(baseUrl || '').trim();
  if (!b) return INFERENCE;
  return b.replace(/\/+$/, '');
}

async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const requested = String(src.model || '');
  const model = resolveModel(requested);

  let bearer = '';
  let baseUrl = INFERENCE;
  try {
    const ensured = await ensureBearer(cred, account);
    bearer = ensured.bearer;
    baseUrl = inferenceBase(ensured.baseUrl);
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: e.message } };
  }
  if (!bearer) {
    return { status: 401, model, error: { status: 401, message: '缺模型凭据且换不到，请重新登录' } };
  }

  const payload = rewriteModel(Object.assign({}, src, { stream: true }), model, true);
  const body = JSON.stringify(payload);
  const url = `${baseUrl}${P.chat}`;

  // 上游基本是 OpenAI 形状，只补 reasoning 别名
  const splitter = sse.createLineSplitter((line) => {
    const p = sse.dataPayload(line);
    if (p === null || p === '[DONE]') return;
    const obj = safeJson(p);
    if (!obj) return;

    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        const delta = choice && choice.delta;
        if (delta && delta.reasoning_content && !delta.reasoning) {
          delta.reasoning = delta.reasoning_content;
        }
      }
      onLine('data: ' + JSON.stringify(obj));
      return;
    }
    if (obj.error) {
      onLine('data: ' + JSON.stringify(obj));
    }
  });

  try {
    const res = await http.stream(
      { url, headers: bearerHeaders(bearer, cred.uid), body, timeout: 300000 },
      splitter,
    );
  if (res.done) await res.done;
    if (res.status === 401) {
      // 短 Bearer 过期：换一次再报错交上层重试
      try {
        const fetched = await fetchModelCredential(cred);
        if (fetched.bearer) {
          cred.modelBearer = fetched.bearer;
          account.secret = secretOf(cred);
          accountsDirty = true;
        }
      } catch (e) {
        // 换不到就原样返回 401
      }
      return {
        status: 401,
        headers: res.headers,
        model,
        error: { status: 401, message: '模型凭据过期，已尝试重新获取' },
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        status: res.status,
        headers: res.headers,
        model,
        error: { status: res.status, message: `讯飞星辰返回 HTTP ${res.status}` },
      };
    }
    onLine('data: [DONE]');
    return { status: res.status, headers: res.headers, model };
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: e.message } };
  }
}

// ── 积分 ──────────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');

  const res = await http.get(WORKSPACE + P.balance, sessionHeaders(cred), 30000);
  if (res.status < 200 || res.status >= 300) throw new Error(`积分接口 HTTP ${res.status}`);

  const { ok, root } = envelope(res.text);
  if (!ok || !root) throw new Error('积分响应格式异常');

  const data = dataOf(root);
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : root;
  let credit = -1;
  for (const k of ['balance', 'points', 'total', 'remaining', 'spark']) {
    const n = Number(obj[k]);
    if (Number.isFinite(n)) {
      credit = n;
      break;
    }
  }
  return { credit, creditText: credit >= 0 ? String(credit) : '', raw: obj };
}

// ── 签到 ──────────────────────────────────────────────────────

/**
 * 签到。顺序不能反：
 *   1. init-app      真正的发奖动作
 *   2. pending 弹窗   看有哪些横幅
 *   3. complete      关横幅（不发积分，但不关会一直提示）
 */
async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };

  // 第一步：真正发奖
  let gained = 0;
  let initMessage = '';
  try {
    const res = await http.request({
      method: 'POST',
      url: WORKSPACE + P.initApp,
      headers: Object.assign(sessionHeaders(cred), {
        // 抓包确认是 form-urlencoded，body 为空
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '0',
      }),
      body: '',
      timeout: 30000,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: '登录已失效，请重新登录' };
    }
    const { ok, desc, root } = envelope(res.text);
    if (ok && root) {
      const data = dataOf(root);
      const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : root;
      for (const k of ['todayPoints', 'points', 'reward', 'spark', 'grantPoints']) {
        const n = Number(obj[k]);
        if (Number.isFinite(n) && n > 0) {
          gained = n;
          break;
        }
      }
    } else {
      initMessage = desc;
    }
  } catch (e) {
    initMessage = e.message;
  }

  // 第二步与第三步：关掉到账横幅
  try {
    const pend = await http.get(WORKSPACE + P.popups, sessionHeaders(cred), 20000);
    if (pend.status >= 200 && pend.status < 300) {
      const { ok, root } = envelope(pend.text);
      if (ok && root) {
        const data = dataOf(root);
        const arr = Array.isArray(data) ? data : (data && data.popups) || [];
        for (const popup of arr) {
          if (!popup || typeof popup !== 'object') continue;
          const type = String(popup.component_type || popup.type || '');
          // DAILY_REWARD_DIALOG 只是到账通知，完成它不发积分，但要关掉横幅
          if (!SUPPORTED_POPUPS.has(type)) continue;
          const id = popup.id || popup.popup_id || '';
          if (!id) continue;
          try {
            await http.postJson(
              WORKSPACE + P.popupComplete,
              { popup_id: id, component_type: type },
              sessionHeaders(cred),
              20000,
            );
          } catch (e) {
            // 单个弹窗失败不影响结果
          }
        }
      }
    }
  } catch (e) {
    // 关弹窗失败不算签到失败
  }

  if (gained > 0) {
    return { ok: true, message: `签到成功，+${gained} 积分`, gained };
  }
  if (initMessage) {
    // 「今日已领取」这类语义在重复调用时出现，按成功处理
    if (/已领|已签|already|repeated/i.test(initMessage)) {
      return { ok: true, message: '今日已签到' };
    }
    return { ok: false, message: initMessage };
  }
  return { ok: true, message: '签到完成' };
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl() {
  return 'https://agent.xfyun.cn/overview/';
}

async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  const ssoSessionId = jar.ssoSessionId || jar.sso_sessionid || '';
  const accountId = jar.account_id || '';
  const token = jar.token || ssoSessionId;

  if (!ssoSessionId && !accountId) {
    throw new Error('cookie 里没有 ssoSessionId 与 account_id，请先登录讯飞星辰');
  }

  const cred = {
    ssoSessionId,
    accountId,
    token,
    uid: accountId,
    nickname: '',
    mobile: '',
    modelBearer: '',
    baseUrl: INFERENCE,
    cookie() {
      return buildCookie(ssoSessionId, accountId, token);
    },
  };

  // 尽量当场把模型凭据换好；换不到也照常保存账号
  try {
    const fetched = await fetchModelCredential(cred);
    if (fetched.bearer) {
      cred.modelBearer = fetched.bearer;
      cred.baseUrl = fetched.baseUrl || INFERENCE;
    }
  } catch (e) {
    // 网络抖动不该让整个登录作废
  }

  const uid = cred.uid || ssoSessionId || 'astudio-' + hashShort(cookie);
  return makeAccount('astudio', String(uid), '', secretOf(cred));
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return !!(s.ssoSessionId || s.sso_sessionid || s.accountId || s.account_id);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return ((s, uid, nick) => {
      const sso = s.ssoSessionId || s.sso_sessionid || '';
      return {
        ssoSessionId: sso,
        accountId: s.accountId || s.account_id || uid,
        token: s.token || sso,
        uid,
        nickname: nick,
        mobile: s.mobile || '',
        modelBearer: s.modelBearer || '',
        baseUrl: s.baseUrl || 'https://maas-api.cn-huabei-1.xf-yun.com/v1',
      };
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

    const uid = importer.resolveUid(item, secret, 'astudio');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('astudio', uid, nickname, JSON.stringify(built), extraOf(built)));
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
  return require('crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
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
  id: 'astudio',
  displayName: '讯飞星辰',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN],
  defaultModel: '',

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  loginUrl,
  accountFromCookie,
  importCredentials,

  takeDirty,
  _internal: { envelope, dataOf, buildCookie, rewriteModel },
};
