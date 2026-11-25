'use strict';

/**
 * Trae（字节 SOLO 通道）。
 *
 * 两个区域各一套域名，不能混用：
 *   国内版 cn     : agent=trae-api-cn.mchost.guru  ug=api.trae.cn       额度和签到走 v2
 *   国际版 global : agent=trae-api-sg.mchost.guru  ug=ug-normal.trae.ai 额度和签到走 v1
 *
 * 鉴权不是 Bearer，而是三件套：
 *   Authorization: Cloud-IDE-JWT <token>
 *   X-Cloudide-Token / X-Ide-Token: <同一个 token>
 *
 * 上游是 Go 结构体，不认识未知字段——多传一个就 4001「param is invalid」，
 * 所以请求体必须做白名单裁剪。
 *
 * 国际版没有签到制度（前端 JS 里 checkin 零命中）。
 */

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const CLIENT_ID = 'en1oxy7wnw8j9n';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const FUNCTION = 'solo_work_lite';

const EP_CHAT = '/api/agent/v3/llm_utils_chat';
const EP_MODELS = '/api/ide/v1/get_detail_param';
const EP_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const EP_USER_INFO = '/cloudide/api/v3/trae/GetUserInfo';
const EP_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const EP_CHECKIN_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';
const EP_ENT_USAGE_WEB = '/trae/api/v2/pay/web_user_ent_usage';
const EP_ENT_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';
const EP_ENTITLEMENT_INTL = '/trae/api/v1/pay/user_current_entitlement_list';

const DEFAULT_CONFIG_NAME = 'glm-5.2';

/** 客户端版本：上游按 X-Ide-Version 决定模型可用性，太旧会 4001。 */
const VERSION = {
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  pluginVersion: '2.3.62834',
  deviceBrand: '83DG',
  osVersion: 'Windows 11 Pro',
};

const REGIONS = {
  cn: {
    id: 'cn',
    label: '国内版',
    agentHost: 'https://trae-api-cn.mchost.guru',
    ugHost: 'https://api.trae.cn',
    oauthHost: 'https://api.trae.com.cn',
    consoleHost: 'https://www.trae.cn',
    payVersion: 'v2',
    supportsCheckin: true,
    userRegion: 'CN',
  },
  global: {
    id: 'global',
    label: '国际版',
    agentHost: 'https://trae-api-sg.mchost.guru',
    ugHost: 'https://ug-normal.trae.ai',
    oauthHost: 'https://api.trae.ai',
    consoleHost: 'https://www.trae.ai',
    payVersion: 'v1',
    supportsCheckin: false,
    userRegion: 'US',
  },
};

function regionOf(regionId) {
  const key = String(regionId || '').trim().toLowerCase();
  return REGIONS[key] || REGIONS.cn;
}

/** 从凭证里的区域字段推断：既写过 cn/global，也写过主机名。 */
function inferRegion(explicit, domain) {
  const values = [explicit, domain].map((v) => String(v || '').trim().toLowerCase());
  if (values.includes('cn')) return REGIONS.cn;
  if (values.includes('global')) return REGIONS.global;
  if (values.some((v) => v.includes('trae.ai'))) return REGIONS.global;
  return REGIONS.cn;
}

// ── 请求头 ────────────────────────────────────────────────────

function ua() {
  return (
    `Trae/${VERSION.ideVersion} (Windows NT 10.0; Win64; x64) ` +
    `Electron/30.0.0 Chrome/124.0.0.0 Safari/537.36`
  );
}

/** 对话端点（SOLO 通道）的头族。 */
function soloHeaders(account, stream) {
  const h = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': ua(),
    Authorization: 'Cloud-IDE-JWT ' + account.accessToken,
    'X-Cloudide-Token': account.accessToken,
    'X-Ide-Token': account.accessToken,
    'X-App-Id': APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': VERSION.ideVersion,
    'X-Ide-Version-Code': VERSION.ideVersionCode,
    'X-App-Version-Code': VERSION.ideVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': VERSION.osVersion,
    'X-Device-Brand': VERSION.deviceBrand,
    'Request-Traffic-Type': 'prod',
  };
  if (account.uid) h['X-Uid'] = account.uid;
  if (account.machineId) h['X-Machine-Id'] = account.machineId;
  if (account.deviceId) h['x-device-id'] = account.deviceId;
  return h;
}

/**
 * 签到与积分接口的头族。
 *
 * 设备指纹头是必须的：UG 接口会校验，缺任一项会被以 9074
 * 「当前参与用户太多」为由拒绝签到。
 */
function ugHeaders(account, region) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': ua(),
    Authorization: 'Cloud-IDE-JWT ' + account.accessToken,
    'X-User-Region': region.userRegion,
    'x-device-brand': VERSION.deviceBrand,
    'x-device-type': 'windows',
    'x-os-version': VERSION.osVersion,
    'x-app-version': VERSION.ideVersion,
  };
  if (account.uid) h['X-Uid'] = account.uid;
  if (account.deviceId) h['x-device-id'] = account.deviceId;
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const accessToken = obj.accessToken || obj.access_token || '';
  if (!accessToken) return null;
  const region = inferRegion(obj.region || obj.domain, obj.domain || '');
  return {
    accessToken,
    refreshToken: obj.refreshToken || '',
    expiresAt: Number(obj.expiresAt || 0),
    uid: obj.uid || account.uid || '',
    machineId: obj.machineId || '',
    deviceId: obj.deviceId || '',
    region,
    nickname: obj.nickname || account.nickname || '',
  };
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
  if (!m || m === 'auto') return DEFAULT_CONFIG_NAME;
  return m;
}

async function fetchModels(account) {
  const a = parse(account);
  if (!a) throw new Error('凭证无法解析');
  const region = a.region;

  const res = await http.postJson(
    region.agentHost + EP_MODELS,
    { function: FUNCTION },
    soloHeaders(a, false),
    30000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型接口 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;

  // 真实结构（实测）：顶层直接是 config_info_list，不在 data 下。
  // 每项字段：config_name（slug）/ display_config.display_name / config_switch /
  //            is_invisible_to_user / context_window_tokens / display_config.model_capability
  const arr = Array.isArray(data.config_info_list)
    ? data.config_info_list
    : Array.isArray(obj.config_info_list)
      ? obj.config_info_list
      : [];

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.config_name || '');
    if (!id || seen.has(id)) continue;
    // is_invisible_to_user 为真的不对外暴露
    if (item.is_invisible_to_user === true) continue;
    // config_switch 为 false 的模型不可用
    if (item.config_switch === false) continue;
    seen.add(id);

    const display = item.display_config || {};
    const cap = String(display.model_capability || '');
    // 上下文：context_window_tokens 是个对象（如 {dev: 256000}），取第一个数值
    let ctx = 0;
    const cw = item.context_window_tokens;
    if (typeof cw === 'number') ctx = cw;
    else if (cw && typeof cw === 'object') {
      for (const v of Object.values(cw)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > ctx) ctx = n;
      }
    }

    out.push({
      id,
      name: String(display.display_name || id),
      contextWindow: ctx,
      supportsTools: true,
      supportsReasoning: cap === 'reasoning_model' || !!display.reasoning,
    });
  }

  if (out.length === 0) {
    out.push({ id: DEFAULT_CONFIG_NAME, name: DEFAULT_CONFIG_NAME, contextWindow: 0, supportsTools: true, supportsReasoning: false });
  }
  return out;
}

// ── 请求体改写 ────────────────────────────────────────────────

/** 上游 llm_utils_chat 认识的全部字段；其余一律删掉。 */
const ALLOWED_FIELDS = new Set([
  'config_name', 'model', 'messages', 'stream', 'function',
  'tools', 'tool_choice', 'functions',
  'temperature', 'top_p', 'max_tokens', 'n', 'stop',
  'frequency_penalty', 'presence_penalty',
  'poly_prompt', 'session_id', 'mode_type', 'agent_type',
]);

/**
 * 把 OpenAI 请求体改写成上游能接受的样子。
 *
 * 三处必须改：
 * 1. 只保留白名单字段——多一个未知字段整条请求会被 4001 拒掉
 * 2. `developer` 角色改 `system`（新版客户端会发 developer，上游不认）
 * 3. 字符串 content 包成 [{type:text, text:"..."}]（上游要数组）
 */
function prepareBody(src, fallbackModel) {
  const obj = Object.assign({}, src);
  obj.stream = true;
  obj.function = FUNCTION;

  // 别名归一要在裁剪之前：先把 max_completion_tokens 收成 max_tokens
  if (obj.max_completion_tokens !== undefined && obj.max_tokens === undefined) {
    obj.max_tokens = obj.max_completion_tokens;
  }
  delete obj.stream_options;
  delete obj.max_completion_tokens;

  // messages 改写
  if (Array.isArray(obj.messages)) {
    obj.messages = obj.messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const msg = Object.assign({}, m);
      if (msg.role === 'developer') msg.role = 'system';
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content }];
      }
      return msg;
    });
  }

  const model = String(obj.model || '').trim() || fallbackModel || DEFAULT_CONFIG_NAME;
  obj.config_name = model;
  obj.model = model;

  // 白名单裁剪
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) delete obj[key];
  }
  return obj;
}

// ── 对话 ──────────────────────────────────────────────────────

async function openChat(account, openAiBody, onLine) {
  const a = parse(account);
  if (!a) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);
  const body = JSON.stringify(prepareBody(src, model));

  // SOLO 事件名在 event: 行，正文在 data: 行
  let currentEvent = '';
  const splitter = sse.createLineSplitter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      currentEvent = trimmed.slice(6).trim();
      return;
    }
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;

    const raw = safeJson(payload);
    if (!raw) return;

    if (currentEvent === 'output') {
      const delta = {};
      if (typeof raw.response === 'string' && raw.response) delta.content = raw.response;
      if (typeof raw.reasoning_content === 'string' && raw.reasoning_content) {
        delta.reasoning_content = raw.reasoning_content;
      }
      if (raw.tool_calls) delta.tool_calls = raw.tool_calls;
      if (Object.keys(delta).length === 0) return;
      onLine(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: null }],
          }),
      );
      return;
    }

    if (currentEvent === 'error') {
      const code = Number(raw.code || 0);
      onLine(
        'data: ' +
          JSON.stringify({
            error: { message: String(raw.message || '上游错误'), type: 'upstream_error', code },
          }),
      );
      return;
    }

    if (currentEvent === 'done') {
      const finish = String(raw.finish_reason || 'stop');
      onLine(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
          }),
      );
    }
  });

  try {
    const res = await http.stream(
      {
        url: a.region.agentHost + EP_CHAT,
        headers: soloHeaders(a, true),
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
        model,
        error: { status: res.status, message: `Trae 返回 HTTP ${res.status}` },
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
  const a = parse(account);
  if (!a) throw new Error('凭证无法解析');
  const region = a.region;

  // 国内版依次试三个入口；国际版只有一个
  const paths = region.id === 'cn'
    ? [EP_ENT_USAGE_WEB, EP_ENT_USAGE]
    : [EP_ENTITLEMENT_INTL];

  let lastError = '';
  for (const path of paths) {
    try {
      const res = await http.postJson(region.ugHost + path, {}, ugHeaders(a, region), 30000);
      if (res.status < 200 || res.status >= 300) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const obj = safeJson(res.text) || {};
      const data = obj.data || obj;

      // 优先 usage_summary，其次额度包累加
      const summary = data.usage_summary || data.usageSummary;
      let credit = -1;
      if (summary && typeof summary === 'object') {
        for (const k of ['ide_credits', 'ideCredits', 'remain', 'remaining']) {
          const n = Number(summary[k]);
          if (Number.isFinite(n)) {
            credit = n;
            break;
          }
        }
      }
      if (credit < 0 && Array.isArray(data.user_entitlement_pack_list)) {
        let sum = 0;
        let found = false;
        for (const pack of data.user_entitlement_pack_list) {
          if (!pack || typeof pack !== 'object') continue;
          const n = Number(pack.remain !== undefined ? pack.remain : pack.quota);
          if (Number.isFinite(n)) {
            sum += n;
            found = true;
          }
        }
        if (found) credit = sum;
      }
      return { credit, creditText: credit >= 0 ? String(credit) : '', raw: data };
    } catch (e) {
      lastError = e.message;
    }
  }
  throw new Error(`积分接口失败：${lastError}`);
}

// ── 签到 ──────────────────────────────────────────────────────

async function checkin(account) {
  const a = parse(account);
  if (!a) return { ok: false, message: '凭证无法解析' };
  const region = a.region;

  // 国际版没有签到制度
  if (!region.supportsCheckin) {
    return { ok: false, message: '国际版没有签到制度' };
  }

  const headers = ugHeaders(a, region);

  // 先查状态，避免重复签到被上游当错误
  try {
    const statusRes = await http.postJson(region.ugHost + EP_CHECKIN_STATUS, {}, headers, 30000);
    if (statusRes.status >= 200 && statusRes.status < 300) {
      const obj = safeJson(statusRes.text) || {};
      const data = obj.data || obj;
      const checked = data.checked_in === true || data.checkin_status === 1 || data.has_checkin === true;
      if (checked) return { ok: true, message: '今日已签到' };
    }
  } catch (e) {
    // 查状态失败不阻塞签到尝试
  }

  try {
    const res = await http.postJson(region.ugHost + EP_CHECKIN_CLAIM, {}, headers, 30000);
    const text = res.text || '';
    const obj = safeJson(text) || {};
    const code = Number(obj.code === undefined ? 0 : obj.code);

    // 9074：上游以「参与用户太多」为由拒绝，实际是设备指纹或限流问题
    if (code === 9074) {
      return { ok: false, message: '上游繁忙（9074），稍后重试' };
    }
    if (looksAlreadyDone(text)) {
      return { ok: true, message: '今日已签到' };
    }
    if (res.status >= 200 && res.status < 300 && code === 0) {
      const data = obj.data || obj;
      const gained = Number(
        data.credits !== undefined ? data.credits : (data.credit !== undefined ? data.credit : 0),
      );
      return {
        ok: true,
        message: Number.isFinite(gained) && gained > 0 ? `签到成功，+${gained} 积分` : '签到成功',
        gained: Number.isFinite(gained) ? gained : 0,
      };
    }
    return { ok: false, message: String(obj.message || obj.msg || `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl(redirect, regionId) {
  const region = regionOf(regionId);
  const cb = redirect || `${region.consoleHost}/`;
  return `${region.consoleHost}/login?client_id=${CLIENT_ID}&redirect=${encodeURIComponent(cb)}`;
}

async function accountFromCode(code, redirect, regionId) {
  const region = regionOf(regionId);
  const res = await http.postJson(
    region.oauthHost + EP_EXCHANGE,
    { client_id: CLIENT_ID, grant_type: 'authorization_code', code },
    { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': ua() },
    30000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`换取 token 失败 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const accessToken = data.access_token || data.accessToken || data.token || '';
  if (!accessToken) throw new Error('响应里没有 access_token');

  const uid =
    data.user_id || data.uid ||
    jwtClaim(accessToken, ['user_id', 'userId', 'uid', 'sub']) ||
    'trae-' + hashShort(accessToken);

  const secret = JSON.stringify({
    accessToken,
    refreshToken: data.refresh_token || data.refreshToken || '',
    expiresAt: toExpiry(data.expires_in || data.expiresIn),
    uid,
    region: region.id,
    domain: region.id,
    machineId: data.machine_id || '',
    deviceId: data.device_id || '',
    nickname: data.nickname || data.user_name || '',
  });
  return makeAccount('trae', String(uid), data.nickname || data.user_name || '', secret, {
    region: region.id,
  });
}

async function accountFromCookie(cookie, regionId) {
  const region = regionOf(regionId);
  const jar = parseCookieString(cookie);
  const token =
    jar.access_token || jar.accessToken || jar.trae_token || jar.token || jar.authorization || '';
  if (!token) throw new Error('cookie 里没有 access_token，请改用登录按钮走 code 换 token');

  const uid =
    jar.user_id || jar.uid ||
    jwtClaim(token, ['user_id', 'userId', 'uid', 'sub']) ||
    'trae-' + hashShort(token);
  const secret = JSON.stringify({
    accessToken: token,
    refreshToken: '',
    expiresAt: 0,
    uid,
    region: region.id,
    domain: region.id,
    machineId: '',
    deviceId: '',
    nickname: '',
  });
  return makeAccount('trae', String(uid), '', secret, { region: region.id });
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  // App 导出的 secret 是两层嵌套：{ auth: {...}, account: {...} }
  // 也兼容平铺形态（旧数据与手写输入）。
  const a = pickAuth(s);
  return !!(a.accessToken || a.access_token || a.token);
}

/** 从嵌套或平铺结构里取出 auth 部分。 */
function pickAuth(s) {
  if (!s || typeof s !== 'object') return {};
  if (s.auth && typeof s.auth === 'object') return s.auth;
  return s;
}

/** 从嵌套或平铺结构里取出 account 部分。 */
function pickAccount(s) {
  if (!s || typeof s !== 'object') return {};
  if (s.account && typeof s.account === 'object') return s.account;
  return {};
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  const a = pickAuth(s);
  const acc = pickAccount(s);

  // 区域：domain 可能是 cn/global，也可能是主机名
  const rawRegion = String(a.region || a.domain || s.region || s.domain || 'cn').toLowerCase();
  let reg = 'cn';
  if (rawRegion === 'global' || rawRegion.indexOf('trae.ai') >= 0) reg = 'global';

  return {
    accessToken: a.accessToken || a.access_token || a.token || '',
    refreshToken: a.refreshToken || a.refresh_token || '',
    expiresAt: Number(a.expiresAt || 0),
    uid,
    region: reg,
    domain: a.domain || s.domain || reg,
    apiHost: a.apiHost || '',
    machineId: a.machineId || '',
    deviceId: a.deviceId || '',
    enterpriseId: acc.enterpriseId || a.enterpriseId || '',
    nickname: nick || acc.nickname || '',
  };
}

/** makeAccount 的额外字段。 */
function extraOf(secret) {
  return { region: secret.region || 'cn' };
}


function importCredentials(raw) {
  const parsed = importer.parseInput(raw);
  const list = [];

  for (const item of parsed.items) {
    const secret = importer.normalizeSecret(item.secret);    if (!hasCredential(secret)) continue;

    const uid = importer.resolveUid(item, secret, 'trae');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('trae', uid, nickname, JSON.stringify(built), extraOf(built)));
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

function toExpiry(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(Date.now() / 1000) + n;
}

function looksLikeAlreadyDone(text) {
  return /已签到|已经签到|重复签到|already|checked/i.test(String(text || ''));
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
  id: 'trae',
  displayName: 'Trae',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN],
  defaultModel: DEFAULT_CONFIG_NAME,
  regions: ['cn', 'global'],

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  loginUrl,
  accountFromCode,
  accountFromCookie,
  importCredentials,

  regionOf,
  inferRegion,
};
