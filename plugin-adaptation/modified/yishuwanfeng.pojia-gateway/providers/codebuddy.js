'use strict';

/**
 * 腾讯 WorkBuddy / CodeBuddy（`copilot.tencent.com`，国际版 `workbuddy.ai`）。
 *
 * 登录是设备授权：`POST /v2/plugin/auth/state?platform=CLI` 拿授权链接，
 * 用户扫码/登录后 `GET /v2/plugin/auth/token?state=…` 轮询拿 token。
 * 对话走 `/v2/chat/completions`（OpenAI 兼容，但**上游拒绝非流式**，必须强制 `stream:true`）。
 *
 * 这套实现按区域分叉：国内（copilot.tencent.com + www.codebuddy.cn）与国际
 * （www.workbuddy.ai）。同一个账号的每个请求都必须从同一处取端点，否则会出现
 * 「一部分请求打到另一个站点」——拿国际版 token 打国内站点会被直接回 500。
 */

const crypto = require('crypto');

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

// ── 常量 ──────────────────────────────────────────────────────

const REGION_CN = 'cn';
const REGION_GLOBAL = 'global';

const CN_ENDPOINT = {
  label: '国内版',
  chatBase: 'https://copilot.tencent.com',
  billingBase: 'https://www.codebuddy.cn',
  origin: 'https://www.codebuddy.cn',
  modelsPath: '/console/enterprises/personal/models',
  extraHeaders: {},
};

/**
 * 国际版的模型目录来源是客户端 product config（`/v3/config`）。
 *
 * 国内那条 `/console/...` 只服务网页会话：无凭证时 302 跳 OIDC，拿 Bearer token 打它会被
 * 后端 500；`/v2/enterprises/personal/models` 则一直不返回。国际版客户端实际读 `/v3/config`，
 * 与国内那份响应同构（`data.agents[cli].models`），所以解析逻辑共用。
 */
const GLOBAL_ENDPOINT = {
  label: '国际版',
  chatBase: 'https://www.workbuddy.ai',
  billingBase: 'https://www.workbuddy.ai',
  origin: 'https://www.workbuddy.ai',
  modelsPath: '/v3/config',
  extraHeaders: { 'X-Agent-Type': 'main' },
};

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

// 上游有 /v2/plugin/auth/token/refresh（带 X-Refresh-Token 头、不带 Authorization）。
// 插件没有后台调度，且 accessToken 有效期约 30 天，续期交给用户重新走设备授权。

const PATH_AUTH_STATE = '/v2/plugin/auth/state';
const PATH_AUTH_TOKEN = '/v2/plugin/auth/token';
const PATH_CHAT = '/v2/chat/completions';
const PATH_USER_RESOURCE = '/v2/billing/meter/get-user-resource';
const PATH_CHECKIN = '/v2/billing/meter/daily-checkin';
const PATH_GROWTH = '/v2/activity/growth';

const DEFAULT_MODEL = 'default-model';
const PRODUCT_CODE = 'p_tcaca';
const MAX_LOTTERY_DRAWS = 10;

/** 设备授权等待中的业务码。 */
const CODE_LOGIN_PENDING = 11217;

/** 会话指纹算不出来时的固定会话 ID：保持「同会话同值」，绝不用随机值。 */
const FALLBACK_CONVERSATION_ID = '00000000-0000-0000-0000-000000000000';

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

/** 模型目录是普通 JSON 接口，用短超时：对话那套 300s 会把真实错误盖掉。 */
const MODELS_TIMEOUT = 15000;
const API_TIMEOUT = 30000;
const CHAT_TIMEOUT = 300000;

// ── 请求头 ────────────────────────────────────────────────────

function commonHeaders(cred) {
  const origin = originFor(cred);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: origin + '/',
    'User-Agent': CLIENT_UA,
  };
}

function chatHeaders(cred, body) {
  const h = commonHeaders(cred);
  h.Authorization = 'Bearer ' + cred.accessToken;
  if (cred.uid) h['X-User-Id'] = cred.uid;
  // 官方客户端每个请求都同时发这两个头。只带一个时上游会按个人账号回答，
  // 企业套餐的模型目录与能力会静默退化成个人版。
  if (cred.enterpriseId) {
    h['X-Enterprise-Id'] = cred.enterpriseId;
    h['X-Tenant-Id'] = cred.enterpriseId;
  }
  if (cred.domain) h['X-Domain'] = cred.domain;
  h['X-Product'] = 'SaaS';
  if (body !== undefined && body !== null) Object.assign(h, conversationHeaders(body));
  return h;
}

/**
 * 会话 ID 头族。
 *
 * `X-Conversation-ID` 必须在同一会话内稳定：上游按它给提示词缓存分桶，每请求换一个新 id
 * 会让请求落到不同桶——长上下文下实测 0% 前缀命中、积分多花约 3 倍。所以它由消息前缀
 * 确定性派生；其余三个 id 每请求换新（官方 CLI 也是如此）。
 */
function conversationHeaders(body) {
  const traceId = uuid4();
  return {
    'X-Conversation-ID': stableConversationId(body) || FALLBACK_CONVERSATION_ID,
    'X-Conversation-Request-ID': uuid4(),
    'X-Conversation-Message-ID': uuid4(),
    'X-Request-ID': traceId,
    'X-Trace-ID': traceId,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'x-codebuddy-request': '1',
  };
}

function modelsHeaders(cred) {
  const h = chatHeaders(cred, null);
  const ep = endpointOf(regionOf(cred));
  Object.assign(h, ep.extraHeaders);
  return h;
}

function billingHeaders(cred) {
  const origin = originFor(cred);
  const h = {
    Authorization: 'Bearer ' + cred.accessToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': CLIENT_UA,
    Origin: origin,
    Referer: origin + '/',
    'X-Product': 'SaaS',
  };
  if (cred.uid) h['X-User-Id'] = cred.uid;
  if (cred.enterpriseId) {
    h['X-Enterprise-Id'] = cred.enterpriseId;
    h['X-Tenant-Id'] = cred.enterpriseId;
  }
  if (cred.domain) h['X-Domain'] = cred.domain;
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const cred = credentialOf(obj);
  if (!cred.accessToken) return null;
  return cred;
}

/**
 * 从任意形状的凭证对象归一。
 *
 * 上游不同版本/站点用过 camelCase 与 snake_case 两套字段名，都要兼容：少一个 uid
 * 就会让 billing 接口缺 `X-User-Id` 头而报 400。
 */
function credentialOf(obj) {
  const accessToken = pickString(obj, ['accessToken', 'access_token']);
  return {
    accessToken,
    refreshToken: pickString(obj, ['refreshToken', 'refresh_token']),
    expiresAt: expiresAtOf(obj),
    domain: pickString(obj, ['domain']),
    uid: pickString(obj, ['uid', 'userId', 'user_id']) ||
      jwtClaim(accessToken, ['user_id', 'userId', 'uid', 'sub']),
    enterpriseId: pickString(obj, [
      'enterpriseId', 'enterprise_id', 'entId', 'tenantId', 'tenant_id',
    ]) || jwtClaim(accessToken, ['tenant_id', 'tenantId', 'enterprise_id', 'enterpriseId']),
    nickname: pickString(obj, ['nickname', 'nickName', 'name']),
  };
}

/**
 * 设备授权/刷新返回的是**相对的** expiresIn（秒），没有绝对时间戳。
 *
 * 不换算成绝对时间的话 expiresAt 恒为 0，「距过期还早就不刷」的判断失效，
 * 每个请求都会先做一次 token 刷新往返。
 */
function expiresAtOf(obj) {
  const abs = numOrNull(pick(obj, ['expiresAt', 'expires_at']));
  if (abs !== null && abs > 0) return abs;
  const rel = numOrNull(pick(obj, ['expiresIn', 'expires_in']));
  if (rel !== null && rel > 0) return Math.floor(Date.now() / 1000) + rel;
  return 0;
}

/** 从 JWT payload 里取第一个非空声明，取不到返回空串。 */
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
    // 不是 JWT 就走空串
  }
  return '';
}

/**
 * 区域判定。
 *
 * access_token 的 JWT `iss` 是权威依据——上游两个 realm（国内 codebuddy.cn / 国际
 * workbuddy.ai）就靠它区分；其次看凭证里的 `domain`；都没有时按国内处理（供应商默认）。
 */
function regionOf(cred) {
  const issuer = jwtClaim(cred && cred.accessToken, ['iss', 'issuer']).toLowerCase();
  if (issuer.indexOf('workbuddy.ai') >= 0 || issuer.indexOf('codebuddy.ai') >= 0) return REGION_GLOBAL;

  const domain = String((cred && cred.domain) || '').trim().toLowerCase();
  if (
    domain === REGION_GLOBAL ||
    domain === 'workbuddy.ai' || endsWith(domain, '.workbuddy.ai') ||
    domain === 'codebuddy.ai' || endsWith(domain, '.codebuddy.ai')
  ) {
    return REGION_GLOBAL;
  }
  return REGION_CN;
}

function endpointOf(region) {
  return region === REGION_GLOBAL ? GLOBAL_ENDPOINT : CN_ENDPOINT;
}

function endpointOfCred(cred) {
  return endpointOf(regionOf(cred));
}

function originFor(cred) {
  return endpointOfCred(cred).origin;
}

/** 构造账号记录；region 一并写进去，页面按区域展示。 */
function toAccount(cred) {
  const uid = cred.uid || 'codebuddy-' + hashShort(cred.accessToken);
  const secret = JSON.stringify({
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    domain: cred.domain,
    uid,
    enterpriseId: cred.enterpriseId,
    nickname: cred.nickname,
  });
  return makeAccount('codebuddy', String(uid), cred.nickname, secret, {
    region: regionOf(cred),
  });
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const model = String(requested || '').trim();
  // 模型列表首位会随上游变化，不能拿它当默认；官方默认是 name=Auto（id=default-model）。
  if (!model || model === 'auto') return DEFAULT_MODEL;
  return model;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const ep = endpointOfCred(cred);
  const url = ep.chatBase + ep.modelsPath;

  let res;
  try {
    res = await http.get(url, modelsHeaders(cred), MODELS_TIMEOUT);
  } catch (e) {
    throw new Error(`模型接口请求失败（${ep.label} ${url}）：${e.message}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型接口（${ep.label} ${url}）HTTP ${res.status}${describeBody(res.text)}`);
  }
  const obj = safeJson(res.text);
  if (!obj) throw new Error('模型响应不是合法 JSON：' + String(res.text || '').trim().slice(0, 160));
  if (Number(obj.code) !== 0) throw new Error('模型接口 code=' + obj.code + describeBody(res.text));
  if (!isPlainObject(obj.data)) return [];
  return parseModelsCatalog(obj.data);
}

/**
 * 从目录响应解析模型清单。
 *
 * `data.models[]` 是模型定义，`data.agents[name=cli].models` 是 CLI 可用的白名单——
 * 白名单存在时以它为准，否则会把网页端才能用、CLI 一发就报错的模型列给用户。
 */
function parseModelsCatalog(data) {
  const cliIds = new Set();
  const agents = Array.isArray(data.agents) ? data.agents : [];
  for (const agent of agents) {
    if (!isPlainObject(agent) || agent.name !== 'cli') continue;
    if (!Array.isArray(agent.models)) continue;
    for (const id of agent.models) cliIds.add(String(id));
  }

  const out = [];
  const seen = new Set();
  const models = Array.isArray(data.models) ? data.models : [];
  for (const item of models) {
    if (!isPlainObject(item)) continue;
    const id = String(item.id || '');
    if (!id || seen.has(id)) continue;
    if (cliIds.size > 0 && !cliIds.has(id)) continue;
    if (item.disabled === true) continue;
    seen.add(id);

    const maxInput = numOrNull(item.maxInputTokens);
    const model = {
      id,
      name: String(item.name || id),
      contextWindow: maxInput !== null && maxInput > 0 ? maxInput : 0,
      supportsTools: item.supportsToolCall === true,
      supportsReasoning: item.supportsReasoning === true,
    };
    // 以下只供页面展示：上游给的是 "x0.79 credits" 这种串，抽数值当倍率
    const rate = parseCredits(item.credits);
    if (rate) model.rate = rate;
    const maxOutput = numOrNull(item.maxOutputTokens);
    if (maxOutput !== null && maxOutput > 0) model.maxOutput = maxOutput;
    if (item.supportsImages === true) model.vision = true;
    if (item.vendor) model.vendor = String(item.vendor);
    out.push(model);
  }
  return out;
}

/** 解析 `"x0.79 credits"` 这类串；不合法返回空串。 */
function parseCredits(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  const token = text.replace(/^[xX]/, '').trim().split(' ')[0] || '';
  const value = Number(token);
  if (!Number.isFinite(value) || value < 0) return '';
  return String(value);
}

// ── 请求体归一 ────────────────────────────────────────────────

/**
 * 改写发往 CodeBuddy 的请求体。
 *
 * 1. 强制 `stream:true`（上游拒绝非流式）；
 * 2. `tool_choice` 归一化成字符串（上游该字段是 string，对象形式会 400）；
 * 3. 消息形状对齐上游（首条必须 system、`developer` 改叫 `system`）；
 * 4. `max_completion_tokens` → `max_tokens`；
 * 5. 工具 schema 归一 + 工具名合法化（不做时国际版直接回 400 11133）。
 *
 * 返回「改写后的工具名 → 原名」的表，供响应侧还原。
 */
function prepareBody(srcText, stripTrace) {
  const obj = safeJson(srcText);
  if (!isPlainObject(obj)) return { body: srcText, toolNameRestore: {} };
  obj.stream = true;
  normalizeToolChoice(obj);
  normalizeMessages(obj);
  normalizeMaxTokens(obj);
  if (stripTrace) unflagMessages(obj);
  const restore = normalizeTools(obj);
  return { body: JSON.stringify(obj), toolNameRestore: restore };
}

function normalizeToolChoice(obj) {
  const choice = obj.tool_choice;
  if (choice === undefined || choice === null) return;

  if (typeof choice !== 'object') {
    const text = String(choice).toLowerCase();
    if (text === 'none') {
      dropTools(obj);
      return;
    }
    // 指向具体工具时必须跟着工具改名，否则上游按原名找不到工具直接 400
    obj.tool_choice = sanitizeToolName(choice);
    return;
  }

  const type = String(choice.type || '').toLowerCase();
  if (type === 'none') {
    dropTools(obj);
    return;
  }
  if (type === 'auto' || type === 'required') {
    obj.tool_choice = type;
    return;
  }
  if (type === 'function') {
    const name = isPlainObject(choice.function) ? String(choice.function.name || '') : '';
    obj.tool_choice = name ? sanitizeToolName(name) : 'auto';
    return;
  }
  delete obj.tool_choice;
}

function dropTools(obj) {
  delete obj.tool_choice;
  delete obj.tools;
  delete obj.functions;
}

/**
 * 消息形状归一。
 *
 * 上游把「首条消息不是 system」当错误拒绝（400 code=11128），所以缺就补一条；
 * 另外 `tool` 结果之后紧跟 `user` 会被判「会话必须以 user 结尾」（11153），
 * 中间插一条空 assistant 即可通过。
 */
function normalizeMessages(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages) return;

  for (const message of messages) {
    if (isPlainObject(message) && message.role === 'developer') message.role = 'system';
  }

  const rebuilt = [];
  let prevRole = '';
  for (const message of messages) {
    const role = isPlainObject(message) ? String(message.role || '') : '';
    if (prevRole === 'tool' && role === 'user') {
      rebuilt.push({ role: 'assistant', content: '' });
    }
    rebuilt.push(message);
    prevRole = role;
  }
  obj.messages = rebuilt;

  const first = rebuilt[0];
  if (isPlainObject(first) && first.role === 'system') return;
  obj.messages = [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }].concat(rebuilt);
}

/** 上游不认 `max_completion_tokens`（新版 OpenAI 客户端会发它），只认 `max_tokens`。 */
function normalizeMaxTokens(obj) {
  if (obj.max_completion_tokens === undefined) return;
  const legacy = obj.max_completion_tokens;
  delete obj.max_completion_tokens;
  if (obj.max_tokens === undefined) obj.max_tokens = legacy;
}

/** 工具形状归一；返回「改写后名字 → 原名」。 */
function normalizeTools(obj) {
  const tools = Array.isArray(obj.tools) ? obj.tools : null;
  if (!tools) return {};
  const restore = {};
  for (const tool of tools) {
    if (!isPlainObject(tool) || !isPlainObject(tool.function)) continue;
    const fn = tool.function;
    if (typeof fn.name === 'string') {
      const original = fn.name;
      const sanitized = sanitizeToolName(original);
      if (sanitized !== original) {
        fn.name = sanitized;
        if (!restore[sanitized]) restore[sanitized] = original;
      }
    }
    if (fn.parameters !== undefined) fn.parameters = normalizeToolParameters(fn.parameters);
  }
  return restore;
}

/**
 * 上游会以「Illegal API invocation from an unapproved channel」拦下带第三方 CLI 特征文本的
 * 请求（Claude Code / Codex CLI 的系统提示词片段），按等义写法替换即可通过。
 */
const FLAGGED_TEXT = [
  { re: /x-anthropic-billing-header:[^\n]*\n?/gi, to: '' },
  {
    re: /You are Claude Code, Anthropic['’]s official CLI for Claude/gi,
    to: "You are Claude Code, Anthropic's CLI for Claude",
  },
  {
    re: /Main branch \(you will usually use this for PRs\)/gi,
    to: 'Main branch (usually the base for PRs)',
  },
  {
    re: /(?<!the )Codex CLI is an open source project led by OpenAI\./gi,
    to: 'The Codex CLI is an open source project led by OpenAI.',
  },
];

function unflagText(text) {
  let out = String(text || '');
  for (const rule of FLAGGED_TEXT) out = out.replace(rule.re, rule.to);
  return out;
}

function unflagMessages(obj) {
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages) return;
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      message.content = unflagText(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isPlainObject(part)) continue;
      if (typeof part.text === 'string') part.text = unflagText(part.text);
    }
  }
}

/** 工具名合法字符是字母、数字、`_`、`-`；其余（`.`/`:`/`/`/CJK）换成 `_`。 */
function sanitizeToolName(name) {
  let out = '';
  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    const legal = ch === '_' || ch === '-' || (code < 128 && /[A-Za-z0-9]/.test(ch));
    out += legal ? ch : '_';
  }
  return out;
}

// ── 工具 schema 归一 ──────────────────────────────────────────

const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'object', 'array', 'boolean', 'null'];
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs'];
const SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf'];

/**
 * 把工具 schema 归一到上游能接受的形状。
 *
 * 规则逐条来自官方渠道的实测记录（magpie 插件的 workbuddy README）：
 * 根级缺 type / 是联合 → 当对象并合并分支；元组式 items →「任一满足」；无 type 的 enum
 * 按取值类型补 type（多类型则拆 anyOf）；schema 位置的布尔换成空 schema / not；
 * `type` 不是 JSON Schema 认得的名字就去掉。只递归已知的 schema 容器，其余关键字原样保留
 * ——它们不是 schema，误改会引入新问题。
 */
function normalizeToolParameters(parameters) {
  if (!isPlainObject(parameters)) return parameters;
  return normalizeRoot(parameters);
}

function normalizeRoot(src) {
  const branches = [src];
  for (const key of SCHEMA_LIST_KEYS) {
    const list = src[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isPlainObject(item)) branches.push(item);
  }

  const declared = normalizedType(src);
  if (typeof declared === 'string') {
    if (declared === 'object' && branches.length === 1) return normalizeSchemaObject(src);
    if (declared !== 'object') return normalizeSchemaObject(src);
  }

  const out = { type: 'object' };
  const properties = {};
  const required = [];
  for (const branch of branches) {
    if (isPlainObject(branch.properties)) {
      for (const name of Object.keys(branch.properties)) {
        properties[name] = normalizeSchema(branch.properties[name]);
      }
    }
    if (!Array.isArray(branch.required)) continue;
    for (const item of branch.required) {
      if (typeof item !== 'string') continue;
      if (required.indexOf(item) < 0) required.push(item);
    }
  }
  if (Object.keys(properties).length > 0) out.properties = properties;
  if (required.length > 0) out.required = required;
  for (const key of Object.keys(src)) {
    if (key === 'properties' || key === 'required') continue;
    if (SCHEMA_LIST_KEYS.indexOf(key) >= 0) continue;
    out[key] = src[key];
  }
  return out;
}

function normalizeSchemaObject(src) {
  const out = {};
  const type = normalizedType(src);
  if (type !== null) out.type = type;

  if (Array.isArray(src.required)) {
    const names = src.required.filter((item) => typeof item === 'string');
    if (names.length > 0) out.required = names;
  }

  // JSON 里写不出裸的 \0；上游引擎认的是转义后的 \u0000
  if (typeof src.pattern === 'string') out.pattern = src.pattern.replace(/\\0/g, '\\u0000');

  if (src.items !== undefined) out.items = normalizeItems(src.items);

  for (const key of SCHEMA_MAP_KEYS) {
    if (!isPlainObject(src[key])) continue;
    const children = {};
    for (const name of Object.keys(src[key])) children[name] = normalizeSchema(src[key][name]);
    out[key] = children;
  }

  for (const key of SCHEMA_LIST_KEYS) {
    if (!Array.isArray(src[key])) continue;
    out[key] = src[key].map(normalizeSchema);
  }

  normalizeEnum(src, out);

  const handled = ['type', 'required', 'pattern', 'items', 'enum']
    .concat(SCHEMA_MAP_KEYS, SCHEMA_LIST_KEYS);
  for (const key of Object.keys(src)) {
    if (handled.indexOf(key) >= 0) continue;
    out[key] = src[key];
  }
  return out;
}

/** 元组式 `items`（数组）→「任一满足」的单个 schema。 */
function normalizeItems(items) {
  if (Array.isArray(items)) return { anyOf: items.map(normalizeSchema) };
  return normalizeSchema(items);
}

/** schema 位置上的布尔：`true` 任何都满足、`false` 任何都不满足。 */
function normalizeSchema(node) {
  if (node === true) return {};
  if (node === false) return { not: {} };
  if (!isPlainObject(node)) return node;
  return normalizeSchemaObject(node);
}

function normalizeEnum(src, out) {
  const values = src.enum;
  if (!Array.isArray(values) || values.length === 0) return;
  if (normalizedType(src) !== null) {
    out.enum = values;
    return;
  }

  const groups = new Map();
  for (const value of values) {
    const type = jsonTypeOf(value);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(value);
  }
  const nonNull = [];
  for (const key of groups.keys()) if (key !== 'null') nonNull.push(key);

  if (nonNull.length === 0) {
    out.enum = values;
    return;
  }
  if (nonNull.length === 1 && groups.size === 1) {
    out.type = nonNull[0];
    out.enum = values;
    return;
  }
  if (nonNull.length === 1) {
    out.type = [nonNull[0], 'null'];
    out.enum = values;
    return;
  }
  const anyOf = [];
  for (const entry of groups) anyOf.push({ type: entry[0], enum: entry[1] });
  out.anyOf = anyOf;
}

function normalizedType(src) {
  const raw = src.type;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const type = raw.toLowerCase();
    return JSON_SCHEMA_TYPES.indexOf(type) >= 0 ? type : null;
  }
  if (!Array.isArray(raw)) return null;
  const kept = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const type = item.toLowerCase();
    if (JSON_SCHEMA_TYPES.indexOf(type) >= 0) kept.push(type);
  }
  return kept.length > 0 ? kept : null;
}

function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 发起对话，逐行回调上游 SSE。
 *
 * 请求侧改写了工具名，响应侧必须换回原名，否则客户端按名字找不到自己的工具——
 * 还原在喂给调用方之前完成，帧边界保持不变。
 *
 * @returns {Promise<{status:number, headers:object, model:string, error?:object}>}
 */
async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) {
    return { status: 401, headers: {}, model: '', error: { status: 401, message: '凭证无法解析' } };
  }

  let src;
  try {
    src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  } catch (e) {
    return { status: 400, headers: {}, model: '', error: { status: 400, message: '请求体不是合法 JSON' } };
  }

  const model = resolveModel(src && src.model);
  const prepared = prepareBody(JSON.stringify(src || {}), stripTraceEnabled());
  const restore = prepared.toolNameRestore;
  // 上游按请求体里的 model 路由，为空会回 11102「model service info not found」
  let body = prepared.body;
  const parsed = safeJson(body);
  if (isPlainObject(parsed)) {
    parsed.model = model;
    body = JSON.stringify(parsed);
  }

  const ep = endpointOfCred(cred);
  const url = ep.chatBase + PATH_CHAT;
  const headers = chatHeaders(cred, body);

  const splitter = sse.createLineSplitter((line) => onLine(restoreLine(line, restore)));

  // status 要到响应头到达才确定，而数据块可能先到；先缓冲，判定后再分流
  let decided = false;
  let ok = false;
  let isSse = false;
  const early = [];
  const textChunks = [];
  const errorChunks = [];

  const onData = (chunk) => {
    if (!decided) {
      early.push(chunk);
      return;
    }
    if (!ok) {
      errorChunks.push(chunk);
      return;
    }
    if (isSse) splitter(chunk);
    else textChunks.push(chunk);
  };

  let res;
  try {
    res = await http.stream({ url, headers, body, timeout: CHAT_TIMEOUT }, onData);
  } catch (e) {
    return { status: 0, headers: {}, model, error: { status: 0, message: e.message || '连接失败' } };
  }

  // 等流真的读完：非流式聚合与非 SSE 错误体都要完整正文
  if (res.done) await res.done;

  decided = true;
  ok = res.status >= 200 && res.status < 300;
  isSse = String(res.headers['content-type'] || '').toLowerCase().indexOf('event-stream') >= 0;
  for (const chunk of early) {
    if (!ok) {
      errorChunks.push(chunk);
    } else if (isSse) {
      splitter(chunk);
    } else {
      textChunks.push(chunk);
    }
  }

  if (!ok) {
    const message = describeBody(Buffer.concat(errorChunks).toString('utf8'));
    // 401/403 是凭证失效：映射成 401，网关才会禁用账号并换家
    const status = res.status === 401 || res.status === 403 ? 401 : res.status;
    return {
      status: res.status,
      headers: res.headers,
      model,
      error: { status, message: message ? message.replace(/^：/, '') : '上游 HTTP ' + res.status },
    };
  }

  if (isSse) return { status: res.status, headers: res.headers, model };

  // 已强制 stream:true，正常不会走到这里。真遇到非流式响应时按一次性 completion 转成
  // SSE 帧；若是业务错误（HTTP 200 + code≠0）则把它当失败报出来，不假装成功。
  const text = Buffer.concat(textChunks).toString('utf8');
  const obj = safeJson(text);
  const code = obj ? Number(obj.code) : NaN;
  if (obj && Number.isFinite(code) && code !== 0) {
    const message = extractMessage(text);
    return {
      status: res.status,
      headers: res.headers,
      model,
      error: { status: 502, message: message || '上游业务错误 code=' + code },
    };
  }
  if (obj && Array.isArray(obj.choices) && obj.choices.length > 0) {
    emitAggregated(obj, model, onLine);
    return { status: res.status, headers: res.headers, model };
  }
  return {
    status: res.status,
    headers: res.headers,
    model,
    error: { status: 502, message: '上游返回了非流式响应：' + (text.trim().slice(0, 200) || '（空）') },
  };
}

/** 把一次性 completion 转成 OpenAI SSE 帧，交回调用方。 */
function emitAggregated(obj, model, onLine) {
  const choice = obj.choices[0] || {};
  const message = isPlainObject(choice.message) ? choice.message : {};
  const delta = { role: 'assistant' };
  if (typeof message.content === 'string' && message.content) delta.content = message.content;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    delta.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      index,
      id: call && call.id ? call.id : undefined,
      type: 'function',
      function: {
        name: call && call.function ? String(call.function.name || '') : '',
        arguments: call && call.function ? String(call.function.arguments || '') : '',
      },
    }));
  }
  onLine('data: ' + JSON.stringify({
    id: obj.id || undefined,
    object: 'chat.completion.chunk',
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? 'tool_calls'
        : (choice.finish_reason || 'stop'),
    }],
  }));
  onLine('data: [DONE]');
}

/** 只改 `data:` 行里的工具名，行数与分隔结构不变，因此不改变 SSE 帧边界。 */
function restoreLine(line, restore) {
  if (!restore || Object.keys(restore).length === 0) return line;
  const trimmed = String(line || '').trim();
  if (trimmed.indexOf('data:') !== 0) return line;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  const obj = safeJson(payload);
  if (!isPlainObject(obj)) return line;
  if (!rewriteToolCallNames(obj, restore)) return line;
  return 'data: ' + JSON.stringify(obj);
}

function rewriteToolCallNames(obj, restore) {
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  let changed = false;
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    for (const key of ['message', 'delta']) {
      const container = choice[key];
      if (!isPlainObject(container) || !Array.isArray(container.tool_calls)) continue;
      for (const call of container.tool_calls) {
        if (!isPlainObject(call) || !isPlainObject(call.function)) continue;
        const name = call.function.name;
        if (typeof name !== 'string') continue;
        if (!restore[name]) continue;
        call.function.name = restore[name];
        changed = true;
      }
    }
  }
  return changed;
}

/** 去客户端指纹开关；读不到配置时按关闭处理。 */
function stripTraceEnabled() {
  try {
    const cfg = require('../lib/config').read();
    return cfg && cfg.stripClientTrace === true;
  } catch (e) {
    return false;
  }
}

// ── 积分 ──────────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const ep = endpointOfCred(cred);
  const url = ep.billingBase + PATH_USER_RESOURCE;

  const res = await http.postJson(url, userResourceBody(), billingHeaders(cred), API_TIMEOUT);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`额度接口（${ep.label} ${url}）HTTP ${res.status}${describeBody(res.text)}`);
  }
  const data = envelopeData(res.text);
  if (!data) throw new Error('响应缺少 data');
  const accounts = accountsOf(data);
  if (!accounts) throw new Error('响应缺少 Response.Data.Accounts');

  let remain = 0;
  let fieldSeen = false;
  for (const item of accounts) {
    if (!isPlainObject(item)) continue;
    const size = numOrNull(item.CycleCapacitySize);
    const cycleRemain = numOrNull(item.CycleCapacityRemain);
    const capacityRemain = numOrNull(item.CapacityRemain);
    // 字段缺失（结构改口径）不能当成「额度就是 0」，三键全缺时视为解析不了
    if (size === null && cycleRemain === null && capacityRemain === null) continue;
    fieldSeen = true;
    const value = (size || 0) > 0 || (cycleRemain || 0) > 0 ? (cycleRemain || 0) : (capacityRemain || 0);
    if (value > 0) remain += value;
  }
  if (!fieldSeen) throw new Error('响应里没有可识别的额度字段');

  return { credit: remain, creditText: String(remain) };
}

/** 额度包明细（周期额度 / 容量包），只做展示。 */
async function creditPacks(account) {
  const cred = parse(account);
  if (!cred) return [];
  const ep = endpointOfCred(cred);
  const res = await http.postJson(
    ep.billingBase + PATH_USER_RESOURCE,
    userResourceBody(),
    billingHeaders(cred),
    API_TIMEOUT,
  );
  if (res.status < 200 || res.status >= 300) return [];
  const data = envelopeData(res.text);
  if (!data) return [];
  const accounts = accountsOf(data);
  if (!accounts) return [];

  const packs = [];
  for (const item of accounts) {
    if (!isPlainObject(item)) continue;
    const cycleSize = numOrNull(item.CycleCapacitySize) || 0;
    packs.push({
      name: String(item.PackageName || '额度包'),
      group: cycleSize > 0 ? '周期额度' : '容量包',
      limit: cycleSize > 0 ? cycleSize : (numOrNull(item.CapacitySize) || 0),
      used: cycleSize > 0 ? (numOrNull(item.CycleCapacityUsed) || 0) : (numOrNull(item.CapacityUsed) || 0),
      remain: cycleSize > 0 ? (numOrNull(item.CycleCapacityRemain) || 0) : (numOrNull(item.CapacityRemain) || 0),
    });
  }
  return packs;
}

function userResourceBody() {
  const now = Date.now();
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatDateTime(new Date(now)),
    PackageEndTimeRangeEnd: formatDateTime(new Date(now + 101 * 365 * 24 * 3600 * 1000)),
  };
}

function accountsOf(data) {
  const response = isPlainObject(data.Response) ? data.Response : null;
  if (!response) return null;
  const payload = isPlainObject(response.Data) ? response.Data : null;
  if (!payload) return null;
  return Array.isArray(payload.Accounts) ? payload.Accounts : null;
}

// ── 签到 ──────────────────────────────────────────────────────

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  const region = regionOf(cred);
  // 国际版没有签到制度、企业账号没有个人成长体系：跳过而不是算失败，否则统计被拉低
  if (region === REGION_GLOBAL) return { ok: true, skipped: true, message: '国际版没有签到制度，已跳过' };
  if (cred.enterpriseId) return { ok: true, skipped: true, message: '企业账号没有个人签到，已跳过' };

  const ep = endpointOf(region);
  const url = ep.billingBase + PATH_CHECKIN;
  try {
    const res = await http.postJson(url, {}, billingHeaders(cred), API_TIMEOUT);
    const message = extractMessage(res.text);
    // 「今天已签到」上游用 HTTP 400 返回，但它属于正常状态，必须先于状态码判断
    if (/已签到|已经签到|already/i.test(message)) return { ok: true, message: '今日已签到' };
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        message: `签到（${ep.label} ${url}）HTTP ${res.status}` + describeBody(res.text),
      };
    }
    const obj = safeJson(res.text);
    const code = obj ? Number(obj.code) : NaN;
    if (code === 0) return { ok: true, message: '签到成功' };
    return { ok: false, message: message || '签到失败（code=' + code + '）' };
  } catch (e) {
    return { ok: false, message: e.message || '签到失败' };
  }
}

// ── 任务中心 ──────────────────────────────────────────────────

/**
 * 成长任务明细：只读，不触发任何领取动作。
 * 国际版没有成长中心；企业账号没有个人成长体系（上游回 403/10001），都不发请求。
 */
async function taskList(account) {
  const cred = parse(account);
  if (!cred) return { tasks: [], error: '凭证无法解析' };
  const region = regionOf(cred);
  if (region === REGION_GLOBAL) return { tasks: [], error: '国际版没有成长任务' };
  if (cred.enterpriseId) return { tasks: [], error: '企业账号无个人成长任务' };

  const ep = endpointOf(region);
  const url = ep.chatBase + PATH_GROWTH + '/tasks';
  try {
    const res = await http.get(url, billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) {
      return {
        tasks: [],
        error: `成长中心（${ep.label} ${url}）HTTP ${res.status}` + describeBody(res.text),
      };
    }
    const obj = safeJson(res.text);
    if (!isPlainObject(obj)) return { tasks: [], error: '响应不是合法 JSON' };

    const inPeriod = obj.in_period === true;
    const arr = Array.isArray(obj.tasks) ? obj.tasks : null;
    if (!arr) return { tasks: [], inPeriod, error: '' };

    const tasks = [];
    for (const raw of arr) {
      if (!isPlainObject(raw)) continue;
      const code = pickString(raw, ['task_code']);
      if (!code) continue;

      // 进度既可能在顶层，也可能藏在 progress 对象里，后者优先
      let current = pickNumber(raw, ['current']);
      let target = pickNumber(raw, ['target']);
      const progress = isPlainObject(raw.progress) ? raw.progress : null;
      if (progress) {
        const pc = pickNumber(progress, ['current']);
        const pt = pickNumber(progress, ['target']);
        const pcv = pc === null ? 0 : pc;
        const ptv = pt === null ? 0 : pt;
        if (ptv > 0 || pcv > 0) {
          current = pcv;
          target = ptv;
        }
      }
      const acceptStatus = pickString(raw, ['accept_status']);
      const reward = pickNumber(raw, ['reward_credit']);

      tasks.push({
        code,
        title: pickString(raw, ['title']) || code,
        description: pickString(raw, ['description']),
        current: current === null ? 0 : current,
        target: target === null ? 0 : target,
        status: acceptStatus,
        locked: raw.locked === true,
        claimed: acceptStatus === 'claimed',
        rewardCredit: reward === null ? 0 : reward,
      });
    }
    return { tasks, inPeriod, error: '' };
  } catch (e) {
    return { tasks: [], error: e.message || '拉取任务列表失败' };
  }
}

/**
 * 成长中心一键领取。
 *
 * 顺序按官方客户端的行为链：签到日历 → 新手礼包/补偿 → 领养 Buddy → 连登档位兑奖 →
 * 抽奖 → 领旅行礼物/派 Buddy 出发 → 领任务 → 开盲盒 → 开学季。
 * 各步单独容错：某一步的业务拒绝（活动未开、无配额、条件未达）不该让其它步失败。
 */
async function runTasks(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  const region = regionOf(cred);
  if (region === REGION_GLOBAL) return { ok: true, skipped: true, message: '国际版没有成长中心，已跳过' };
  if (cred.enterpriseId) return { ok: true, skipped: true, message: '企业账号无个人成长任务，已跳过' };

  const ep = endpointOf(region);
  const parts = [];
  await claimGiftAndCompensation(ep, cred, parts);
  await adoptBuddy(ep, cred, parts);
  await redeemStreak(ep, cred, parts);
  await drawLottery(ep, cred, parts);
  await claimTravel(ep, cred, parts);
  await claimTasks(ep, cred, parts);
  await openBlindBox(ep, cred, parts);
  await claimSchoolSeason(ep, cred, parts);

  return {
    ok: true,
    message: parts.length > 0 ? parts.join('；') : '成长中心没有可领取的内容',
    actions: parts,
  };
}

/** 新手礼包与补偿：两个独立的一次性领取，各自容错。 */
async function claimGiftAndCompensation(ep, cred, parts) {
  const items = [
    { path: '/billing/meter/claim-gift', label: '新手礼包' },
    { path: '/billing/meter/claim-compensation', label: '补偿' },
  ];
  for (const item of items) {
    try {
      const res = await http.postJson(ep.chatBase + item.path, {}, billingHeaders(cred), API_TIMEOUT);
      if (res.status < 200 || res.status >= 300) continue;
      const credit = pickNumber(safeJson(res.text), ['credit', 'reward_credit', 'amount']);
      if (credit !== null) parts.push(item.label + ' +' + credit);
    } catch (e) {
      // 单步失败不影响其它步骤
    }
  }
}

/**
 * 领养 Buddy：先报「完成任务」，再同意协议，最后触发领养。
 * 三步有先后依赖，任一步失败就停（上游会以 `first_buddy task not completed yet` 拒绝）。
 * 注意这几条路径**没有 /v2 前缀**（与其它成长接口不同）。
 */
async function adoptBuddy(ep, cred, parts) {
  try {
    const root = ep.chatBase;
    const info = await http.get(root + PATH_GROWTH + '/buddy/info', billingHeaders(cred), API_TIMEOUT);
    if (info.status < 200 || info.status >= 300) return;
    const obj = safeJson(info.text);
    if (!obj) return;
    let buddy = isPlainObject(obj.buddy) ? obj.buddy : null;
    if (!buddy && isPlainObject(obj.data) && isPlainObject(obj.data.buddy)) buddy = obj.data.buddy;
    if (buddy && Object.keys(buddy).length > 0) return;

    await http.postJson(root + '/activity/growth/buddy/agreement', { agree: true }, billingHeaders(cred), API_TIMEOUT);
    const first = await http.postJson(root + '/activity/growth/buddy/first', {}, billingHeaders(cred), API_TIMEOUT);
    if (first.status < 200 || first.status >= 300) return;
    const credit = pickNumber(safeJson(first.text), ['credit', 'reward_credit']);
    parts.push(credit !== null ? '领养 Buddy +' + credit : '领养 Buddy');
  } catch (e) {
    // 忽略单步失败
  }
}

/**
 * 连登档位兑奖：只处理明确可领的档位。
 * 已领过（claimed/redeemed）与未达标都要跳过；每次请求带一个全新的小写 UUIDv4 作幂等键。
 */
async function redeemStreak(ep, cred, parts) {
  try {
    const root = ep.chatBase;
    const res = await http.get(root + '/activity/growth/streak', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const obj = safeJson(res.text);
    if (!obj) return;
    let entitle = isPlainObject(obj.redemption_status) ? obj.redemption_status : null;
    if (!entitle && isPlainObject(obj.data) && isPlainObject(obj.data.redemption_status)) {
      entitle = obj.data.redemption_status;
    }
    if (!entitle) return;

    for (const tier of ['7d', '14d', '28d']) {
      const state = String(entitle['tier_' + tier + '_status'] || '').toLowerCase();
      if (!state || state === 'claimed' || state === 'redeemed' || state === 'false') continue;
      if (state !== 'true' && state !== 'available' && state !== 'claimable') continue;
      const res2 = await http.postJson(
        root + '/activity/growth/redeem',
        { tier, client_token: uuid4() },
        billingHeaders(cred),
        API_TIMEOUT,
      );
      if (res2.status >= 200 && res2.status < 300) parts.push('连登 ' + tier + ' 兑奖');
    }
  } catch (e) {
    // 忽略单步失败
  }
}

/** 抽奖：先查次数，有剩余就抽（每次全新 client_token）。 */
async function drawLottery(ep, cred, parts) {
  try {
    const root = ep.chatBase;
    const res = await http.get(root + '/activity/growth/lottery/summary', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const chances = pickNumber(safeJson(res.text), ['chances', 'chance', 'count']);
    if (chances === null || chances <= 0) return;

    const draws = Math.min(Math.floor(chances), MAX_LOTTERY_DRAWS);
    for (let i = 0; i < draws; i++) {
      const res2 = await http.postJson(
        root + '/activity/growth/lottery/draw',
        { client_token: uuid4() },
        billingHeaders(cred),
        API_TIMEOUT,
      );
      if (res2.status < 200 || res2.status >= 300) continue;
      const prize = pickString(safeJson(res2.text), ['prize_code']);
      parts.push(prize ? '抽奖 ' + prize : '抽奖');
    }
  } catch (e) {
    // 忽略单步失败
  }
}

/** 旅行：已到达先领礼物，空闲且未达日限则派 Buddy 出发。 */
async function claimTravel(ep, cred, parts) {
  try {
    const base = ep.chatBase + PATH_GROWTH;
    const res = await http.get(base + '/buddy/travel/status', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const obj = safeJson(res.text);
    if (!obj) return;

    const state = pickString(obj, ['state']);
    const dailyLimit = obj.daily_limit_reached === true;

    if (state === 'arrived') {
      const recordId = pickString(obj, ['record_id']);
      if (!recordId) return;
      const res2 = await http.postJson(
        base + '/buddy/travel/claim',
        { record_id: recordId },
        billingHeaders(cred),
        API_TIMEOUT,
      );
      if (res2.status < 200 || res2.status >= 300) return;
      const credit = pickNumber(safeJson(res2.text), ['reward_credit']);
      parts.push(credit !== null && credit > 0 ? '旅行礼物 +' + credit : '已领旅行礼物');
      return;
    }

    if (state !== 'idle' || dailyLimit) return;
    const cfg = await http.get(base + '/buddy/travel/config', billingHeaders(cred), API_TIMEOUT);
    if (cfg.status < 200 || cfg.status >= 300) return;
    const cfgObj = safeJson(cfg.text);
    const locations = cfgObj && Array.isArray(cfgObj.locations) ? cfgObj.locations : null;
    if (!locations || locations.length === 0) return;
    if (!isPlainObject(locations[0])) return;
    const locationId = pickString(locations[0], ['id']);
    if (!locationId) return;

    const res3 = await http.postJson(
      base + '/buddy/travel/depart',
      { location_id: locationId },
      billingHeaders(cred),
      API_TIMEOUT,
    );
    if (res3.status < 200 || res3.status >= 300) return;
    const body = safeJson(res3.text);
    const name = body && isPlainObject(body.location) ? pickString(body.location, ['name']) : '';
    parts.push(name ? '派 Buddy 去' + name : '已派 Buddy 出发');
  } catch (e) {
    // 忽略单步失败
  }
}

/**
 * 任务：未领取的先接单（进度从接单那刻才开始计），已接单且达标的领奖。
 * 已接单但没做完的跳过——无法代做，重复提交只会被上游拒。
 */
async function claimTasks(ep, cred, parts) {
  try {
    const base = ep.chatBase + PATH_GROWTH;
    const res = await http.get(base + '/tasks', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const obj = safeJson(res.text);
    const tasks = obj && Array.isArray(obj.tasks) ? obj.tasks : null;
    if (!tasks) return;

    for (const task of tasks) {
      if (!isPlainObject(task)) continue;
      if (task.locked === true) continue;
      const acceptStatus = pickString(task, ['accept_status']);
      if (acceptStatus === 'claimed') continue;

      const progress = isPlainObject(task.progress) ? task.progress : null;
      let target = progress ? pickNumber(progress, ['target']) : null;
      if (target === null || target <= 0) target = 1;
      let current = progress ? pickNumber(progress, ['current']) : null;
      if (current === null) current = 0;

      const done = current >= target;
      if (!done && acceptStatus) continue;
      const claiming = done && !!acceptStatus;

      const taskCode = pickString(task, ['task_code']);
      if (!taskCode) continue;
      const title = pickString(task, ['title']) || taskCode;

      if (claiming) {
        const credit = await claimGrowthTask(cred, ep, taskCode);
        if (credit >= 0) {
          parts.push(credit > 0 ? '领任务奖「' + title + '」+' + credit : '领任务奖「' + title + '」');
        }
        continue;
      }

      const acc = await http.postJson(base + '/tasks/accept', { task_code: taskCode }, billingHeaders(cred), API_TIMEOUT);
      if (acc.status < 200 || acc.status >= 300) continue;
      const credit = pickNumber(safeJson(acc.text), ['credit']);
      const gained = credit === null ? 0 : credit;
      parts.push(gained > 0 ? '领任务奖「' + title + '」+' + gained : '领取任务「' + title + '」');
    }
  } catch (e) {
    // 忽略单步失败
  }
}

/**
 * 领成长任务奖励。返回本次到账积分（0 = 领了但没给数字），-1 表示调用失败。
 *
 * 与接单不同：这个端点只存在于 Web 域，且必须伪装成官方 Web 客户端
 * （Origin/Referer + `x-client-platform: web`），否则领不到。
 * 路径同时试 `/v2/activity/...` 与无 `/v2` 两种——上游两套链路都在用，
 * 任务码在路径里、body 为空。
 */
async function claimGrowthTask(cred, ep, taskCode) {
  const headers = Object.assign({}, billingHeaders(cred), {
    Origin: ep.origin,
    Referer: ep.origin + '/profile/growth-center',
    'x-client-platform': 'web',
    Accept: 'application/json, text/plain, */*',
  });
  const code = encodeURIComponent(taskCode);
  const urls = [
    ep.origin + '/v2/activity/growth/tasks/' + code + '/claim',
    ep.origin + '/activity/growth/tasks/' + code + '/claim',
  ];
  for (const url of urls) {
    try {
      const res = await http.request({ method: 'POST', url, headers, timeout: API_TIMEOUT });
      if (res.status < 200 || res.status >= 300) continue;
      const obj = safeJson(res.text);
      // HTTP 200 也可能是业务拒绝（活动未开/无配额），换个路径再试
      if (isPlainObject(obj) && obj.code !== undefined && Number(obj.code) !== 0) continue;
      const credit = pickNumber(obj, ['credit']);
      return credit === null ? 0 : credit;
    } catch (e) {
      // 换下一条路径
    }
  }
  return -1;
}

/** 盲盒：有配额才开。 */
async function openBlindBox(ep, cred, parts) {
  try {
    const base = ep.chatBase + PATH_GROWTH;
    const res = await http.get(base + '/buddy/quota', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const remain = pickNumber(safeJson(res.text), ['remaining', 'quota', 'count', 'balance', 'left']);
    if (remain === null || remain <= 0) return;

    const res2 = await http.postJson(base + '/buddy/open', {}, billingHeaders(cred), API_TIMEOUT);
    if (res2.status < 200 || res2.status >= 300) return;
    const credit = pickNumber(safeJson(res2.text), ['credit', 'reward_credit']);
    parts.push(credit !== null && credit > 0 ? '开盲盒 +' + credit : '已开盲盒');
  } catch (e) {
    // 忽略单步失败
  }
}

/** 开学季：活动在期时领任务奖、再用获得的机会抽转盘。 */
async function claimSchoolSeason(ep, cred, parts) {
  try {
    const root = ep.chatBase;
    const res = await http.get(root + '/portal/activity/school/tasks', billingHeaders(cred), API_TIMEOUT);
    if (res.status < 200 || res.status >= 300) return;
    const obj = safeJson(res.text);
    if (!obj) return;
    const payload = isPlainObject(obj.data) ? obj.data : obj;
    if (payload.in_period !== true) return;

    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    for (const task of tasks) {
      if (!isPlainObject(task)) continue;
      const taskCode = pickString(task, ['task_code']);
      if (!taskCode) continue;
      const progress = isPlainObject(task.progress) ? task.progress : null;
      let done = false;
      if (progress) {
        const cur = pickNumber(progress, ['current', 'progress']);
        const target = pickNumber(progress, ['target', 'target_count']);
        const curv = cur === null ? 0 : cur;
        const targetv = target === null ? 1 : target;
        done = targetv > 0 && curv >= targetv;
      }
      const status = pickString(task, ['status']).toLowerCase();
      if (!done || status === 'claimed' || status === 'received') continue;
      const res2 = await http.postJson(
        root + '/portal/activity/school/tasks/' + encodeURIComponent(taskCode) + '/claim',
        {},
        billingHeaders(cred),
        API_TIMEOUT,
      );
      if (res2.status >= 200 && res2.status < 300) parts.push('开学季任务 ' + taskCode);
    }

    const cfg = await http.get(root + '/portal/activity/school/config', billingHeaders(cred), API_TIMEOUT);
    if (cfg.status < 200 || cfg.status >= 300) return;
    const cfgObj = safeJson(cfg.text);
    if (!cfgObj) return;
    let chance = isPlainObject(cfgObj.chance) ? cfgObj.chance : null;
    if (!chance && isPlainObject(cfgObj.data) && isPlainObject(cfgObj.data.chance)) chance = cfgObj.data.chance;
    const balance = chance ? pickNumber(chance, ['balance', 'count']) : null;
    if (balance === null || balance <= 0) return;

    const res3 = await http.postJson(
      root + '/portal/activity/school/wheel/draw',
      { draw_uuid: uuid4() },
      billingHeaders(cred),
      API_TIMEOUT,
    );
    if (res3.status < 200 || res3.status >= 300) return;
    const prize = pickString(safeJson(res3.text), ['prize_code']);
    parts.push(prize ? '开学季转盘 ' + prize : '开学季转盘');
  } catch (e) {
    // 忽略单步失败
  }
}

// ── 登录（设备授权） ──────────────────────────────────────────

/**
 * 申请授权链接。
 *
 * 上游没有回调链接端点，只能走设备授权：拿 state + authUrl，用户在浏览器里登录后
 * 再按 state 轮询 token。region 只影响打哪个站点。
 */
async function startDeviceAuth(region) {
  const ep = endpointOf(region === REGION_GLOBAL ? REGION_GLOBAL : REGION_CN);
  const url = ep.chatBase + PATH_AUTH_STATE + '?platform=CLI';
  let res;
  try {
    res = await http.postJson(url, {}, {}, API_TIMEOUT);
  } catch (e) {
    throw new Error('请求授权链接失败：' + e.message);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error('请求授权链接失败（HTTP ' + res.status + '）');
  }
  const data = envelopeData(res.text);
  if (!data) throw new Error('授权响应异常：' + String(res.text || '').slice(0, 200));

  const state = String(data.state || '');
  const authUrl = String(data.authUrl || '');
  if (!state || !authUrl) throw new Error('授权响应缺少 state 或 authUrl');
  return { loginUrl: authUrl, state };
}

/**
 * 按 state 轮询登录结果。
 *
 * @returns {Promise<{status:'pending'|'success'|'failed', account?:object, message?:string}>}
 */
async function pollDeviceAuth(state, region) {
  const ep = endpointOf(region === REGION_GLOBAL ? REGION_GLOBAL : REGION_CN);
  const url = ep.chatBase + PATH_AUTH_TOKEN + '?state=' + encodeURIComponent(state);

  let res;
  try {
    res = await http.get(url, {}, API_TIMEOUT);
  } catch (e) {
    return { status: 'failed', message: e.message || '轮询失败' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { status: 'failed', message: '轮询失败（HTTP ' + res.status + '）' };
  }
  const obj = safeJson(res.text);
  if (!isPlainObject(obj)) return { status: 'failed', message: '轮询响应不是合法 JSON' };

  const code = Number(obj.code);
  if (code === CODE_LOGIN_PENDING) return { status: 'pending' };
  if (code !== 0) {
    return { status: 'failed', message: String(obj.msg || '登录未完成（code=' + code + '）') };
  }
  const data = isPlainObject(obj.data) ? obj.data : null;
  if (!data) return { status: 'failed', message: '登录响应缺少 data' };

  const cred = credentialOf(data);
  if (!cred.accessToken) return { status: 'failed', message: '登录响应缺少 accessToken' };
  return { status: 'success', account: toAccount(cred) };
}

/**
 * 从 cookie 建账号。
 *
 * 设备授权不产生 cookie 会话，只有用户在浏览器里已经登录过、cookie 里带着现成 token 时
 * 才有意义；找不到就明确报错，别建一个用不了的账号。
 */
async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  const token = jar.access_token || jar.accessToken || jar.authorization ||
    jar.token || jar.ACCESS_TOKEN || '';
  if (!token) {
    throw new Error('cookie 里没有 access_token，请改用设备授权或粘贴凭证 JSON');
  }
  const cred = credentialOf(Object.assign({}, jar, { accessToken: token }));
  return toAccount(cred);
}

// ── 导入 ──────────────────────────────────────────────────────

/**
 * 粘贴导入：支持 App 导出的账号 JSON（数组 / {accounts:[]} / 单个对象）、多条 JSON 相连、
 * 每行一个裸 token 或 cookie 串。按 uid 去重。
 */

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
      enterpriseId: s.enterpriseId || s.enterprise_id || '',
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

    const uid = importer.resolveUid(item, secret, 'codebuddy');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('codebuddy', uid, nickname, JSON.stringify(built), extraOf(built)));
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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pick(obj, keys) {
  if (!isPlainObject(obj)) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function pickString(obj, keys) {
  if (!isPlainObject(obj)) return '';
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value) return value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function pickNumber(obj, keys) {
  if (!isPlainObject(obj)) return null;
  for (const key of keys) {
    const value = numOrNull(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function numOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function endsWith(text, suffix) {
  return String(text || '').slice(-suffix.length) === suffix;
}

function uuid4() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
    '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

/**
 * 会话指纹：由 OpenAI 请求体的稳定前缀（system/developer + 首条 user）确定性派生。
 * 会话尾部不参与，因此对话增长不改变该值——这正是提示词缓存分桶需要的东西。
 */
function stableConversationId(bodyText) {
  const obj = safeJson(bodyText);
  if (!isPlainObject(obj)) return '';
  const messages = Array.isArray(obj.messages) ? obj.messages : null;
  if (!messages) return '';

  const seed = [];
  let firstUser = null;
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    const role = String(message.role || '');
    if (role === 'system' || role === 'developer') {
      seed.push(role + ':' + contentTextOf(message) + '\n');
    } else if (role === 'user' && firstUser === null) {
      firstUser = contentTextOf(message);
    }
  }
  if (firstUser !== null) seed.push('user:' + firstUser + '\n');
  if (seed.length === 0) return '';
  return uuidFromDigest(seed.join(''));
}

/** 把 content（字符串或多模态数组）压成纯文本，用于生成会话指纹。 */
function contentTextOf(message) {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (isPlainObject(part) && typeof part.text === 'string') out += part.text;
  }
  return out;
}

function uuidFromDigest(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
    '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

function hashShort(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
}

function formatDateTime(date) {
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function envelopeData(body) {
  const obj = safeJson(body);
  if (!isPlainObject(obj)) return null;
  if (Number(obj.code) !== 0) return null;
  return isPlainObject(obj.data) ? obj.data : null;
}

function extractMessage(body) {
  const obj = safeJson(body);
  if (!isPlainObject(obj)) return '';
  const msg = pickString(obj, ['msg']);
  if (msg) return msg;
  if (isPlainObject(obj.error)) {
    const inner = pickString(obj.error, ['message']);
    if (inner) return inner;
  }
  return pickString(obj, ['message']);
}

/** 把响应体整理成一句可读的补充说明；只给状态码无法定位真实原因。 */
function describeBody(body) {
  const text = String(body || '');
  if (!text.trim()) return '';
  const obj = safeJson(text);
  if (isPlainObject(obj)) {
    const msg = pickString(obj, ['msg', 'message', 'desc']);
    if (msg) return '：' + msg;
    if (isPlainObject(obj.error)) {
      const inner = pickString(obj.error, ['message']);
      if (inner) return '：' + inner;
    }
  }
  return '：' + text.trim().slice(0, 200);
}

function parseCookieString(cookie) {
  const out = {};
  if (!cookie) return out;
  for (const part of String(cookie).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
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
      const ch = text[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
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
  id: 'codebuddy',
  displayName: 'WorkBuddy',
  authKind: 'DEVICE_CODE',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN, CAP.TASKS],
  defaultModel: DEFAULT_MODEL,

  // 代理分流的域名清单：插件链路（copilot/codebuddy）与网页链路（workbuddy）用的身份头不同，
  // 域名都要列上，否则分流开关对网页链路不生效
  hosts: ['copilot.tencent.com', 'codebuddy.cn', 'workbuddy.cn', 'codebuddy.ai', 'workbuddy.ai'],

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  creditPacks,
  checkin,
  taskList,
  runTasks,
  startDeviceAuth,
  pollDeviceAuth,
  accountFromCookie,
  importCredentials,

  // 页面/调试用
  accountRegion: (account) => {
    const cred = parse(account);
    return cred ? regionOf(cred) : '';
  },
  regions: () => [REGION_CN, REGION_GLOBAL],
};
