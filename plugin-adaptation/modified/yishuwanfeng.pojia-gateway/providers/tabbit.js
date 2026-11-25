'use strict';

/**
 * Tabbit（web.tabbit.com）。
 *
 * 登录：手机号 + 短信验证码（`POST /api/v0/user/register` 同端点既注册又登录）。
 *       短信流程依赖客户端自生成的 uuid 与 Set-Cookie，网关侧不代登录，凭证靠粘贴导入。
 * 对话：模仿官方安卓客户端 —— `POST /api/v3/chat/runs` 建房，`POST /api/v3/chat/rooms/{id}/join` 收 SSE。
 *       官方客户端**不发 Cookie**、只发 `Authorization: Bearer`；带上网页会话 Cookie 会被判成浏览器，
 *       套用「欢迎使用 Tabbit 浏览器」的网关文案（code 492）。
 * 模型不可用（premium 专属 / prompt 超长）时回退到免费不限量的 Default。
 * 积分：`/api/commerce/quota/v1/usage` 只给「已用百分比」，没有绝对积分，所以展示成剩余百分比。
 * 签到：`/api/commerce/activity/v1/sign-in`（`scene_codes: ["daily_sign_in"]`）。
 *
 * 注意：`input_payload.task_name: "chat"` 是对话协议字段，与任务中心无关。
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

const HOST = 'https://web.tabbit.com';

const PATH_MODELS = '/proxy/v1/model_config/models?scene=chat';
const PATH_RUNS = '/api/v3/chat/runs';
const PATH_JOIN = '/api/v3/chat/rooms/';
const PATH_USAGE = '/api/commerce/quota/v1/usage';
const PATH_MEMBER = '/api/commerce/member/v1/level';
const PATH_SIGNIN_STATUS = '/api/commerce/activity/v1/sign-in/status?scene_codes=daily_sign_in';
const PATH_SIGNIN = '/api/commerce/activity/v1/sign-in';
const PATH_BASE_INFO = '/api/v0/user/base-info';
const PATH_BASE_INFO_PROXY = '/proxy/v0/user/base-info';

const DEFAULT_MODEL = 'tabbit/Default';
const DEFAULT_SELECTED = 'Default';
const MAX_PROMPT_CHARS = 20000;
const EXPIRY_SKEW_SECONDS = 300;

// 与官方客户端抓包一致的 UA / 客户端标识；上游按它们判定「真客户端」还是浏览器
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CLIENT_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/137.0.7151.115 Mobile Safari/537.36';

const CLIENT_ID = '2dd8eb4c1ed9c344d173';
const CLIENT_CONSISTENCY_CLIENT_ID = 'cfe1d5f30482ce97fcb8';
const CLIENT_REQ_CTX = 'MC41Mi4wKDEwMDUyMDAwKQ==';
const WEB_REQ_CTX = 'MS42LjIwKDEwMTA2MDIwKQ==';

// 上游 entity.key 用 md5("")，写死比每次算便宜
const EMPTY_MD5 = crypto.createHash('md5').update('').digest('hex');
// 客户端一致性头要求 device_id 在进程内稳定，每请求都变容易被判不一致
const DEVICE_ID = crypto.randomUUID();

// 离线兜底：真实目录来自免登录的 /proxy/v1/model_config/models
const FALLBACK_NAMES = [
  'Default',
  'Kimi-K3',
  'DeepSeek-V4.1-Flash',
  'DeepSeek-V4-Flash',
  'GLM-5.3-FlashX',
  'GLM-5.3-Flash',
  'GLM-5.3',
  'Qwen3.8-Max',
  'MiMo-V2.6-Pro',
  'MiMo-V2.6-Flash',
  'LongCat-2.0',
  'Qwen3.7-Max',
  'Kimi-K2.7-Code',
  'DeepSeek-V4-Pro',
  'Doubao-Seed-2.1-Pro',
  'Doubao-Seed-2.1-Turbo',
  'MiniMax-M3',
  'Kimi-K2.6',
  'Doubao-Seed-2.0-lite',
  'Qwen3.5-Plus',
  'GLM-5.1',
  'GLM-5.2',
  'GLM-5V-Turbo',
];

// 网关文案特征：上游把「模型不可用」也说成这句话，只能靠正文识别
const GATEWAY_MARKERS = ['[492]', '欢迎使用 Tabbit', '欢迎使用Tabbit', '免费使用最全最先进的模型'];

// ── 请求头 ────────────────────────────────────────────────────

/** 浏览器形态（commerce / 签到 / 模型目录用）。 */
function webHeaders(cred) {
  const h = {
    'User-Agent': WEB_UA,
    'sec-ch-ua': '"Tabbit Browser";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: HOST,
    Referer: HOST + '/',
    'X-Req-Ctx': WEB_REQ_CTX,
  };
  if (cred) {
    h['x-chrome-id-consistency-request'] = consistencyHeader(cred, CLIENT_ID);
    if (cred.cookie) h.Cookie = cred.cookie;
    if (cred.token) h.Authorization = 'Bearer ' + cred.token;
    // 这几项服务端并不校验签名，但网页端会发，留着减少指纹差异
    const traceId = crypto.randomUUID().replace(/-/g, '');
    h['X-Nonce'] = randomHex(64);
    h['Trace-Id'] = crypto.randomUUID();
    h['X-Timestamp'] = String(Date.now());
    h['Unique-Uuid'] = crypto.randomUUID();
    h['X-Signature'] = crypto.randomUUID();
    h.Baggage =
      'sentry-environment=production,sentry-release=497b9dd,' +
      'sentry-public_key=a9d139b726b1f610c3257be624286675,sentry-trace_id=' +
      traceId +
      ',sentry-sampled=false,sentry-sample_rand=0.7224657403168888,sentry-sample_rate=0';
    h['Sentry-Trace'] = traceId + '-' + randomHex(16) + '-0';
  }
  return h;
}

/** 官方客户端形态（对话专用）。刻意不带 Cookie。 */
function clientHeaders(cred, accept) {
  const h = {
    'User-Agent': CLIENT_UA,
    Accept: accept || 'application/json',
    'Accept-Language': 'zh,en;q=0.9,zh-CN;q=0.8',
    Origin: HOST,
    Referer: HOST + '/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Android WebView";v="137", "Not.A/Brand";v="8", "Chromium";v="137"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'x-tabbit-client-platform': 'android',
    'x-req-ctx': CLIENT_REQ_CTX,
    'trace-id': crypto.randomUUID(),
    'unique-uuid': crypto.randomUUID(),
  };
  if (cred) {
    h['X-Chrome-ID-Consistency-Request'] = consistencyHeader(cred, CLIENT_CONSISTENCY_CLIENT_ID);
    if (cred.token) h.Authorization = 'Bearer ' + cred.token;
  }
  return h;
}

function consistencyHeader(cred, clientId) {
  return (
    'version=1,client_id=' + clientId +
    ',device_id=' + (cred.deviceId || DEVICE_ID) +
    ',sync_account_id=' + (cred.userId || '') +
    ',signin_mode=all_accounts,signout_mode=show_confirmation'
  );
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const cookie = String(obj.cookie || '').trim();
  if (!cookie) return null;
  const parts = parseCookieString(cookie);
  const token = String(parts.token || parts.tbt_token || obj.access_token || obj.token || '').trim();
  const userId = String(
    parts.user_id || obj.userId || obj.uid || jwtClaim(token, ['id', 'sub']) || '',
  ).trim();
  return {
    cookie,
    token,
    userId,
    deviceId: String(parts.device_id || ''),
    nickname: String(obj.nickname || (account && account.nickname) || '').trim(),
  };
}

/** 从 TBT JWT 的 payload 里取一个声明。 */
function jwtClaim(token, names) {
  const payload = jwtPayload(token);
  if (!payload) return '';
  for (const name of names) {
    const v = payload[name];
    if (v !== undefined && v !== null && String(v)) return String(v);
  }
  return '';
}

/** JWT 的 exp（秒）；解不出返回 0，交给上游去判过期。 */
function jwtExp(token) {
  const payload = jwtPayload(token);
  if (!payload) return 0;
  const exp = Number(payload.exp || 0);
  return Number.isFinite(exp) && exp > 0 ? exp : 0;
}

function jwtPayload(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    let seg = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (seg.length % 4) seg += '=';
    const obj = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

// ── 模型 ──────────────────────────────────────────────────────

/** 目录里的 id 是 `tabbit/<显示名>`，上游 `selected_model` 只吃显示名。 */
function resolveModel(requested) {
  // 网关也可能直接把我们自己的 `模型@昵称` 透传下来
  const model = String(requested || '').replace(/@[^@]*$/, '').trim();
  if (!model) return DEFAULT_SELECTED;
  return model.indexOf('tabbit/') === 0 ? model.slice(7).trim() || DEFAULT_SELECTED : model;
}

async function fetchModels(account) {
  const cred = parse(account);
  let list = [];
  try {
    const res = await http.get(HOST + PATH_MODELS, webHeaders(cred), 30000);
    if (res.status >= 200 && res.status < 300) list = parseModelList(res.text);
  } catch (e) {
    list = [];
  }
  // 目录接口免登录，失败只说明网络问题；网关仍要能应答 /v1/models
  return list.length > 0 ? list : fallbackModels();
}

function parseModelList(text) {
  const obj = safeJson(text);
  if (!obj || !Array.isArray(obj.models)) return [];
  const seen = new Set();
  const out = [];
  for (const item of obj.models) {
    if (!item || typeof item !== 'object') continue;
    const display = String(item.display_name || '').trim();
    if (!display) continue;
    const id = 'tabbit/' + display;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: display,
      contextWindow: 0,
      supportsTools: item.supports_tools !== false,
      supportsReasoning: item.support_thinking !== false,
    });
  }
  return out;
}

function fallbackModels() {
  return FALLBACK_NAMES.map((name) => ({
    id: 'tabbit/' + name,
    name,
    contextWindow: 0,
    supportsTools: true,
    supportsReasoning: true,
  }));
}

// ── 对话 ──────────────────────────────────────────────────────

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'text' || type === 'input_text') parts.push(String(part.text || ''));
    }
    return parts.join('');
  }
  return '';
}

function buildPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || 'user');
    const text = contentText(message.content);
    if (!text || !text.trim()) continue;
    if (role === 'system') parts.push(text);
    else if (role === 'assistant') parts.push('[assistant]: ' + text);
    else if (role === 'tool') parts.push('[tool]: ' + text);
    else parts.push(text);
  }
  return compact(parts.join('\n\n'), MAX_PROMPT_CHARS);
}

/** 上游 prompt 超过约 2 万字符就回 492，按头 35% / 尾 65% 夹断（保留最近的对话）。 */
function compact(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.35);
  const tail = limit - head;
  return (
    text.slice(0, head) +
    '\n\n…（中间内容过长已省略）…\n\n' +
    text.slice(text.length - tail)
  );
}

/**
 * 输出守卫：扣住正文开头，直到能判断它不是「浏览器网关文案」为止。
 *
 * 一旦把网关文案下发出去就撤不回来了，所以可疑前缀一律先扣住；
 * 正常回复在首个分块就能判定，不会明显延迟。
 */
function createSink(onLine, model) {
  const chatId = 'chatcmpl-tab-' + Date.now();
  let roleSent = false;
  let produced = false;
  let buffered = '';
  let decided = false;
  let unavailable = '';

  function chunk(delta, finishReason) {
    onLine(
      'data: ' +
        JSON.stringify({
          id: chatId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason === undefined ? null : finishReason,
            },
          ],
        }),
    );
  }

  function emit(text) {
    if (!text) return;
    if (!roleSent) {
      roleSent = true;
      chunk({ role: 'assistant' });
    }
    chunk({ content: text });
    produced = true;
  }

  return {
    feed(text) {
      if (!text) return;
      if (decided) {
        if (!unavailable) emit(text);
        return;
      }
      buffered += text;
      if (looksLikeGateway(buffered)) {
        decided = true;
        unavailable = buffered.trim();
        buffered = '';
        return;
      }
      if (!couldBeGatewayPrefix(buffered)) {
        decided = true;
        const out = buffered;
        buffered = '';
        emit(out);
      }
    },
    flush() {
      if (decided) return;
      decided = true;
      const out = buffered;
      buffered = '';
      if (!out) return;
      if (looksLikeGateway(out)) {
        unavailable = out.trim();
        return;
      }
      emit(out);
    },
    /** 上游是否把正文判成了浏览器网关文案（此时不能下发）。 */
    markUnavailable(text) {
      decided = true;
      unavailable = String(text || '').trim() || '该模型当前不可用（可能需会员）';
      buffered = '';
    },
    /** 换模型重试前清空状态；只在还没下发任何内容时调用。 */
    reset() {
      buffered = '';
      decided = false;
      unavailable = '';
      roleSent = false;
      produced = false;
    },
    finish() {
      if (!roleSent) {
        roleSent = true;
        chunk({ role: 'assistant' });
      }
      chunk({}, 'stop');
    },
    produced: () => produced,
    unavailable: () => unavailable,
  };
}

function looksLikeGateway(text) {
  const s = String(text || '');
  if (s.indexOf('[492]') >= 0) return true;
  if (s.indexOf('免费使用最全最先进的模型') >= 0) return true;
  return s.indexOf('欢迎使用') >= 0 && s.indexOf('Tabbit') >= 0;
}

function couldBeGatewayPrefix(text) {
  for (const marker of GATEWAY_MARKERS) {
    if (marker.indexOf(text) === 0) return true;
  }
  return false;
}

function fail(status, message, model) {
  return { status, model: model || '', error: { status, message } };
}

/**
 * 发起对话。上游不是 OpenAI 协议，所以在这里翻译成 OpenAI chunk 行再喂 onLine。
 *
 * @returns {Promise<{status:number, headers:object, model:string, error?:object}>}
 */
async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) return fail(401, '凭证无法解析');
  if (!cred.token) return fail(401, '凭证里没有 token，请重新导入账号');

  let src;
  try {
    src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody || {};
  } catch (e) {
    return fail(400, '请求体不是合法 JSON');
  }
  const model = resolveModel(src.model);
  const prompt = buildPrompt(src);
  if (!prompt) return fail(400, '请求里没有可发送的用户消息', model);

  const sink = createSink(onLine, model);

  let result = await runTurn(cred, prompt, model, sink);
  if (result.auth) return fail(401, result.message);
  // premium 专属 / prompt 超长都会回落到免费不限量的 Default
  if (result.unavailable && model !== DEFAULT_SELECTED) {
    sink.reset();
    result = await runTurn(cred, prompt, DEFAULT_SELECTED, sink);
    if (result.auth) return fail(401, result.message);
  }

  if (result.message && !sink.produced()) {
    return fail(result.unavailable ? 429 : 502, result.message, model);
  }
  sink.finish();
  return { status: 200, headers: {}, model };
}

/** 跑一轮：建房 → join 收流。 */
async function runTurn(cred, prompt, displayName, sink) {
  const run = await createClientRun(cred, prompt, displayName);
  if (run.auth) return { auth: true, message: run.message };
  if (run.unavailable) return { unavailable: true, message: run.message };
  if (run.message) return { message: run.message };
  if (!run.roomId) return { message: 'v3 runs 未返回 room_id' };

  const traceId = crypto.randomUUID();
  const joinBody = JSON.stringify({ last_event_id: null, trace_id: traceId, request_id: traceId });

  let currentEvent = '';
  let streamError = '';
  let finished = false;

  const handleData = (event, data) => {
    if (!data) return;
    const json = safeJson(data);
    if (!json) return;
    if (event === 'error') {
      const payload = json.payload && typeof json.payload === 'object' ? json.payload : {};
      const message = String(json.message || payload.message || '上游返回错误');
      if (looksLikeGateway(message)) sink.markUnavailable(message);
      else streamError = message;
      finished = true;
      return;
    }
    if (event === 'room_reset_required') {
      finished = true;
      return;
    }
    const payload = json.payload && typeof json.payload === 'object' ? json.payload : {};
    const chunk = payload.chunk_payload && typeof payload.chunk_payload === 'object' ? payload.chunk_payload : {};
    const chunkType = String(payload.chunk_type || '');
    if (chunkType === 'content' || chunkType === 'message_chunk') {
      const text = String(chunk.content || '');
      if (text) sink.feed(text);
      return;
    }
    if (chunkType === 'thinking') {
      const text = String(chunk.reasoning_content || chunk.content || '');
      if (text) sink.feed(text);
      return;
    }
    if (event === 'message_finish' || event === 'finish' || event === 'done') finished = true;
  };

  const splitter = sse.createLineSplitter((line) => {
    if (sink.unavailable()) return;
    if (!line) {
      currentEvent = '';
      return;
    }
    if (line.charAt(0) === ':') return;
    if (line.indexOf('event:') === 0) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.indexOf('data:') !== 0) return;
    handleData(currentEvent, line.slice(5).trim());
  });

  let res;
  try {
    res = await openStream(
      {
        url: HOST + PATH_JOIN + encodeURIComponent(run.roomId) + '/join',
        headers: clientHeaders(cred, 'text/event-stream'),
        body: joinBody,
        timeout: 300000,
        maxBody: 65536,
      },
      splitter,
    );
  } catch (e) {
    return { message: `读取 v3 事件流失败：${e.message}` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { message: `join 失败（HTTP ${res.status}）：${String(res.text || '').slice(0, 200)}` };
  }

  sink.flush();
  const blocked = sink.unavailable();
  if (blocked) return { unavailable: true, message: blocked };
  if (streamError) return { message: streamError };
  if (!finished && !sink.produced()) return { message: '上游未返回任何内容' };
  return { ok: true };
}

/** `POST /api/v3/chat/runs`：扁平 body，`room_id: null` 由上游建房。 */
async function createClientRun(cred, prompt, displayName) {
  const traceId = crypto.randomUUID();
  const payload = {
    room_id: null,
    client_run_id: crypto.randomUUID(),
    client_message_id: 'local_' + Date.now(),
    agent_plan_mode_enabled: false,
    input_payload: {
      task_name: 'chat',
      content: prompt,
      parent_message_id: null,
      message_id: null,
      selected_model: displayName,
      parallel_group_id: null,
      agent_mode: false,
      metadatas: { html_content: '<p>' + prompt + '</p>', current_webpage: null },
      references: [],
      entity: { key: EMPTY_MD5, extras: { type: 'tab', url: '' } },
      page_info_list: [],
      is_mobile: true,
      trace_id: traceId,
      request_id: traceId,
    },
  };

  let res;
  try {
    res = await http.postJson(HOST + PATH_RUNS, payload, clientHeaders(cred, 'application/json'), 60000);
  } catch (e) {
    return { message: `请求 Tabbit 失败：${e.message}` };
  }
  // 409 = 房间已有一轮进行中，仍可 join 收流
  if (res.status === 200 || res.status === 409) {
    const obj = safeJson(res.text) || {};
    return { runId: String(obj.run_id || ''), roomId: String(obj.room_id || '') };
  }
  if (res.status === 401) return { auth: true, message: '登录态已失效，请重新登录' };

  const text = String(res.text || '');
  if (text.indexOf('"code":492') >= 0 || text.indexOf('"code": 492') >= 0 || res.status === 429) {
    return { unavailable: true, message: modelUnavailableMessage(text) };
  }
  return { message: `v3 runs 失败（HTTP ${res.status}）：${text.slice(0, 200)}` };
}

function modelUnavailableMessage(body) {
  const obj = safeJson(body);
  const detail = obj && obj.detail && typeof obj.detail === 'object' ? obj.detail : null;
  const detailMsg = detail ? String(detail.message || '') : '';
  const msg = detailMsg || (obj ? String(obj.message || '') : '');
  return msg || String(body || '').slice(0, 180) || '该模型当前不可用（可能需会员）';
}

/**
 * 本地流式请求：与 lib/http.stream 的差别是**等响应结束**再 resolve。
 *
 * 网关在 openChat 返回后立刻补 [DONE] 并关连接，若这里不等结束，正文会被截断；
 * 而且非 SSE 响应（登录态失效是 HTTP 200 + 业务码）必须读到正文才能判错。
 */
function openStream(opts, onChunk) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(opts.url);
    } catch (e) {
      reject(new Error(`URL 非法：${opts.url}`));
      return;
    }
    const lib = url.protocol === 'https:' ? https : httpMod;
    const headers = Object.assign({}, opts.headers || {});
    headers['Accept-Encoding'] = 'identity';

    let payload = null;
    if (opts.body !== undefined && opts.body !== null) {
      payload = Buffer.from(String(opts.body), 'utf8');
      if (!headers['Content-Length']) headers['Content-Length'] = payload.length;
    }

    const limit = opts.maxBody || 262144;
    const kept = [];
    let keptBytes = 0;

    const req = lib.request(
      {
        method: opts.method || (payload ? 'POST' : 'GET'),
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        res.on('data', (chunk) => {
          if (keptBytes < limit) {
            kept.push(chunk);
            keptBytes += chunk.length;
          }
          if (onChunk) {
            try {
              onChunk(chunk);
            } catch (e) {
              // 单块解析失败不中断整条流
            }
          }
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(kept).toString('utf8'),
          }),
        );
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('上游中断了响应')));
      },
    );

    const timeout = opts.timeout || 300000;
    const timer = setTimeout(() => req.destroy(new Error(`流式请求超时（${timeout}ms）`)), timeout);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', () => clearTimeout(timer));

    if (payload) req.write(payload);
    req.end();
  });
}

// ── 积分 ──────────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  if (!cred.userId) throw new Error('凭证里没有 user_id，请重新导入账号');

  const quota = await getJson(
    HOST +
      PATH_USAGE +
      '?user_id=' +
      encodeURIComponent(cred.userId) +
      '&timezone=' +
      encodeURIComponent('Asia/Shanghai'),
    webHeaders(cred),
  );

  let memberLevel = String(quota.member_level || '');
  try {
    const member = await getJson(
      HOST + PATH_MEMBER + '?user_id=' + encodeURIComponent(cred.userId),
      webHeaders(cred),
    );
    if (member.member_level) memberLevel = String(member.member_level);
  } catch (e) {
    // quota 里的 member_level 够展示，会员接口失败不致命
  }

  const usedText = String(quota.usage_percentage || '');
  const used = parseFloat(usedText.replace('%', '').trim());
  const remaining = Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : -1;

  const parts = [levelDisplay(memberLevel, quota.is_subscription === true)];
  if (remaining >= 0) parts.push('剩余 ' + remaining.toFixed(2) + '%');
  if (quota.current_cycle_end) parts.push('周期至 ' + quota.current_cycle_end);

  return {
    // 上游没有绝对积分，用剩余百分比取整当展示值
    credit: remaining >= 0 ? Math.floor(remaining) : 0,
    creditText: parts.join(' · '),
    raw: quota,
  };
}

function levelDisplay(memberLevel, subscription) {
  if (subscription) return '订阅会员';
  const level = String(memberLevel || '');
  if (!level) return '免费';
  const lower = level.toLowerCase();
  if (lower === 'pro') return 'Pro';
  if (lower === 'standard') return '标准';
  return level;
}

/** 账号资料：`/api/v0/user/base-info`，回退 `/proxy/v0/user/base-info`。 */
async function fetchBaseInfo(cred) {
  for (const path of [PATH_BASE_INFO, PATH_BASE_INFO_PROXY]) {
    try {
      const res = await http.get(HOST + path, webHeaders(cred), 30000);
      if (res.status < 200 || res.status >= 300) continue;
      const obj = safeJson(res.text);
      if (obj) return obj;
    } catch (e) {
      // 试下一个路径
    }
  }
  return null;
}

// ── 签到 ──────────────────────────────────────────────────────

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  if (!cred.token) return { ok: false, message: '凭证里没有 token，请重新导入账号' };

  // commerce 接口只认这个 JWT，过期必定 401；提前判掉能给出「重新登录」而不是含糊失败
  const exp = jwtExp(cred.token);
  if (exp > 0 && Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SECONDS >= exp) {
    return { ok: false, message: '登录已过期，请在 Tabbit 重新登录后重试' };
  }

  try {
    const status = await fetchSignInStatus(cred);
    if (status && status.signedToday) {
      return { ok: true, message: `今天已签到（已签 ${status.signedDays} 天）` };
    }
    if (status && !status.activityOpen) {
      return { ok: false, message: '签到活动未开放' };
    }

    const usage = await fetchUsagePercentage(cred);
    const payload = {
      request_no: 'signin_' + Date.now() + '_' + randomHex(32),
      scene_codes: ['daily_sign_in'],
      usage_percentage: usage || '0%',
    };
    const res = await http.postJson(HOST + PATH_SIGNIN, payload, webHeaders(cred), 30000);
    const obj = safeJson(res.text) || {};
    const row = Array.isArray(obj.results) ? obj.results[0] : null;
    const result = row && typeof row === 'object' ? String(row.sign_in_result || '') : '';

    if (result === 'success') return { ok: true, message: '签到成功' };
    if (result === 'already_signed') return { ok: true, message: '今天已签到' };
    if (res.status >= 200 && res.status < 300) return { ok: true, message: result || '签到成功' };
    return { ok: false, message: result || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e.message || '签到失败' };
  }
}

async function fetchSignInStatus(cred) {
  try {
    const obj = await getJson(HOST + PATH_SIGNIN_STATUS, webHeaders(cred));
    const row = Array.isArray(obj.results) ? obj.results[0] : null;
    if (!row || typeof row !== 'object') return null;
    return {
      signedToday: row.signed_today === true,
      signedDays: Number(row.signed_days || 0),
      totalSignedDays: Number(row.total_signed_days || 0),
      activityOpen: row.activity_open === true,
    };
  } catch (e) {
    return null;
  }
}

async function fetchUsagePercentage(cred) {
  if (!cred.userId) return '0%';
  try {
    const quota = await getJson(
      HOST +
        PATH_USAGE +
        '?user_id=' +
        encodeURIComponent(cred.userId) +
        '&timezone=' +
        encodeURIComponent('Asia/Shanghai'),
      webHeaders(cred),
    );
    const text = String(quota.usage_percentage || '').trim();
    return text || '0%';
  } catch (e) {
    return '0%';
  }
}

// ── 导入 ──────────────────────────────────────────────────────

/**
 * 导入 Tabbit 凭证：支持 `{cookie, userId, nickname}`、账号数组、
 * 多条 JSON 相连、每行一个 cookie / 裸 JWT。
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
      token: s.token || '',
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

    const uid = importer.resolveUid(item, secret, 'tabbit');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('tabbit', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 工具 ──────────────────────────────────────────────────────

async function getJson(url, headers) {
  const res = await http.get(url, headers, 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}：${String(res.text || '').slice(0, 160)}`);
  }
  const obj = safeJson(res.text);
  if (!obj) throw new Error('上游返回了非 JSON 响应');
  return obj;
}

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
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function randomHex(length) {
  const chars = '0123456789abcdefABCDEF';
  let out = '';
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
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
  id: 'tabbit',
  displayName: 'Tabbit',
  authKind: 'SMS_CODE',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  importCredentials,

  // 供页面/排查用
  fetchBaseInfo,
};
