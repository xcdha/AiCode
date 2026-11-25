'use strict';

/**
 * Loomy（讯飞，loomyad.xunfei.cn）。
 *
 * 登录：手机号 + 短信验证码，落在讯飞账号服务 `account.xfinfr.com`，
 *       每个请求都要 HMAC-SHA1 签名（密钥是官方客户端内置常量）。
 * 对话：`/api/v1/chat/completions` 本身就是 OpenAI 兼容协议，几乎直通。
 *       两个坑：`traceparent` 必须带（缺了上游挂到超时）、`Content-Type` 必须带 charset=utf-8
 *       （不带上游按 GBK 解码，中文全乱）。
 * 鉴权：`token` 头与 `Authorization: Bearer` 都发（官方客户端双写）。
 *       失效时上游回 **HTTP 200 + 业务码**（020002 / 100002），不是 4xx —— 必须按业务码判。
 * 积分：`GET /api/v1/points/records`。`balance` 是永久积分、`dailyBalance` 是每日赠送，
 *       对话先扣每日赠送，所以可用总额 = 两者之和。
 * 签到：`POST /api/v1/points/first-login` —— 官方客户端每次登录都发它，
 *       服务端按「当天第一次」把每日赠送刷回。按天幂等，重复调也是成功。
 * 任务：`/api/v1/onboarding/tasks` 新手任务（合计 10000 积分），完成要服务端校验真实动作。
 *
 * 没有 refresh token：session 14 天，失效只能重新登录。
 */

const crypto = require('crypto');
const https = require('https');
const httpMod = require('http');
const { URL } = require('url');

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const ACCOUNT_BASE = 'https://account.xfinfr.com';
const API_BASE = 'https://loomyad.xunfei.cn';

const PATH_SEND_SMS = '/login/phone/sendMsgCode';
const PATH_LOGIN_SMS = '/login/phone/checkCode';
const PATH_USER_INFO = '/userinfo/query/baseInfo';

const PATH_MODELS = '/api/v1/models';
const PATH_CHAT = '/api/v1/chat/completions';
const PATH_POINTS_RECORDS = '/api/v1/points/records';
const PATH_POINTS_FIRST_LOGIN = '/api/v1/points/first-login';
const PATH_TEAM_POINTS = '/api/v1/team-points/balance';
const PATH_TASKS = '/api/v1/onboarding/tasks';
const PATH_TASK_COMPLETE = '/api/v1/onboarding/tasks/complete';

const APP_ID = 'GM3LOOMY';
const ACCESS_KEY_ID = '2thryby66wxi53sk';
const ACCESS_KEY_SECRET = 'zsak6eadrbawz683wf5r3m2snrwj868r';
const CLIENT_VERSION = '0.9.38';
const SESSION_EXPIRE_SECONDS = 14 * 24 * 3600;

const CODE_OK = '000000';
const AUTH_CODES = ['020002', '100002'];

const DEFAULT_MODEL = 'spark-x';

// 与官方客户端 electron/onboarding-service.js 的 TASK_POINTS 逐项一致（合计 10000）
const TASK_POINTS = [
  ['first_message', 500, '完成首次对话'],
  ['pick_skill', 1000, '选择技能'],
  ['generate_ppt', 1500, '生成 PPT'],
  ['set_schedule', 1000, '设置定时任务'],
  ['install_skill', 1500, '安装技能'],
  ['configure_remote', 1000, '配置远程控制'],
  ['create_soul', 1500, '创建搭子'],
  ['share_soul', 2000, '分享搭子'],
];

// 登录前也能列出的静态目录（2026-10-16 实抓 /api/v1/models 的 chat 模型）
const STATIC_MODELS = [
  { id: 'auto', name: '自动 · 均衡', contextWindow: 0, supportsTools: true, supportsReasoning: false },
  { id: 'spark-x', name: 'Spark-X2.5（限时免费）', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash (x2.0)', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 (x3.0)', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash (x0.8)', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'qwen3.8-flash', name: 'qwen 3.8 flash (x0.8)', contextWindow: 1000000, supportsTools: true, supportsReasoning: true },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (x3.3)', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'MiniMax-M3', name: 'MiniMax M3 (x4.0)', contextWindow: 1048576, supportsTools: true, supportsReasoning: true },
  { id: 'Kimi-k2.6', name: 'Kimi k2.6 (x6.5)', contextWindow: 262144, supportsTools: true, supportsReasoning: true },
  { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max (x12.0)', contextWindow: 1000000, supportsTools: true, supportsReasoning: true },
];

// ── 请求头 ────────────────────────────────────────────────────

/** 积分/模型/任务接口：裸 `token` 头（不是 Bearer）。 */
function tokenHeaders(session) {
  return {
    Accept: 'application/json',
    token: session,
    Authorization: 'Bearer ' + session,
    traceparent: newTraceparent(),
    'loomy-version': CLIENT_VERSION,
  };
}

/** 对话接口：官方客户端会额外带归属头（服务端按它们记账）。 */
function chatHeaders(session) {
  const h = tokenHeaders(session);
  h['Content-Type'] = 'application/json;charset=utf-8';
  h.Accept = 'application/json';
  h.invokeorigin = 'user';
  // 每请求唯一：稳定的 chatid 配新 msgid 会被上游当成同会话并发/重放（偶发 409）
  h.chatid = 'chat-' + crypto.randomUUID();
  h.msgid = 'msg-' + crypto.randomUUID();
  return h;
}

/** 讯飞账号服务的签名头。 */
function signedHeaders(method, path, body) {
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const contentType = 'application/json';
  const md5 = contentMd5(body);
  // 末两段（signed headers / canonicalized headers）为空但**不能省**
  const stringToSign = [
    String(method).toUpperCase(),
    escapedPath(path),
    '',
    md5,
    contentType,
    date,
    nonce,
    '',
    '',
  ].join('\n');
  const signature = crypto
    .createHmac('sha1', ACCESS_KEY_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');

  const headers = {
    Authorization: 'account ' + ACCESS_KEY_ID + ':' + signature,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  };
  if (md5) headers['Content-MD5'] = md5;
  return headers;
}

function contentMd5(body) {
  if (!body) return '';
  return crypto.createHash('md5').update(String(body), 'utf8').digest('base64');
}

/** RFC3986 逐段转义，额外把 !'()* 换掉（讯飞签名按 Node 的 encodeURIComponent 口径）。 */
function escapedPath(path) {
  let clean = String(path).charAt(0) === '/' ? String(path) : '/' + String(path);
  if (clean.length > 1 && clean.charAt(clean.length - 1) === '/') clean = clean.slice(0, -1);
  return clean
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      return encodeURIComponent(seg).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
    })
    .join('/');
}

/** 账号服务的统一信封 `{base, param}`；base 里的 traceid 每请求都换。 */
function envelope(param) {
  return {
    base: {
      appid: APP_ID,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: crypto.randomBytes(16).toString('hex'),
    },
    param: param,
  };
}

function newTraceparent() {
  return '00-' + randomHex(16) + '-' + randomHex(8) + '-01';
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const session = String(obj.session || obj.token || obj.accessToken || '').trim();
  if (!session) return null;
  return {
    session,
    uid: String(obj.uid || obj.userId || obj.userid || (account && account.uid) || ''),
    phone: String(obj.phone || ''),
    nickname: String(obj.nickname || (account && account.nickname) || ''),
    expiresAt: Number(obj.expiresAt || 0),
  };
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const model = String(requested || '').trim();
  if (!model) return DEFAULT_MODEL;
  // 网关对外是 `模型名@昵称`，调用方也可能传 `provider/model`；两种都只留模型名
  const bare = model.replace(/@[^@]*$/, '').trim();
  const idx = bare.lastIndexOf('/');
  return idx >= 0 ? bare.slice(idx + 1).trim() || bare : bare;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const res = await http.get(API_BASE + PATH_MODELS, tokenHeaders(cred.session), 30000);
  const obj = decodeEnvelope(res.status, res.text);
  const arr = Array.isArray(obj.data) ? obj.data : [];
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id) continue;
    out.push(normalizeModel(item, id));
  }
  return out.length > 0 ? out : STATIC_MODELS.slice();
}

function normalizeModel(item, id) {
  const limit = item.limit && typeof item.limit === 'object' ? item.limit : {};
  const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
  const modalities = item.modalities && typeof item.modalities === 'object' ? item.modalities : {};
  const input = Array.isArray(modalities.input) ? modalities.input : [];
  const context = Number(limit.context || item.context_length || item.context_window || 0);
  const reasoning = item.reasoning === true || item.supports_reasoning === true || caps.reasoning === true;
  const tools = item.tool_call === true || caps.function_calling === true;
  const vision = item.attachment === true || caps.vision === true || input.indexOf('image') >= 0;
  return {
    id,
    name: String(item.name || item.displayName || id),
    contextWindow: Number.isFinite(context) ? context : 0,
    supportsTools: tools,
    supportsReasoning: reasoning,
    supportsImages: vision,
  };
}

// ── 对话 ──────────────────────────────────────────────────────

/** `stream_options.include_usage` 只有带上，上游末帧才给 usage。 */
function withIncludeUsage(body) {
  if (!body.stream_options || typeof body.stream_options !== 'object') body.stream_options = {};
  if (body.stream_options.include_usage === undefined) body.stream_options.include_usage = true;
  return body;
}

/** 思考档位折成 Loomy 的 low/medium/high；更宽的档上游不认。 */
function foldReasoning(body) {
  const fold = (value) => {
    if (value === 'minimal' || value === 'low') return 'low';
    if (value === 'medium') return 'medium';
    if (value === 'high' || value === 'max') return 'high';
    return null;
  };
  if (typeof body.reasoning_effort === 'string') {
    const folded = fold(body.reasoning_effort);
    if (folded) body.reasoning_effort = folded;
    else delete body.reasoning_effort;
  }
  if (body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
    const folded = fold(body.reasoning.effort);
    if (folded) body.reasoning.effort = folded;
    else delete body.reasoning.effort;
  }
  return body;
}

/**
 * 老版 deepseek-v4-flash 只认 `<image_base64>` 标记、不认 OpenAI 的 image_url，
 * 其它模型（含 DeepSeek-V4.1-Flash / -1017）都收 image_url，不能乱转。
 */
function prefersTagFormat(model) {
  const name = String(model || '').toLowerCase().replace(/^.*\//, '');
  return /^deepseek-v4-flash(?:-0731)?$/.test(name);
}

function rewriteImagesToTags(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (let i = message.content.length - 1; i >= 0; i--) {
      const part = message.content[i];
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '').toLowerCase();
      if (type !== 'image_url' && type !== 'input_image') continue;
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
      if (typeof url !== 'string' || url.indexOf('data:') !== 0) continue;
      const tag = '<image_base64>' + url + '</image_base64>';
      message.content.splice(i, 1);
      const prev = i > 0 ? message.content[i - 1] : null;
      if (prev && prev.type === 'text') prev.text = String(prev.text || '') + '\n' + tag;
      else message.content.splice(i, 0, { type: 'text', text: tag });
    }
  }
  return body;
}

/**
 * 发起对话。上游是 OpenAI 协议，正常情况下补头后直接透传 SSE 行。
 *
 * 两种坑必须在本地处理：
 * 1. 鉴权失效是 **HTTP 200 + 业务码**，必须读到正文才能判，不能当成空回复；
 * 2. 客户端要非流式时上游可能直接回一个 completion JSON，需要自己拼成 SSE 行。
 */
async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) {
    return { status: 401, model: '', error: { status: 401, message: '账号凭证无法解析' } };
  }

  let body;
  try {
    body = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : Object.assign({}, openAiBody);
  } catch (e) {
    return { status: 400, model: '', error: { status: 400, message: '请求体不是合法 JSON' } };
  }
  const model = resolveModel(body.model);
  body.model = model;
  body.stream = body.stream !== false;
  if (body.stream) withIncludeUsage(body);
  foldReasoning(body);
  if (prefersTagFormat(model)) rewriteImagesToTags(body);

  let res;
  try {
    res = await startRequest({
      url: API_BASE + PATH_CHAT,
      headers: chatHeaders(cred.session),
      body: JSON.stringify(body),
      timeout: 300000,
    });
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: '请求 Loomy 失败：' + e.message } };
  }

  const contentType = String(res.headers['content-type'] || '');

  if (res.status < 200 || res.status >= 300) {
    const text = await res.text;
    const info = classifyFailure(res.status, text);
    return { status: info.status, model, headers: res.headers, error: info };
  }

  if (/event-stream/i.test(contentType)) {
    const splitter = sse.createLineSplitter((line) => {
      if (line) onLine(line);
    });
    res.sink.set(splitter);
    let tail = '';
    try {
      tail = await res.text;
    } catch (e) {
      // 已经流出去的正文不能收回；没有产出才算彻底失败
      return { status: 502, model, headers: res.headers, error: { status: 502, message: '读取 Loomy 事件流失败：' + e.message } };
    }
    // 流里混进拒绝信封（HTTP 200 + 业务码）时也要判错
    if (tail && /"code"\s*:\s*"(020002|100002)"/.test(tail)) {
      return { status: 401, model, headers: res.headers, error: { status: 401, message: '登录状态已失效，需要重新登录' } };
    }
    return { status: res.status, headers: res.headers, model };
  }

  // 非 SSE：要么是 completion JSON，要么是 200 + 业务码的拒绝
  let text = '';
  try {
    text = await res.text;
  } catch (e) {
    return { status: 502, model, headers: res.headers, error: { status: 502, message: '读取 Loomy 响应失败：' + e.message } };
  }
  const obj = safeJson(text);
  if (!obj || typeof obj !== 'object') {
    return {
      status: 502,
      model,
      headers: res.headers,
      error: { status: 502, message: 'Loomy 返回了无法解析的内容：' + String(text || '').slice(0, 160) },
    };
  }
  const code = String(obj.code || '').trim();
  if (code && code !== CODE_OK) {
    const info = classifyFailure(res.status, text);
    return { status: info.status, model, headers: res.headers, error: info };
  }
  emitCompletion(obj, model, onLine);
  return { status: res.status, headers: res.headers, model };
}

/** 把上游的拒绝正文翻成给客户端看的错误（登录失效优先于状态码）。 */
function classifyFailure(status, text) {
  const obj = safeJson(text) || {};
  const code = String(obj.code || '').trim();
  const said = String(obj.desc || obj.message || '').trim();
  const lower = String(text || '').toLowerCase();

  if (
    AUTH_CODES.indexOf(code) >= 0 ||
    status === 401 ||
    indexOfAny(lower, ['token 已失效', '登录已失效', 'session expired', 'invalid session', 'not logged in', 'unauthorized'])
  ) {
    return { status: 401, message: '登录状态已失效，需要重新登录' };
  }
  if (
    indexOfAny(lower, ['insufficient credit', 'not enough credit', 'credit exhausted', 'quota exceeded']) ||
    indexOfAny(String(text || ''), ['积分不足', '积分已用完', '余额不足', '额度不足', '额度已用完'])
  ) {
    return { status: 429, message: said || '积分或当日额度已耗尽' };
  }
  if (status === 429) return { status: 429, message: said || '请求过于频繁，已被上游限流' };
  return {
    status: status >= 400 ? status : 502,
    message: said || 'Loomy 拒绝了请求（HTTP ' + status + (code ? '，code=' + code : '') + '）',
  };
}

function indexOfAny(text, needles) {
  for (const needle of needles) {
    if (text.indexOf(needle) >= 0) return true;
  }
  return false;
}

/** 非流式 completion → OpenAI chunk 行。 */
function emitCompletion(obj, model, onLine) {
  const id = String(obj.id || 'chatcmpl-loomy-' + Date.now());
  const created = Number(obj.created || Math.floor(Date.now() / 1000));
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  let text = '';
  if (choice && typeof choice === 'object') {
    if (choice.message && typeof choice.message === 'object') {
      text = typeof choice.message.content === 'string' ? choice.message.content : '';
    } else if (typeof choice.text === 'string') {
      text = choice.text;
    }
  }

  const frame = (delta, finishReason) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  onLine('data: ' + JSON.stringify(frame({ role: 'assistant' }, null)));
  if (text) onLine('data: ' + JSON.stringify(frame({ content: text }, null)));
  onLine('data: ' + JSON.stringify(frame({}, 'stop')));
  onLine('data: [DONE]');
}

/**
 * 打开请求：**响应头一到就 resolve**，正文通过句柄按需读。
 *
 * 必须先看 content-type 才知道该按 SSE 逐块解析还是当 JSON 读完整——
 * 两种情形上游都可能回 HTTP 200。
 */
function startRequest(opts) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(opts.url);
    } catch (e) {
      reject(new Error('URL 非法：' + opts.url));
      return;
    }
    let handle = null;
    const lib = url.protocol === 'https:' ? https : httpMod;
    const headers = Object.assign({}, opts.headers || {});
    headers['Accept-Encoding'] = 'identity';

    const payload = Buffer.from(String(opts.body || ''), 'utf8');
    if (!headers['Content-Length']) headers['Content-Length'] = payload.length;

    const req = lib.request(
      {
        method: opts.method || 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        // 消费者可能晚一步挂上（要先看 content-type），先把块排队
        const sink = {
          handler: null,
          queue: [],
          set(fn) {
            this.handler = fn;
            for (const chunk of this.queue) fn(chunk);
            this.queue = [];
          },
          push(chunk) {
            if (this.handler) this.handler(chunk);
            else this.queue.push(chunk);
          },
        };

        let settle;
        const text = new Promise((done, fail) => {
          settle = { done, fail };
        });

        res.on('data', (chunk) => {
          chunks.push(chunk);
          sink.push(chunk);
        });
        res.on('end', () => settle.done(Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => settle.fail(e));
        res.on('aborted', () => settle.fail(new Error('上游中断了响应')));

        handle = { settle };
        resolve({ status: res.statusCode || 0, headers: res.headers, sink, text });
      },
    );

    const timeout = opts.timeout || 300000;
    const timer = setTimeout(() => req.destroy(new Error('请求超时（' + timeout + 'ms）')), timeout);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
      // 已经拿到响应头时 reject 无效，必须把正文的 Promise 也结束掉，否则调用方永久挂住
      if (handle) handle.settle.fail(e);
    });
    req.on('close', () => clearTimeout(timer));

    req.write(payload);
    req.end();
  });
}

// ── 积分 ──────────────────────────────────────────────────────

/** 个人 + 团队两个账本；缺字段记 -1，不用 0 冒充「没有」。 */
async function fetchPointsSnapshot(session) {
  const records = await getEnvelope(
    API_BASE + PATH_POINTS_RECORDS + '?pageNo=1&pageSize=20&recordType=all',
    tokenHeaders(session),
  );
  const data = records.data && typeof records.data === 'object' ? records.data : {};

  let team = -1;
  try {
    const raw = await getEnvelope(API_BASE + PATH_TEAM_POINTS, tokenHeaders(session));
    const t = raw.data && typeof raw.data === 'object' ? raw.data : {};
    if (t.currentBalance !== undefined) team = Number(t.currentBalance);
    else if (t.balance !== undefined) team = Number(t.balance);
  } catch (e) {
    team = -1;
  }

  const pick = (key) => (data[key] === undefined || data[key] === null ? -1 : Number(data[key]));
  return {
    personal: pick('balance'),
    team,
    dailyRemaining: pick('dailyRemainingPoints'),
    dailyLimit: pick('dailyLimitPoints'),
    dailyConsumed: pick('dailyConsumedPoints'),
    dailyBalance: pick('dailyBalance'),
    raw: records,
  };
}

/** 可用总额 = 主账本 + 当日赠送（对话先扣当日赠送）。 */
function totalCredit(snapshot) {
  const main = snapshot.team > snapshot.personal ? snapshot.team : Math.max(0, snapshot.personal);
  const daily =
    snapshot.dailyRemaining >= 0
      ? snapshot.dailyRemaining
      : snapshot.dailyBalance >= 0
        ? snapshot.dailyBalance
        : 0;
  return { main, daily, total: main + daily };
}

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('账号凭证无法解析，请重新登录');

  // 上游偶发回「系统内部错误」（业务码非成功），账号本身正常；重试一次能挡掉瞬时故障
  let snapshot;
  try {
    snapshot = await fetchPointsSnapshot(cred.session);
  } catch (e) {
    if (e.sessionDead) throw e;
    snapshot = await fetchPointsSnapshot(cred.session);
  }

  const sum = totalCredit(snapshot);
  const known = snapshot.personal >= 0 || snapshot.team >= 0;
  const source = snapshot.team > snapshot.personal ? '团队' : '个人';
  const detail = known
    ? source + '=' + sum.main + '，当日剩余=' + (sum.daily > 0 ? sum.daily : '—')
    : '未取到余额（响应片段：' + JSON.stringify(snapshot.raw).slice(0, 120) + '）';

  return { credit: sum.total, creditText: detail, raw: snapshot };
}

// ── 签到 ──────────────────────────────────────────────────────

/**
 * 每日签到 = 官方客户端每次登录都会发的 `POST /api/v1/points/first-login`。
 *
 * 服务端按「当天第一次」把每日赠送刷回，重复调用照样返回成功，
 * 所以 claimed / done 只能靠调用前后的每日余额差判断。
 */
async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '账号凭证无法解析' };

  let before = null;
  try {
    const records = await getEnvelope(
      API_BASE + PATH_POINTS_RECORDS + '?pageNo=1&pageSize=1&recordType=all',
      tokenHeaders(cred.session),
    );
    const data = records.data && typeof records.data === 'object' ? records.data : {};
    if (data.dailyBalance !== undefined) before = Number(data.dailyBalance);
    else if (data.dailyRemainingPoints !== undefined) before = Number(data.dailyRemainingPoints);
  } catch (e) {
    if (e.sessionDead) return { ok: false, message: '登录状态已失效，需要重新登录' };
    // 读不到前置余额就没有诚实的 claimed/done 判断，直接失败而不是谎报「已签到」
    return { ok: false, message: '无法读取签到前余额，未执行每日刷新：' + e.message };
  }

  let res;
  try {
    res = await http.postJson(API_BASE + PATH_POINTS_FIRST_LOGIN, {}, tokenHeaders(cred.session), 30000);
  } catch (e) {
    return { ok: false, message: '每日积分刷新失败：' + e.message };
  }
  const obj = safeJson(res.text) || {};
  const code = String(obj.code || '').trim();
  if (AUTH_CODES.indexOf(code) >= 0 || res.status === 401 || res.status === 403) {
    return { ok: false, message: '登录状态已失效，需要重新登录' };
  }
  if (code && code !== CODE_OK) {
    return { ok: false, message: '每日积分刷新失败：' + String(obj.desc || obj.message || 'code=' + code) };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: '每日积分刷新失败：HTTP ' + res.status };
  }

  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  let after = data.dailyBalance === undefined ? null : Number(data.dailyBalance);
  if (after === null) {
    try {
      const records = await getEnvelope(
        API_BASE + PATH_POINTS_RECORDS + '?pageNo=1&pageSize=1&recordType=all',
        tokenHeaders(cred.session),
      );
      const d = records.data && typeof records.data === 'object' ? records.data : {};
      if (d.dailyBalance !== undefined) after = Number(d.dailyBalance);
      else if (d.dailyRemainingPoints !== undefined) after = Number(d.dailyRemainingPoints);
    } catch (e) {
      after = null;
    }
  }

  const dailyMsg = after !== null ? '每日赠送积分已刷新，当前 ' + after : '每日赠送积分已刷新';
  if (before !== null && after !== null && after > before) {
    return { ok: true, message: dailyMsg + '；今日首登奖励 +' + (after - before), gained: after - before };
  }
  return { ok: true, message: before !== null && after !== null ? '今日已签到（' + dailyMsg + '）' : dailyMsg };
}

// ── 任务（新手任务）──────────────────────────────────────────

/** 任务状态：`data.tasks` 是 `{key: bool}` 的完成标记表。 */
async function readTaskState(session) {
  const obj = await getEnvelope(API_BASE + PATH_TASKS, tokenHeaders(session));
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const state = data.tasks && typeof data.tasks === 'object' ? data.tasks : {};
  return state;
}

function tasksOf(state) {
  return TASK_POINTS.map(([key, points, title]) => {
    const completed = state[key] === true;
    return {
      code: key,
      title,
      description: points + ' 积分',
      current: completed ? 1 : 0,
      target: 1,
      status: completed ? 'claimed' : 'pending',
      locked: false,
      claimed: completed,
      rewardCredit: points,
    };
  });
}

async function taskList(account) {
  const cred = parse(account);
  if (!cred) return { tasks: [], error: '账号凭证无法解析' };
  try {
    const state = await readTaskState(cred.session);
    return { tasks: tasksOf(state), error: '' };
  } catch (e) {
    return {
      tasks: [],
      error: e.sessionDead ? '登录状态已失效，需要重新登录' : e.message || '拉取任务失败',
    };
  }
}

/**
 * 领取已完成任务。
 *
 * 任务对应真实动作（首次对话、生成 PPT 等），服务端会校验；没做过就调完成会被拒，
 * 这里如实把上游原话透出来，不谎报成功。
 */
async function runTasks(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '账号凭证无法解析' };

  let state;
  try {
    state = await readTaskState(cred.session);
  } catch (e) {
    return { ok: false, message: e.sessionDead ? '登录状态已失效，需要重新登录' : e.message || '拉取任务失败' };
  }

  const pending = TASK_POINTS.filter(([key]) => state[key] !== true);
  if (pending.length === 0) return { ok: true, message: '所有任务都已完成' };

  const lines = [];
  const failures = [];
  let gained = 0;
  for (const [key, points, title] of pending) {
    try {
      const res = await http.postJson(
        API_BASE + PATH_TASK_COMPLETE,
        { key },
        tokenHeaders(cred.session),
        30000,
      );
      const obj = safeJson(res.text) || {};
      const code = String(obj.code || '').trim();
      if (AUTH_CODES.indexOf(code) >= 0) {
        failures.push('登录状态已失效，需要重新登录');
        break;
      }
      if (code && code !== CODE_OK) {
        failures.push(title + '：' + String(obj.desc || obj.message || 'code=' + code));
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        failures.push(title + '：HTTP ' + res.status);
        continue;
      }
      const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
      if (data.alreadyCompleted === true) {
        lines.push(title + '：此前已完成');
      } else {
        lines.push(title + '：已完成');
        gained += points;
      }
    } catch (e) {
      failures.push(title + '：' + (e.message || '请求失败'));
    }
  }

  const parts = [];
  if (lines.length > 0) parts.push(lines.join('；'));
  if (failures.length > 0) parts.push('未完成' + failures.length + '项（' + failures.join('；') + '）');
  return {
    ok: lines.length > 0,
    message: parts.join('。') || '没有可领取的任务',
    gained: gained > 0 ? gained : undefined,
  };
}

// ── 登录（手机号 + 短信）──────────────────────────────────────

/** 发码，返回上游 msgid（登录时要原样回传）。 */
async function sendSmsCode(phone, ccode) {
  const zone = String(ccode || '86');
  const mobile = normalizePhone(phone, zone);
  if (!mobile) throw new Error(zone === '86' ? '请填写 11 位中国大陆手机号' : '手机号格式不正确（应为 4–15 位数字）');

  const body = JSON.stringify(
    envelope({ ccode: zone, phone: mobile, expire: 300 }),
  );
  const res = await http.request({
    method: 'POST',
    url: ACCOUNT_BASE + PATH_SEND_SMS,
    headers: signedHeaders('POST', PATH_SEND_SMS, body),
    body,
    timeout: 30000,
  });
  const obj = safeJson(res.text);
  if (!obj) throw new Error('账号服务返回了无法解析的内容（HTTP ' + res.status + '）');
  assertEnvelope(obj, res.status);
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const msgid = String(data.msgid || data.msgId || '');
  if (!msgid) throw new Error('验证码发送成功但上游没有返回 msgid');
  return msgid;
}

/** 用验证码换 session；国家码必须与发码时一致。 */
async function loginBySmsCode(phone, code, msgid, ccode) {
  const zone = String(ccode || '86');
  const mobile = normalizePhone(phone, zone);
  if (!mobile) throw new Error('请填写正确的手机号');
  const smsCode = String(code || '').trim();
  if (!/^\d{4,8}$/.test(smsCode)) throw new Error('请填写短信验证码');

  const body = JSON.stringify(
    envelope({
      ccode: zone,
      phone: mobile,
      mcode: smsCode,
      msgid: String(msgid || ''),
      expire: SESSION_EXPIRE_SECONDS,
    }),
  );
  const res = await http.request({
    method: 'POST',
    url: ACCOUNT_BASE + PATH_LOGIN_SMS,
    headers: signedHeaders('POST', PATH_LOGIN_SMS, body),
    body,
    timeout: 30000,
  });
  const obj = safeJson(res.text);
  if (!obj) throw new Error('账号服务返回了无法解析的内容（HTTP ' + res.status + '）');
  assertEnvelope(obj, res.status);
  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const session = String(data.session || '').trim();
  if (!session) throw new Error('登录成功但上游没有返回 session');

  const uid = String(data.userid || data.userId || '').trim() || mobile;
  let nickname = '';
  try {
    nickname = await fetchNickname(session);
  } catch (e) {
    // 昵称只用于展示，解析不到不该让登录失败
  }
  const now = Date.now();
  const secret = JSON.stringify({
    uid,
    phone: mobile,
    session,
    nickname,
    createdAt: now,
    expiresAt: now + SESSION_EXPIRE_SECONDS * 1000,
  });
  return makeAccount('loomy', uid, nickname || maskPhone(mobile), secret);
}

async function fetchNickname(session) {
  const body = JSON.stringify(envelope({ session }));
  const res = await http.request({
    method: 'POST',
    url: ACCOUNT_BASE + PATH_USER_INFO,
    headers: signedHeaders('POST', PATH_USER_INFO, body),
    body,
    timeout: 30000,
  });
  const obj = safeJson(res.text);
  if (!obj) return '';
  const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
  if (!data) return '';
  const keys = ['nickname', 'nickName', 'name', 'username', 'uname'];
  for (const key of keys) {
    const v = String(data[key] || '').trim();
    if (v) return v;
  }
  for (const nest of ['userinfo', 'userInfo', 'user']) {
    const inner = data[nest];
    if (!inner || typeof inner !== 'object') continue;
    for (const key of keys) {
      const v = String(inner[key] || '').trim();
      if (v) return v;
    }
  }
  return '';
}

function normalizePhone(raw, ccode) {
  let digits = String(raw || '').replace(/[\s-]/g, '');
  if (ccode === '86') {
    if (digits.indexOf('+86') === 0) digits = digits.slice(3);
    else if (digits.length === 13 && digits.indexOf('86') === 0) digits = digits.slice(2);
    return /^1[3-9]\d{9}$/.test(digits) ? digits : '';
  }
  if (digits.indexOf('+') === 0) digits = digits.slice(1);
  // 只有剥掉国家码后仍然像本地号码时才剥，避免把「8521234」这类本地号误当国码开头的号码
  if (digits.indexOf(ccode) === 0) {
    const rest = digits.slice(ccode.length);
    if (/^\d{4,15}$/.test(rest)) digits = rest;
  }
  return /^\d{4,15}$/.test(digits) ? digits : '';
}

function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

// ── 导入 ──────────────────────────────────────────────────────

/**
 * 导入 Loomy 凭证：支持 App 导出的 `{uid, phone, session, ...}`、账号数组、
 * 多条 JSON 相连、每行一个裸 session。
 */

// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.cookie || s.Cookie || s.token)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      cookie: s.cookie || s.Cookie || s.token || '',
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

    const uid = importer.resolveUid(item, secret, 'loomy');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('loomy', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 工具 ──────────────────────────────────────────────────────

/** 解 `{code, desc, data}` 信封；业务码非成功时抛错。 */
function decodeEnvelope(status, text) {
  const obj = safeJson(text);
  if (!obj || typeof obj !== 'object') {
    throw new Error('上游返回了非 JSON 响应（HTTP ' + status + '）');
  }
  const code = String(obj.code || '').trim();
  if (code && code !== CODE_OK) {
    const err = new Error(String(obj.desc || obj.message || 'Loomy 返回 code=' + code));
    err.upstreamCode = code;
    err.sessionDead = AUTH_CODES.indexOf(code) >= 0;
    throw err;
  }
  if (status < 200 || status >= 300) {
    const err = new Error('HTTP ' + status + '：' + String(text || '').slice(0, 160));
    if (status === 401 || status === 403) err.sessionDead = true;
    throw err;
  }
  return obj;
}

async function getEnvelope(url, headers) {
  const res = await http.get(url, headers, 30000);
  return decodeEnvelope(res.status, res.text);
}

function assertEnvelope(obj, status) {
  const code = String(obj.code || '').trim();
  if (code && code !== CODE_OK) {
    throw new Error(String(obj.desc || obj.message || '账号服务返回 code=' + code));
  }
  if (status < 200 || status >= 300) {
    throw new Error('账号服务返回 HTTP ' + status);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function hashShort(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
}

function tryParseAccountsJson(text) {
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

// ── 导出 ──────────────────────────────────────────────────────

module.exports = {
  id: 'loomy',
  displayName: 'Loomy',
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
  importCredentials,

  // 短信登录（页面可调；无自动登录函数，故不进 gateway 的通用流程）
  sendSmsCode,
  loginBySmsCode,

  // 供页面/排查用
  signedHeaders,
  escapedPath,
  contentMd5,
};
