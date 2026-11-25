'use strict';

/**
 * 秒悟（meoo.com）。
 *
 * 鉴权：meoo.com 下发的会话 cookie（阿里云账号体系），服务端不校验签名头、也没有 CSRF token。
 *       基址必须是不带 www 的 meoo.com —— www.meoo.com 的证书链会 SSL 失败。
 * 对话：不是 chat/completions，而是三步：
 *   1) POST /api/assistant/start  {message}          → data.sessionId / data.taskId
 *   2) GET  /api/assistant/query?sessionId=X         → text/event-stream
 *   3) POST /api/assistant/stop   {sessionId}        → 收尾，失败忽略
 *   正文在 ui_event / ui:agent_message_update 的 data.delta 里。
 * 积分：GET /api/mc/entitlement/get（驼峰字段）。
 * 签到：GET /api/mc/entitlement/init —— 当日首次调用才入账，重复调用返回
 *       dailyLoginSkipReason=ALREADY_GRANTED_TODAY。
 */

const https = require('https');

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const HOST = 'https://meoo.com';

const PATH_USER_INFO = '/api/v1/user/me';
const PATH_MODELS = '/api/v1/agent/models';
const PATH_ASSISTANT_START = '/api/assistant/start';
const PATH_ASSISTANT_QUERY = '/api/assistant/query';
const PATH_ASSISTANT_STOP = '/api/assistant/stop';
const PATH_ENTITLEMENT_GET = '/api/mc/entitlement/get';
const PATH_ENTITLEMENT_INIT = '/api/mc/entitlement/init';

const DEFAULT_MODEL = 'qwen3.7-plus';

// 登录页固定带邀请码（与 App 版一致），重定向参数上游用不上
const LOGIN_URL = HOST + '/?inviteCode=RMYr87BQ';

const REQUEST_TIMEOUT_MS = 60000;
// 事件流的空闲超时：上游会定期发心跳注释帧，空闲到这个时长说明连接已死
const TURN_IDLE_MS = 300000;

// 与 web 端保持一致的 UA：上游对 UA 敏感，换版本可能被判成异常会话
const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

// ── 请求头 ────────────────────────────────────────────────────

function webHeaders(cred, accept) {
  const h = {
    Accept: accept || 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: HOST,
    Referer: HOST + '/',
  };
  if (cred && cred.cookie) h.Cookie = cred.cookie;
  return h;
}

function streamHeaders(cred) {
  const h = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    // 事件流必须逐块读，不能让他压缩缓冲
    'Accept-Encoding': 'identity',
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: HOST,
    Referer: HOST + '/',
  };
  if (cred && cred.cookie) h.Cookie = cred.cookie;
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const cookie = String(obj.cookie || '').trim();
  if (!cookie) return null;
  return {
    cookie,
    // secret 里写的是 userId（App 版字段名），兼容 uid
    uid: String(obj.userId || obj.uid || (account && account.uid) || ''),
    nickname: String(obj.nickname || (account && account.nickname) || ''),
  };
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const model = String(requested || '').trim();
  return model || DEFAULT_MODEL;
}

/** 上游目录拉不到时的兜底（实测 15 个）。 */
const FALLBACK_MODELS = [
  ['auto', '智能路由'],
  ['qwen3.8-flash', 'Qwen3.8-Flash'],
  ['qwen3.8-max-0902', 'Qwen3.8-Max-0902'],
  ['qwen3.8-max', 'Qwen3.8-Max'],
  ['qwen3.7-max', 'Qwen3.7-Max'],
  ['qwen3.7-plus', 'Qwen3.7-Plus'],
  ['deepseekV41Flash', 'DeepSeek-V4.1-Flash'],
  ['deepseekV4Pro', 'DeepSeek-V4-Pro'],
  ['deepseekV4Flash', 'DeepSeek-V4-Flash'],
  ['kimi-k3', 'Kimi-K3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['bigmodel', 'BigModel'],
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.2-fast-preview', 'GLM-5.2-Fast-Preview'],
  ['glm5.2', 'GLM-5.2'],
];

function fallbackModels() {
  return FALLBACK_MODELS.map((pair) => ({
    id: pair[0],
    name: pair[1],
    contextWindow: 0,
    supportsTools: false,
    supportsReasoning: false,
  }));
}

/**
 * 模型目录：`/api/v1/agent/models`（免登录也能取，所以没有账号也试一次）。
 * data.models[] 用 key/label/provider，其它字段（图标、特性）对网关无用。
 */
async function fetchModels(account) {
  const cred = parse(account);
  try {
    const res = await http.get(HOST + PATH_MODELS, webHeaders(cred), 30000);
    if (res.status >= 200 && res.status < 300) {
      const obj = safeJson(res.text);
      const data = obj && obj.data && typeof obj.data === 'object' ? obj.data : null;
      const items = data && Array.isArray(data.models) ? data.models : [];
      const seen = new Set();
      const out = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.key || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: String(item.label || '').trim() || id,
          contextWindow: 0,
          // 助手接口不接受 tools，也没有可用的上下文窗口元数据
          supportsTools: false,
          supportsReasoning: false,
        });
      }
      if (out.length > 0) return out;
    }
  } catch (e) {
    // 目录失败退兜底清单，不能让它连带把 /v1/models 拖成空
  }
  return fallbackModels();
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 事件流读取。
 *
 * 没用 lib/http 的 stream：它在响应头阶段就 resolve，拿不到上游关流的时机，
 * 而这里必须等流结束才能决定是正常收尾还是报错（以及何时发 [DONE]）。
 */
function readEventStream(url, headers, idleMs, onChunk) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    // 空闲超时而非总时长：长回答可能超过任何固定上限，只要还有数据在来就不该掐断
    const arm = (req) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          req.destroy();
        } catch (e) {
          // 已结束
        }
        finish({ status: 0, error: '助手事件流空闲超时（' + idleMs + 'ms 无数据）' });
      }, idleMs);
    };

    let target;
    try {
      target = new URL(url);
    } catch (e) {
      finish({ status: 0, error: 'URL 非法：' + url });
      return;
    }

    const req = https.request(
      {
        method: 'GET',
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        res.setEncoding('utf8');
        if (status < 200 || status >= 300) {
          // 错误体是 JSON，读一小段足够定位原因
          let raw = '';
          res.on('data', (chunk) => {
            if (raw.length < 2048) raw += chunk;
          });
          res.on('end', () => finish({ status, error: 'HTTP ' + status + '：' + raw.slice(0, 200) }));
          res.on('error', (e) => finish({ status, error: e.message }));
          return;
        }
        res.on('data', (chunk) => {
          arm(req);
          try {
            onChunk(chunk);
          } catch (e) {
            // 单帧解析失败不该中断整轮
          }
        });
        res.on('end', () => finish({ status, headers: res.headers }));
        res.on('error', (e) => finish({ status, error: '读取助手事件流失败：' + e.message }));
      },
    );

    arm(req);

    req.on('error', (e) => finish({ status: 0, error: '订阅助手事件流失败：' + e.message }));
    req.end();
  });
}

function frameMessage(frame) {
  const data = frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
  return String(data.message || (frame && frame.message) || '上游返回错误');
}

/** 思考过程字段在不同版本里叫法不一，取到哪个算哪个。 */
function reasoningText(data) {
  const keys = ['reasoningContent', 'reasoning_content', 'reasoning'];
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * 一轮事件的解析器：把上游帧翻成 OpenAI chunk 行交给 onLine。
 *
 * 上游帧类型：connected / task_id / task_complete / error / ui_event；
 * 正文在 ui_event.data.type === 'ui:agent_message_update' 的 data.delta（增量），
 * data.fullContent 为 true 时 data.content 是整段内容；
 * ui:sync_assistant_response / ui:sync_assistant_update 的 content 也是整段。
 * 心跳是 SSE 注释帧（`:` 开头），由 dataPayload 过滤。
 */
function createTurn(onLine) {
  let emitted = '';
  let produced = false;
  let finished = false;
  let failure = '';

  function chunk(delta) {
    onLine(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: null }],
        }),
    );
  }

  function pushContent(text) {
    if (!text) return;
    produced = true;
    chunk({ content: text });
  }

  // 整段帧是替换语义：整段转发会让客户端把已有内容再拼一遍，只补已发内容之后的增量
  function pushFull(text) {
    const next = String(text === undefined || text === null ? '' : text);
    if (!next) return;
    if (next.slice(0, emitted.length) === emitted) {
      const suffix = next.slice(emitted.length);
      emitted = next;
      pushContent(suffix);
      return;
    }
    // 上游改写了历史（重生成等），补发会重复、不回补会留下旧前缀，这里按不重复处理
    emitted = next;
  }

  function handleFrame(frame) {
    const type = String(frame.type || '');
    if (type === 'connected' || type === 'task_id') return;
    if (type === 'task_complete') {
      finished = true;
      return;
    }
    if (type === 'error') {
      failure = frameMessage(frame);
      finished = true;
      return;
    }
    if (type !== 'ui_event') return;

    const event = frame.data && typeof frame.data === 'object' ? frame.data : {};
    const eventType = String(event.type || '');
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    if (eventType === 'ui:agent_message_update') {
      const delta = String(data.delta === undefined || data.delta === null ? '' : data.delta);
      if (delta) {
        emitted += delta;
        pushContent(delta);
        return;
      }
      const reasoning = reasoningText(data);
      if (reasoning) {
        chunk({ reasoning_content: reasoning });
        return;
      }
      if (data.fullContent === true) pushFull(data.content);
      return;
    }
    if (eventType === 'ui:sync_assistant_response' || eventType === 'ui:sync_assistant_update') {
      pushFull(data.content);
    }
  }

  function feed(line) {
    if (finished) return;
    const payload = sse.dataPayload(line);
    if (!payload) return;
    const frame = sse.safeJson(payload);
    if (!frame || typeof frame !== 'object') return;
    handleFrame(frame);
  }

  return {
    feed,
    produced: () => produced,
    failure: () => failure,
  };
}

/** 启动一轮对话：`POST /api/assistant/start {message}`。 */
async function startAssistant(cred, prompt, model) {
  let res;
  try {
    res = await http.postJson(
      HOST + PATH_ASSISTANT_START,
      { message: prompt },
      webHeaders(cred),
      REQUEST_TIMEOUT_MS,
    );
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: '启动助手会话失败：' + e.message } };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 401,
      model,
      error: { status: 401, message: '秒悟登录态已失效，请重新登录' },
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      status: res.status,
      model,
      error: {
        status: res.status,
        message: '启动助手会话失败（HTTP ' + res.status + '）：' + String(res.text || '').slice(0, 160),
      },
    };
  }

  const obj = safeJson(res.text);
  if (!obj) {
    return { status: 502, model, error: { status: 502, message: '启动助手会话返回了非 JSON 响应' } };
  }
  const biz = businessError(obj);
  if (biz) return { status: biz.status, model, error: { status: biz.status, message: biz.message } };

  const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const sessionId = String(data.sessionId || obj.sessionId || '').trim();
  const taskId = String(data.taskId || obj.taskId || '').trim();
  if (!sessionId) {
    return {
      status: 502,
      model,
      error: {
        status: 502,
        message: '上游未返回 sessionId（data keys=' + Object.keys(data).join(',') + '）',
      },
    };
  }
  return { sessionId, taskId, model };
}

/** 中止会话：`POST /api/assistant/stop`，失败忽略（会话到点自己也会回收）。 */
function stopAssistant(cred, sessionId) {
  if (!sessionId) return;
  http
    .postJson(HOST + PATH_ASSISTANT_STOP, { sessionId }, webHeaders(cred), 15000)
    .catch(() => {});
}

/** messages → 单条 prompt：秒悟助手是无状态单轮，历史只能拼进文本。 */
function buildPrompt(messages) {
  if (!Array.isArray(messages)) return '';
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
  return parts.join('\n\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'text' || type === 'input_text') out.push(String(part.text || ''));
    }
    return out.join('');
  }
  return '';
}

/**
 * 发起对话，逐行回调（OpenAI chunk 形状）。
 *
 * 上游只有流式，非流式由网关侧聚合，所以这里始终按流处理。
 */
async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) {
    return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };
  }

  const src = typeof openAiBody === 'string' ? safeJson(openAiBody) : openAiBody;
  if (!src || typeof src !== 'object') {
    return { status: 400, model: '', error: { status: 400, message: '请求体不是合法 JSON' } };
  }

  const model = resolveModel(src.model);
  const prompt = buildPrompt(src.messages);
  if (!prompt) {
    return {
      status: 400,
      model,
      error: { status: 400, message: '请求里没有可发送的用户消息' },
    };
  }

  const started = await startAssistant(cred, prompt, model);
  if (started.error) return started;

  const turn = createTurn(onLine);
  const splitter = sse.createLineSplitter(turn.feed);
  const url = HOST + PATH_ASSISTANT_QUERY + '?sessionId=' + encodeURIComponent(started.sessionId);
  const stream = await readEventStream(url, streamHeaders(cred), TURN_IDLE_MS, splitter);

  stopAssistant(cred, started.sessionId);

  if (!turn.produced()) {
    let status = 502;
    let message = turn.failure() || stream.error || '上游未返回任何内容';
    if (stream.status === 401 || stream.status === 403) {
      status = 401;
      message = '订阅助手事件流被拒（HTTP ' + stream.status + '），登录态可能已失效';
    } else if (stream.status >= 400) {
      status = stream.status;
    }
    return { status, model, error: { status, message } };
  }

  // 已经有正文时照常收尾：上游偶发断流不该让客户端认为整轮失败
  onLine('data: [DONE]');
  return { status: 200, model, headers: stream.headers || {} };
}

// ── 用户信息 ──────────────────────────────────────────────────

/**
 * `/api/v1/user/me`。注意返回字段是**下划线**命名（user_id / username / phone / uk），
 * 未登录时 data 为 null。
 */
async function fetchUserInfo(cred) {
  const res = await http.get(HOST + PATH_USER_INFO, webHeaders(cred), 30000);
  if (res.status === 401 || res.status === 403) throw new Error('秒悟登录态已失效，请重新登录');
  if (res.status < 200 || res.status >= 300) throw new Error('用户信息接口 HTTP ' + res.status);
  const obj = safeJson(res.text);
  if (!obj) throw new Error('用户信息接口返回了非 JSON 响应');
  const biz = businessError(obj);
  if (biz) throw new Error(biz.message);
  const data = obj.data;
  if (!data || typeof data !== 'object') throw new Error('登录态已失效或未登录');
  return data;
}

// ── 积分 ──────────────────────────────────────────────────────

function formatDate(raw) {
  const text = String(raw || '');
  return text.indexOf('T') === 10 ? text.slice(0, 10) : text;
}

/**
 * 积分：`/api/mc/entitlement/get`。
 * data.userPointInfo.account.availableBalance = 可用积分；
 * data.userPointInfo.activeGrants[] 每笔 sourceTypeName + grantDetails[].expiresDate；
 * data.planCode = 套餐代号。9999 开头的到期时间是永久，不算。
 */
async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');

  const res = await http.get(HOST + PATH_ENTITLEMENT_GET, webHeaders(cred), 30000);
  if (res.status === 401 || res.status === 403) throw new Error('秒悟登录态已失效，请重新登录');
  if (res.status < 200 || res.status >= 300) throw new Error('积分接口 HTTP ' + res.status);
  const obj = safeJson(res.text);
  if (!obj) throw new Error('积分接口返回了非 JSON 响应');
  const biz = businessError(obj);
  if (biz) throw new Error(biz.message);

  const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
  if (!data) return { credit: 0, creditText: '上游未返回积分' };

  const pointInfo = data.userPointInfo && typeof data.userPointInfo === 'object' ? data.userPointInfo : {};
  const acct = pointInfo.account && typeof pointInfo.account === 'object' ? pointInfo.account : null;
  const planCode = String(data.planCode || '');

  let balance = -1;
  if (acct && acct.availableBalance !== undefined && acct.availableBalance !== null) {
    const n = Number(acct.availableBalance);
    if (Number.isFinite(n)) balance = n;
  }

  const grants = [];
  let earliest = '';
  const activeGrants = Array.isArray(pointInfo.activeGrants) ? pointInfo.activeGrants : [];
  for (const grant of activeGrants) {
    if (!grant || typeof grant !== 'object') continue;
    const remaining = Number(grant.totalRemainingAmount || 0) || 0;
    const details = Array.isArray(grant.grantDetails) ? grant.grantDetails : [];
    let expiry = '';
    for (const detail of details) {
      if (!detail || typeof detail !== 'object') continue;
      const exp = String(detail.expiresDate || '').trim();
      if (!exp || exp.indexOf('9999') === 0) continue;
      if (!expiry || exp < expiry) expiry = exp;
      if (!earliest || exp < earliest) earliest = exp;
    }
    grants.push({
      name: String(grant.sourceTypeName || grant.sourceType || ''),
      remaining,
      expiresAt: expiry,
    });
  }

  if (balance < 0 && !planCode) {
    return { credit: 0, creditText: '上游未返回积分', grants };
  }

  const credit = balance > 0 ? balance : 0;
  let creditText = planCode ? credit + '（' + planCode + '）' : String(credit);
  if (earliest) creditText += ' · ' + formatDate(earliest) + ' 到期';

  return { credit, creditText, planCode, expiresAt: earliest, grants };
}

// ── 签到 ──────────────────────────────────────────────────────

/**
 * 每日登录奖励：`/api/mc/entitlement/init`。
 * 这个 GET 本身就是发奖动作，当日首次调用入账；重复调用是幂等的跳过。
 */
async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };

  let res;
  try {
    res = await http.get(HOST + PATH_ENTITLEMENT_INIT, webHeaders(cred), 30000);
  } catch (e) {
    return { ok: false, message: e.message || '签到失败' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: '秒悟登录态已失效，请重新登录' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: '签到接口 HTTP ' + res.status };
  }
  const obj = safeJson(res.text);
  if (!obj) return { ok: false, message: '签到接口返回了非 JSON 响应' };
  const biz = businessError(obj);
  if (biz) return { ok: false, message: biz.message };

  const data = obj.data && typeof obj.data === 'object' ? obj.data : null;
  if (!data) return { ok: false, message: '上游未返回领取结果' };

  const granted = data.dailyLoginGranted === true;
  const amount = Number(data.dailyLoginGrantAmount || 0) || 0;
  const skip = String(data.dailyLoginSkipReason || '');

  if (granted) {
    return {
      ok: true,
      message: amount > 0 ? '领取成功，获得 ' + amount + ' 积分' : '领取成功',
      gained: amount > 0 ? amount : 0,
    };
  }
  if (skip === 'ALREADY_GRANTED_TODAY') return { ok: true, message: '今天已经领取过啦' };
  if (skip) return { ok: false, message: skip };
  return { ok: true, message: '今天已经领取过啦' };
}

// ── 登录 ──────────────────────────────────────────────────────

/** 登录页固定带邀请码；秒悟靠 cookie 轮询完成登录，不走回调 URL。 */
function loginUrl() {
  return LOGIN_URL;
}

/** 用 cookie 校验并生成账号；登录态无效时抛错。 */
async function accountFromCookie(cookie) {
  const text = String(cookie || '').trim();
  if (!text) throw new Error('cookie 为空');
  const info = await fetchUserInfo({ cookie: text, uid: '', nickname: '' });

  // uid 决定账号在池里的主键（同 uid 互相覆盖），必须是稳定且唯一的。
  // 优先 user_id（服务端主键），其次 open_id / uk。
  // 不能用 cookie 尾巴：oneday_sid / login_oneday_ticket 会随会话轮换。
  const uid = pickText(info, ['user_id', 'userId', 'open_id', 'uk']) || 'meoo-' + hashShort(text);
  const display =
    pickText(info, ['username', 'nickname', 'phone', 'email']) || '账号 ' + uid.slice(-6);

  const secret = JSON.stringify({ cookie: text, userId: uid, nickname: display });
  return makeAccount('meoo', uid, display, secret);
}

// ── 导入凭证 ──────────────────────────────────────────────────

/**
 * 导入：App 导出的账号 JSON（单个 / 数组 / {accounts:[...]} / 多条相连）或裸 cookie 串。
 *
 * 这里必须同步返回数组（dist/main.js 是同步调的），所以不能像 accountFromCookie
 * 那样打一次 /api/v1/user/me 去取 server uid；JSON 里带 userId 就用它，
 * 否则退化成 cookie 指纹。需要校验登录态时走 accountFromCookie。
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

    const uid = importer.resolveUid(item, secret, 'meoo');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('meoo', uid, nickname, JSON.stringify(built), extraOf(built)));
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

/**
 * 统一业务错误判定：`{success, error|errCode}`。
 * NEED_LOGIN / LOGIN_INVALID / UNAUTHORIZED 归到 401 让它触发账号轮换。
 */
function businessError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.success !== false) return null;
  const error = obj.error && typeof obj.error === 'object' ? obj.error : {};
  const code = String(error.code || obj.errCode || '');
  const message = String(error.message || obj.message || '上游返回错误（' + code + '）');
  if (code === 'NEED_LOGIN' || code === 'LOGIN_INVALID' || code === 'UNAUTHORIZED') {
    return { status: 401, message };
  }
  return { status: 502, message };
}

/** 按下标取第一个非空字段；JSON null 也当缺失（直接 toString 会得到 "null"）。 */
function pickText(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const text = String(v).trim();
    if (text && text !== 'null') return text;
  }
  return '';
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
    // 多条 JSON 相连：按花括号配平逐个切
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
  id: 'meoo',
  displayName: '秒悟',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  loginUrl,
  accountFromCookie,
  importCredentials,
};
