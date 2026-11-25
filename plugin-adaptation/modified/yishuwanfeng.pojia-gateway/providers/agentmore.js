'use strict';

/**
 * 智谱清言（AgentMore，agentmore.chatglm.cn）。
 *
 * 与智谱（AutoClaw）不是同一套协议：
 *  - 全局签名头复刻 Web 端拦截器：`X-Timestamp`（13 位毫秒 + 校验位）、
 *    `X-Nonce`/`X-Request-Id`（UUID4 去横杠）、`X-Sign = MD5("{ts}-{nonce}-{salt}")`，
 *    时间基准取自 `/chatglm/operation-api/config/cur_ts`（只校一次，失败用本机时钟）；
 *  - 响应信封 `{status: 0|200, result, message}`；
 *  - 对话是**有状态会话**：agent → conversation_id → 每轮只发本轮输入。
 *
 * 登录走 WebView：cookie 里的 `chatglm_token` / `chatglm_refresh_token`
 * 配上 localStorage 的 `chatglm-deid` 即构成一份凭证。
 */

const crypto = require('crypto');
const importer = require('../lib/importer');
const https = require('https');
const httpNative = require('http');
const { URL } = require('url');

const http = require('../lib/http');
const accounts = require('../lib/accounts');
const registry = require('../lib/registry');
const { makeAccount, parseSecret } = accounts;
const { CAP } = registry;

const BASE = 'https://agentmore.chatglm.cn';
const LOGIN_URL = BASE + '/';

const PATH_CUR_TS = '/chatglm/operation-api/config/cur_ts';
const PATH_REFRESH = '/chatglm/user-api/user/refresh';
const PATH_USER_INFO = '/chatglm/user-api/user/info';
const PATH_OPERATION_DETAIL = '/chatglm/agent-api/operation/detail?tag=available_models';
const PATH_TASK_CENTER = '/chatglm/agent-api/task/center';
const PATH_TASK_COMPLETE = '/chatglm/agent-api/task/complete';
const PATH_DAILY_LOGIN_SCORE = '/chatglm/member-api/member/daily_login_score';
const PATH_PROJECT_LIST = '/chatglm/agent-api/project/list?page=1&page_size=30';
const PATH_CONVERSATION = '/chatglm/agent-api/conversation';
const PATH_CHAT_STREAM = '/chatglm/agent-api/stream';

// Web 端内嵌常量，别改
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';
const APP_VERSION = '0.0.1';
// 上游按 UA 判来源：非浏览器 UA（Java/Dalvik/Python）一律 400 bad request(40002)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const DEFAULT_MODEL = 'glm-5.3-flash';
const TASK_STATUS_COMPLETED = 3;
const REFRESH_SKEW_SECONDS = 300;

const REQUEST_TIMEOUT = 20000;
const TIME_SYNC_TIMEOUT = 3000;
const CHAT_TIMEOUT = 180000;
const CATALOG_TTL = 5 * 60 * 1000;

const STATIC_MODELS = [
  { id: 'glm-5.3-flash', label: 'GLM-Flash', features: ['reasoning'] },
  { id: 'glm-5.3', label: 'GLM-5.3', features: ['reasoning'] },
];

// ── 工具 ──────────────────────────────────────────────────────

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function md5Hex(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function uuid4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20)
  );
}

function newUuidHex() {
  return uuid4().replace(/-/g, '');
}

function newCallId() {
  return 'call_' + newUuidHex().slice(0, 24);
}

function formatNumber(value) {
  if (value === null || value === undefined) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n % 1 === 0 && Math.abs(n) < 9007199254740992) return String(n);
  return String(n);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function apiError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function log(level, message) {
  accounts.log(level, message);
}

// ── 时间校准 ──────────────────────────────────────────────────

// 服务器时间 - 本机时间；校准失败保持 0。Web 端也只校一次。
let timeOffsetMs = 0;
let timeSyncAttempted = false;
let timeSyncPromise = null;

async function syncTimeIfNeeded() {
  if (timeSyncAttempted) return;
  if (timeSyncPromise) return timeSyncPromise;
  timeSyncPromise = (async () => {
    timeSyncAttempted = true;
    const startedAt = Date.now();
    try {
      // cur_ts 是签名时间的基准来源，自身不带签名头
      const res = await http.get(BASE + PATH_CUR_TS, { 'User-Agent': BROWSER_UA }, TIME_SYNC_TIMEOUT);
      if (res.status < 200 || res.status >= 300) return;
      const obj = safeJson(res.text);
      const serverMs = Number((obj && obj.result && obj.result.timestamp_ms) || 0);
      if (serverMs > 0) {
        const rtt = Date.now() - startedAt;
        timeOffsetMs = serverMs + Math.floor(rtt / 2) - Date.now();
      }
    } catch (e) {
      // 校时失败就用本机时钟
    } finally {
      timeSyncPromise = null;
    }
  })();
  return timeSyncPromise;
}

function calibratedNow() {
  return Date.now() + timeOffsetMs;
}

/**
 * 13 位毫秒 → 上游形态：倒数第 2 位替换成校验位（除该位外其余数字之和 % 10）。
 */
function makeTimestamp(now) {
  const text = String(now);
  if (text.length < 3) return text;
  const digits = text.split('').map((c) => Number(c));
  let sum = 0;
  for (const d of digits) sum += d;
  const check = (sum - digits[digits.length - 2]) % 10;
  return text.slice(0, text.length - 2) + check + text.slice(text.length - 1);
}

function signedHeaders(deviceId, requestId) {
  const timestamp = makeTimestamp(calibratedNow());
  const nonce = newUuidHex();
  return {
    'Content-Type': 'application/json;charset=utf-8',
    'App-Name': 'chatglm',
    'X-Device-Id': deviceId,
    'X-Request-Id': requestId || newUuidHex(),
    'X-App-Platform': 'pc',
    'X-App-Version': APP_VERSION,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': md5Hex(timestamp + '-' + nonce + '-' + SIGN_SALT),
    'User-Agent': BROWSER_UA,
  };
}

// ── JWT ──────────────────────────────────────────────────────

function jwtPayload(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length < 2 || !parts[1]) return null;
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

function jwtExpiry(token) {
  const payload = jwtPayload(token);
  if (!payload) return 0;
  const n = Number(payload.exp || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function jwtUid(token) {
  const payload = jwtPayload(token);
  if (!payload) return '';
  for (const key of ['_id', 'user_id', 'userId', 'uid', 'sub']) {
    const v = payload[key];
    if (v !== undefined && v !== null && String(v)) return String(v);
  }
  return '';
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const accessToken = String(obj.accessToken || obj.access_token || '').trim();
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: String(obj.refreshToken || obj.refresh_token || '').trim(),
    deviceId: String(obj.deviceId || obj.device_id || '').trim(),
    expiresAt: Number(obj.expiresAt || 0) || jwtExpiry(accessToken),
    userId: String(obj.userId || obj.user_id || '').trim(),
    uid: String(account.uid || ''),
  };
}

function secretOf(cred) {
  return JSON.stringify({
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken || '',
    deviceId: cred.deviceId || '',
    expiresAt: Number(cred.expiresAt || 0) || jwtExpiry(cred.accessToken),
    userId: cred.userId || '',
  });
}

function persist(account) {
  try {
    accounts.saveAll(registry.listAccounts());
  } catch (e) {
    log('warn', '智谱清言凭证落盘失败：' + e.message);
  }
}

/**
 * 取凭证并保证有稳定的 deviceId。
 *
 * deviceId 是账号级设备指纹，每个请求现生成会让上游当成新设备；
 * 首次补出来后就写回 secret 落盘。
 */
function requireCred(account) {
  const cred = parse(account);
  if (!cred) return null;
  if (!cred.deviceId) {
    cred.deviceId = newUuidHex();
    account.secret = secretOf(cred);
    persist(account);
  }
  return cred;
}

// ── HTTP ──────────────────────────────────────────────────────

async function apiRequest(method, path, opts) {
  const o = opts || {};
  await syncTimeIfNeeded();
  const headers = signedHeaders(o.deviceId || '', o.requestId);
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  const url = String(path).indexOf('http') === 0 ? path : BASE + path;
  const res = await http.request({
    method,
    url,
    headers,
    body: method === 'POST' ? (o.body === undefined ? '' : o.body) : null,
    timeout: o.timeout || REQUEST_TIMEOUT,
  });
  return { status: res.status, obj: safeJson(res.text), text: res.text };
}

/** 信封校验：status 为 0/200 且有 result 才算成功。 */
function envelopeResult(payload, what) {
  const obj = payload || {};
  const status = Number(obj.status === undefined ? -1 : obj.status);
  const result = obj.result && typeof obj.result === 'object' ? obj.result : null;
  if ((status === 0 || status === 200) && result) return result;
  const message = String(obj.message || '').trim() || 'status=' + status;
  throw apiError('upstream', what + '失败：' + message);
}

function isAuthRejected(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  const code = Number((res.obj && res.obj.status) || 0);
  return code === 401 || code === 403;
}

// ── 刷新（单飞 + 临期判定）────────────────────────────────────

const refreshLocks = new Map();

function isExpiring(cred) {
  const expiry = Number(cred.expiresAt || 0) || jwtExpiry(cred.accessToken);
  if (!expiry) return false;
  return expiry - Math.floor(Date.now() / 1000) <= REFRESH_SKEW_SECONDS;
}

/**
 * 刷新：`Authorization` 带的是 **refresh_token**（与常规相反），body 为空。
 * refresh_token 是否轮换上游没写死，所以拿到新值就换、没给就沿用旧的。
 */
async function callRefresh(cred) {
  const res = await apiRequest('POST', PATH_REFRESH, {
    token: cred.refreshToken,
    deviceId: cred.deviceId,
    body: '',
  });
  if (res.status === 401 || res.status === 403) {
    throw apiError('token_rejected', '登录态已失效，请重新登录');
  }
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '刷新失败（HTTP ' + res.status + '）');
  }
  const result = envelopeResult(res.obj, '刷新');
  const accessToken = String(result.access_token || '').trim();
  if (!accessToken) throw apiError('upstream', '刷新成功但上游没有返回 access_token');
  return {
    accessToken,
    refreshToken: String(result.refresh_token || '').trim() || cred.refreshToken,
  };
}

function refreshOnce(account, reason) {
  const key = String(account.uid || '') || 'agentmore-anonymous';
  const running = refreshLocks.get(key);
  if (running) return running;

  const task = (async () => {
    const cred = parse(account);
    if (!cred || !cred.refreshToken) return null;
    try {
      const next = await callRefresh(cred);
      const merged = {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken || cred.refreshToken,
        deviceId: cred.deviceId,
        expiresAt: jwtExpiry(next.accessToken),
        userId: cred.userId || jwtUid(next.accessToken),
        uid: cred.uid,
      };
      account.secret = secretOf(merged);
      persist(account);
      log('info', '智谱清言凭证已刷新（' + reason + '）');
      return parse(account) || merged;
    } catch (e) {
      log('warn', '智谱清言凭证刷新失败（' + reason + '）：' + e.message);
      return null;
    } finally {
      refreshLocks.delete(key);
    }
  })();

  refreshLocks.set(key, task);
  return task;
}

async function withAuth(account, run) {
  let cred = requireCred(account);
  if (!cred) throw apiError('token_rejected', '凭证无法解析');
  if (cred.refreshToken && isExpiring(cred)) {
    cred = (await refreshOnce(account, '临期')) || cred;
  }
  let res = await run(cred);
  if (!isAuthRejected(res)) return res;

  if (cred.refreshToken) {
    const current = parse(account);
    let next = current;
    if (!current || current.accessToken === cred.accessToken) {
      next = (await refreshOnce(account, '登录态被拒')) || cred;
    }
    if (next && next.accessToken !== cred.accessToken) {
      cred = next;
      res = await run(cred);
    }
  }
  if (isAuthRejected(res)) throw apiError('token_rejected', '登录态已失效，请重新登录');
  return res;
}

// ── 模型 ──────────────────────────────────────────────────────

let remoteModels = [];
let remoteAt = 0;

function catalog() {
  return remoteModels.length > 0 ? remoteModels : STATIC_MODELS;
}

function normalizeRemote(result) {
  const array = result && Array.isArray(result.models) ? result.models : [];
  const out = [];
  for (const raw of array) {
    if (!raw || typeof raw !== 'object') continue;
    const selected = String(raw.selected_model || '').trim();
    if (!selected) continue;
    // am_switch 是 AgentMore 场景开关，显式关闭的不下发
    if (raw.am_switch !== undefined && raw.am_switch === false) continue;
    const efforts = Array.isArray(raw.reasoning_efforts) ? raw.reasoning_efforts : [];
    const features = [];
    if (efforts.length > 0) features.push('reasoning');
    out.push({
      id: selected,
      label: String(raw.display_name || '').trim() || selected,
      features,
    });
  }
  return out;
}

async function refreshCatalog(account) {
  const res = await withAuth(account, (cred) =>
    apiRequest('GET', PATH_OPERATION_DETAIL, { token: cred.accessToken, deviceId: cred.deviceId }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '模型目录返回 HTTP ' + res.status);
  }
  const result = envelopeResult(res.obj, '模型目录');
  const list = normalizeRemote(result);
  if (list.length > 0) {
    remoteModels = list;
    remoteAt = Date.now();
  }
  return list;
}

function resolveSelectedModel(requested) {
  const name = String(requested || '').trim();
  if (!name) return DEFAULT_MODEL;
  const lower = name.toLowerCase();
  const hit = catalog().find((m) => String(m.id).toLowerCase() === lower);
  return hit ? hit.id : DEFAULT_MODEL;
}

/** 对外模型名：只认目录内命中的 selected_model，未命中回落默认。 */
function resolveModel(requested) {
  return resolveSelectedModel(requested);
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw apiError('token_rejected', '凭证无法解析');
  if (remoteModels.length === 0 || Date.now() - remoteAt >= CATALOG_TTL) {
    try {
      await refreshCatalog(account);
    } catch (e) {
      log('warn', '智谱清言模型目录刷新失败：' + e.message);
    }
  }
  return catalog().map((m) => ({
    id: m.id,
    name: m.label,
    contextWindow: 0,
    supportsTools: false,
    supportsReasoning: (m.features || []).indexOf('reasoning') >= 0,
  }));
}

// ── 用户信息 / 积分 ───────────────────────────────────────────

async function fetchUserInfo(account) {
  const res = await withAuth(account, (cred) =>
    apiRequest('GET', PATH_USER_INFO, { token: cred.accessToken, deviceId: cred.deviceId }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '用户信息失败（HTTP ' + res.status + '）');
  }
  return envelopeResult(res.obj, '用户信息');
}

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw apiError('token_rejected', '凭证无法解析');
  const result = await fetchUserInfo(account);
  const member = result.member_info && typeof result.member_info === 'object' ? result.member_info : {};
  const total = numberOrNull(member.left_score);
  return {
    credit: total === null ? -1 : total,
    creditText: formatNumber(total),
    raw: { userId: String(result._id || ''), isGuest: result.is_guest === true, left: total },
  };
}

// ── 任务中心 / 签到 ───────────────────────────────────────────

function isInviteRelated(id, text) {
  if (String(id || '').toLowerCase().indexOf('invite') >= 0) return true;
  return String(text || '').indexOf('邀请') >= 0;
}

function parseTaskCenter(result) {
  const categories = result && Array.isArray(result.categories) ? result.categories : [];
  const out = [];
  for (const category of categories) {
    if (!category || typeof category !== 'object') continue;
    if (isInviteRelated(category.code, category.name)) continue;
    const tasks = Array.isArray(category.tasks) ? category.tasks : [];
    for (const item of tasks) {
      if (!item || typeof item !== 'object') continue;
      const taskId = String(item.task_id || '').trim();
      if (!taskId) continue;
      // App 内完成的任务网页端不展示，这里同口径跳过
      if (String(item.platform || '').trim() === 'app') continue;
      if (isInviteRelated(taskId, item.title)) continue;
      const reward = item.reward && typeof item.reward === 'object' ? item.reward : {};
      out.push({
        taskId,
        title: String(item.title || '').trim(),
        description: String(item.description || '').trim(),
        rewardPoints: Number(reward.points || 0) || 0,
        status: Number(item.status === undefined ? 1 : item.status),
      });
    }
  }
  return out;
}

async function fetchTaskCenter(account) {
  const res = await withAuth(account, (cred) =>
    apiRequest('GET', PATH_TASK_CENTER, { token: cred.accessToken, deviceId: cred.deviceId }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '任务列表失败（HTTP ' + res.status + '）');
  }
  return parseTaskCenter(envelopeResult(res.obj, '任务列表'));
}

/** 领任务奖励；业务性拒绝（已领过 / 条件未达成）是 claimed=false，不算异常。 */
async function completeTask(account, taskId) {
  const body = JSON.stringify({ task_id: taskId });
  const res = await withAuth(account, (cred) =>
    apiRequest('POST', PATH_TASK_COMPLETE, { token: cred.accessToken, deviceId: cred.deviceId, body }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '任务领取失败（HTTP ' + res.status + '）');
  }
  const obj = res.obj || {};
  const status = Number(obj.status === undefined ? -1 : obj.status);
  if (status !== 0 && status !== 200) {
    const message = String(obj.message || '').trim() || 'status=' + status;
    return { claimed: false, points: 0, message };
  }
  const result = obj.result && typeof obj.result === 'object' ? obj.result : {};
  const reward = result.reward && typeof result.reward === 'object' ? result.reward : {};
  const awarded = Number(reward.points_awarded || 0) || 0;
  if (awarded > 0) return { claimed: true, points: awarded, message: '领取成功，获得 ' + awarded + ' 积分' };
  return { claimed: false, points: 0, message: '未领取到奖励' };
}

/** 每日登录积分（签到）：status=10001 表示今天已领。 */
async function claimDailyLoginScore(account) {
  const res = await withAuth(account, (cred) =>
    apiRequest('POST', PATH_DAILY_LOGIN_SCORE, { token: cred.accessToken, deviceId: cred.deviceId, body: '' }),
  );
  if (res.status === 401 || res.status === 403) {
    throw apiError('token_rejected', '登录态已失效，请重新登录');
  }
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '签到失败（HTTP ' + res.status + '）');
  }
  const obj = res.obj || {};
  const status = Number(obj.status === undefined ? -1 : obj.status);
  if (status === 10001) return { awarded: false, alreadyClaimed: true, points: 0, message: '今天已经领取过啦' };
  if (status !== 0 && status !== 200) {
    const message = String(obj.message || '').trim() || 'status=' + status;
    return { awarded: false, alreadyClaimed: false, points: 0, message };
  }
  const result = obj.result && typeof obj.result === 'object' ? obj.result : {};
  const score = Number(result.score || 0) || 0;
  if (score > 0) return { awarded: true, alreadyClaimed: false, points: score, message: '签到成功，获得 ' + score + ' 积分' };
  return { awarded: false, alreadyClaimed: true, points: 0, message: '今天已经领取过啦' };
}

async function taskList(account) {
  const cred = parse(account);
  if (!cred) return { tasks: [], error: '凭证无法解析' };
  try {
    const tasks = (await fetchTaskCenter(account)).map((t) => ({
      code: t.taskId,
      title: t.title || t.taskId,
      description: t.description,
      current: t.status === TASK_STATUS_COMPLETED ? 1 : 0,
      target: 1,
      status: t.status === TASK_STATUS_COMPLETED ? 'completed' : String(t.status),
      locked: false,
      claimed: t.status === TASK_STATUS_COMPLETED,
      rewardCredit: t.rewardPoints,
    }));
    return { tasks, error: '' };
  } catch (e) {
    return { tasks: [], error: e.message || '任务列表拉取失败' };
  }
}

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  try {
    const result = await claimDailyLoginScore(account);
    return {
      ok: result.awarded || result.alreadyClaimed,
      message: result.message,
      gained: result.points,
    };
  } catch (e) {
    return { ok: false, message: e.message || '签到失败' };
  }
}

async function runTasks(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  let pending;
  try {
    pending = (await fetchTaskCenter(account)).filter((t) => t.status !== TASK_STATUS_COMPLETED);
  } catch (e) {
    return { ok: false, message: e.message || '任务列表拉取失败' };
  }
  if (pending.length === 0) return { ok: true, message: '没有可领取的任务' };

  const claimed = [];
  const failed = [];
  let earned = 0;
  for (const task of pending) {
    const label = task.title || task.taskId;
    try {
      const result = await completeTask(account, task.taskId);
      if (result.claimed) {
        earned += result.points;
        claimed.push(result.points > 0 ? label + '+' + result.points : label);
      } else if (result.message.indexOf('已') < 0) {
        failed.push(label + '：' + result.message);
      }
    } catch (e) {
      failed.push(label + '：' + e.message);
    }
  }
  const parts = [];
  if (claimed.length > 0) parts.push('成功 ' + claimed.length + ' 个（' + claimed.join('；') + '）');
  if (earned > 0) parts.push('共 +' + earned + ' 积分');
  if (failed.length > 0) parts.push('失败 ' + failed.length + ' 个（' + failed.join('；') + '）');
  return { ok: claimed.length > 0, message: parts.join('；') || '没有领取到奖励' };
}

// ── 工具桥（上游没有 function calling）───────────────────────
//
// 工具定义以提示词注入会话，模型按约定在正文里直接输出一行裸 JSON
// `{"name":…, "arguments":{…}}`，本地再解析回 tool_calls。
// 不能用尖括号标签：会被 agent 引擎截获成内部工具调用并报「工具不存在」。

const TOOL_RESULT_TEMPLATE = '[工具执行结果]\n{name} 返回：{content}';
const MAX_TOOL_RESULT_CHARS = 12000;
const MAX_DESCRIPTION_CHARS = 40;
const MAX_TOOL_BUFFER_CHARS = 256 * 1024;

const TOOL_SYSTEM_PROMPT = [
  '[回复格式要求]',
  '本对话接入的客户端程序会解析你的回复文本。当需要文件读写或命令操作时，请在回复正文中直接输出一行 JSON（纯文本，不要包裹任何标签<>、不要使用任何特殊标记）：',
  '',
  '{"name": "操作名", "arguments": {"参数名": "参数值"}}',
  '',
  '可用操作名：',
  '{tool_definitions}',
  '',
  '{example}',
  '',
  '注意：',
  '1. 直接把这行 JSON 写在正文里（就像写代码块内容一样），不需要做任何"操作"或"调用"动作',
  '2. 不要加 < > 之类的标签或标记，直接写 JSON 本身',
  '3. 需要多个操作时，每个操作用单独一行 JSON 表示',
  '4. 不需要操作时正常用自然语言回答',
].join('\n');

function toolFunction(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const fn = tool.function;
  return fn && typeof fn === 'object' ? fn : null;
}

function paramNames(fn) {
  const props = fn && fn.parameters && fn.parameters.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props);
}

function exampleValue(param) {
  const lower = String(param).toLowerCase();
  if (lower.indexOf('path') >= 0 || lower.indexOf('file') >= 0) return '/tmp/example.txt';
  if (lower.indexOf('command') >= 0 || lower.indexOf('cmd') >= 0) return 'echo hello';
  if (lower.indexOf('content') >= 0 || lower.indexOf('text') >= 0) return '要写入的内容';
  if (lower.indexOf('url') >= 0) return 'https://example.com';
  if (lower.indexOf('pattern') >= 0) return '*.kt';
  return 'value';
}

function formatToolsForPrompt(tools) {
  const lines = [];
  for (const tool of tools) {
    const fn = toolFunction(tool);
    if (!fn) continue;
    const name = String(fn.name || '').trim();
    if (!name) continue;
    const params = paramNames(fn).join(', ');
    const desc = String(fn.description || '').trim().replace(/\n/g, ' ').slice(0, MAX_DESCRIPTION_CHARS);
    let line = '- ' + name + '(' + params + ')';
    if (desc) line += '：' + desc;
    lines.push(line);
  }
  return lines.join('\n');
}

function buildExample(tools) {
  const fn = toolFunction(tools[0]);
  if (!fn) return '';
  const name = String(fn.name || '').trim();
  if (!name) return '';
  const params = paramNames(fn);
  if (params.length === 0) {
    return '示例：你回复的正文应当像这样：\n{"name": "' + name + '", "arguments": {}}';
  }
  const param = params[0];
  return (
    '示例：你回复的正文应当像这样（用实际内容替换参数值）：\n' +
    '{"name": "' + name + '", "arguments": {"' + param + '": "' + exampleValue(param) + '"}}'
  );
}

function buildToolSystemPrompt(tools) {
  return TOOL_SYSTEM_PROMPT.replace('{tool_definitions}', formatToolsForPrompt(tools)).replace(
    '{example}',
    buildExample(tools),
  );
}

function toolsFingerprint(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return md5Hex(JSON.stringify(tools));
}

function buildToolResultPrompt(results) {
  return results
    .map((pair) => {
      const name = pair[0];
      const content = String(pair[1] || '');
      const clipped =
        content.length > MAX_TOOL_RESULT_CHARS
          ? content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（结果过长已截断）'
          : content;
      return TOOL_RESULT_TEMPLATE.replace('{name}', name).replace('{content}', clipped);
    })
    .join('\n\n');
}

function tryParseJsonObject(raw) {
  const direct = safeJson(raw);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  // 裸键兜底：{name: "x"} → {"name": "x"}
  const fixed = String(raw).replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  if (fixed === raw) return null;
  const again = safeJson(fixed);
  return again && typeof again === 'object' && !Array.isArray(again) ? again : null;
}

function parseToolCallJson(raw) {
  const obj = tryParseJsonObject(raw);
  if (!obj) return null;
  const name = typeof obj.name === 'string' ? obj.name : '';
  if (!name.trim()) return null;
  let args = null;
  if (obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)) {
    args = obj.arguments;
  } else if (typeof obj.arguments === 'string') {
    args = safeJson(obj.arguments);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return {
    id: newCallId(),
    type: 'function',
    function: { name: name.trim(), arguments: JSON.stringify(args) },
  };
}

function normalizeParam(text) {
  return String(text).toLowerCase().replace(/-/g, '').replace(/_/g, '');
}

function schemaParamNames(tools) {
  const out = new Map();
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    const fn = toolFunction(tool);
    if (!fn) continue;
    const name = String(fn.name || '');
    const props = fn.parameters && fn.parameters.properties;
    if (!name || !props || typeof props !== 'object') continue;
    out.set(name, Object.keys(props));
  }
  return out;
}

/** 参数名纠偏：模型把 filePath 写成 filepath / file_path 时改回 schema 原文。 */
function coerceToolArguments(calls, tools) {
  const schema = schemaParamNames(tools);
  if (schema.size === 0) return calls;
  const out = [];
  for (const call of calls) {
    const fn = call && call.function;
    const canonical = fn ? schema.get(fn.name) || null : null;
    if (!fn || !canonical) {
      out.push(call);
      continue;
    }
    const args = safeJson(fn.arguments);
    if (!args || typeof args !== 'object') {
      out.push(call);
      continue;
    }
    let changed = false;
    for (const key of Object.keys(args)) {
      if (canonical.indexOf(key) >= 0) continue;
      const target = canonical.find((name) => normalizeParam(name) === normalizeParam(key));
      if (!target) continue;
      if (Object.prototype.hasOwnProperty.call(args, target)) continue;
      args[target] = args[key];
      delete args[key];
      changed = true;
    }
    if (!changed) {
      out.push(call);
      continue;
    }
    out.push({
      id: call.id,
      type: call.type || 'function',
      function: { name: fn.name, arguments: JSON.stringify(args) },
    });
  }
  return out;
}

/** 工具 JSON 流缓冲：把完整的工具块剥出来，其余文本原样放行。 */
class ToolStreamBuffer {
  constructor(enabled) {
    this.enabled = enabled === true;
    this.buffered = '';
  }

  feed(text, onText, onCalls) {
    if (!text) return;
    if (!this.enabled) {
      onText(text);
      return;
    }
    this.buffered += text;
    this.process(onText, onCalls, false);
  }

  flush(onText, onCalls) {
    if (!this.enabled) return;
    this.process(onText, onCalls, true);
  }

  process(onText, onCalls, atEnd) {
    if (!this.buffered) return;
    if (this.buffered.length > MAX_TOOL_BUFFER_CHARS) {
      // 异常超长（大概率不是工具 JSON）：放弃缓冲，按文本放行
      onText(this.buffered);
      this.buffered = '';
      return;
    }
    let out = '';
    let i = 0;
    while (i < this.buffered.length) {
      if (this.buffered[i] !== '{') {
        out += this.buffered[i];
        i++;
        continue;
      }
      const match = sigMatchLen(this.buffered, i);
      if (match < 0) {
        out += this.buffered[i];
        i++;
        continue;
      }
      if (match < SIG_LEN) {
        // 可能是 `{"name"` 的起点但字符还不够：留到下一段
        if (!atEnd) {
          if (out) onText(out);
          this.buffered = this.buffered.slice(i);
          return;
        }
        out += this.buffered[i];
        i++;
        continue;
      }
      const end = scanBlockEnd(this.buffered, i);
      if (end < 0) {
        if (!atEnd) {
          if (out) onText(out);
          this.buffered = this.buffered.slice(i);
          return;
        }
        out += this.buffered.slice(i);
        i = this.buffered.length;
        continue;
      }
      const candidate = this.buffered.slice(i, end + 1);
      const parsed = parseToolCallJson(candidate);
      if (parsed) {
        if (out) {
          onText(out);
          out = '';
        }
        onCalls([parsed]);
      } else {
        out += candidate;
      }
      i = end + 1;
    }
    if (out) onText(out);
    this.buffered = '';
  }
}

const SIG_LEN = 8;

/** `{` 起点的工具 JSON 前缀匹配（`{` 空白* `"name"` 空白* `:`），返回已匹配元素数。 */
function sigMatchLen(text, from) {
  let i = from + 1;
  let j = 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  for (const ch of '"name"') {
    if (i >= text.length) return j;
    if (text[i] !== ch) return -1;
    i++;
    j++;
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return j;
  return text[i] === ':' ? SIG_LEN : -1;
}

/** 从 `{` 起扫描配对闭合，跳过字符串与转义；未闭合返回 -1。 */
function scanBlockEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── SSE 帧解析 ────────────────────────────────────────────────

/**
 * 一帧 `{status, conversation_id, parts[], meta_data, last_error}`。
 * `parts[].content[]` 按 type 归一：text / think 是可见内容，其余（image /
 * tool_calls / file / widget …）暂不下发。
 *
 * 增量语义：`if_increase_push` 显式优先（part 级先于帧级）；否则 part 或帧的
 * `full=true` 即全量。全量帧与缓冲做前缀差分，取不到前缀就整体重发（宁可重复不丢字）。
 */
function createStreamParser() {
  const parts = new Map();
  let convReported = false;

  function resolveIncreaseMode(partMeta, frameMeta) {
    const explicit =
      partMeta && typeof partMeta.if_increase_push === 'boolean'
        ? partMeta.if_increase_push
        : frameMeta && typeof frameMeta.if_increase_push === 'boolean'
          ? frameMeta.if_increase_push
          : null;
    if (explicit !== null) return explicit;
    if ((partMeta && partMeta.full === true) || (frameMeta && frameMeta.full === true)) return false;
    return true;
  }

  function resolveDelta(current, chunk, increase) {
    if (increase) return chunk;
    if (chunk === current) return null;
    if (chunk.indexOf(current) === 0) return chunk.slice(current.length);
    return chunk;
  }

  function isAddInput(part) {
    if (String(part.type || '') === 'add_input') return true;
    const content = Array.isArray(part.content) ? part.content : [];
    return content.some((item) => item && String(item.type || '') === 'add_input');
  }

  function applyChunk(buffer, partText, partThink, increase) {
    let textDelta = null;
    let thinkDelta = null;
    if (partText) {
      textDelta = resolveDelta(buffer.text, partText, increase);
      buffer.text = increase ? buffer.text + partText : partText;
    }
    if (partThink) {
      thinkDelta = resolveDelta(buffer.think, partThink, increase);
      buffer.think = increase ? buffer.think + partThink : partThink;
    }
    if (textDelta === null && thinkDelta === null) return null;
    return { text: textDelta || '', thinking: thinkDelta || '' };
  }

  /** 返回 {events, conversationId}；帧内业务错误直接抛。 */
  function consume(frame) {
    const events = [];
    let conversationId = '';

    if (!convReported) {
      const meta = frame.meta_data && typeof frame.meta_data === 'object' ? frame.meta_data : null;
      const id =
        String(frame.conversation_id || '').trim() ||
        String((meta && meta.conversation_id) || '').trim();
      if (id) {
        convReported = true;
        conversationId = id;
        events.push({ type: 'conversation', id });
      }
    }

    const frameMeta = frame.meta_data && typeof frame.meta_data === 'object' ? frame.meta_data : null;
    const error = frame.last_error || (frameMeta && frameMeta.last_error) || null;
    if (error && typeof error === 'object') {
      const code = Number(error.error_code || 0);
      if (code !== 0) throw upstreamError(code, String(error.err_msg || error.message || '').trim());
    }

    const status = String(frame.status || '').trim();
    if (status) events.push({ type: 'status', value: status });

    const partsArray = Array.isArray(frame.parts) ? frame.parts : [];
    let partFinish = false;
    let partIntervene = false;
    for (const part of partsArray) {
      const value = String((part && part.status) || '');
      if (value === 'error') {
        partFinish = false;
        partIntervene = false;
        events.push({ type: 'status', value: 'error' });
        break;
      }
      if (value === 'intervene') partIntervene = true;
      else if (value === 'finish') partFinish = true;
    }
    if (partIntervene) events.push({ type: 'status', value: 'intervene' });
    else if (partFinish) events.push({ type: 'status', value: 'finish' });

    let text = '';
    let thinking = '';
    for (const part of partsArray) {
      if (!part || typeof part !== 'object') continue;
      if (isAddInput(part)) continue;
      const partMeta = part.meta_data && typeof part.meta_data === 'object' ? part.meta_data : frameMeta;
      const key =
        String(part.logic_id || '').trim() || String(part.id || '').trim() || 'part';
      if (!parts.has(key)) parts.set(key, { text: '', think: '' });
      const buffer = parts.get(key);
      const increase = resolveIncreaseMode(partMeta, frameMeta);
      const content = Array.isArray(part.content) ? part.content : [];
      const showType = String((partMeta && partMeta.show_type) || '');
      let partText = '';
      let partThink = '';
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item.type || '');
        if (type === 'text') {
          if (showType !== 'mc_tool_result2') partText += String(item.text || '');
        } else if (type === 'think') {
          partThink += String(item.think || '');
        }
      }
      const delta = applyChunk(buffer, partText, partThink, increase);
      if (delta) {
        text += delta.text;
        thinking += delta.thinking;
      }
    }
    if (text || thinking) events.push({ type: 'delta', text, thinking });
    return { events, conversationId };
  }

  return { consume };
}

function upstreamError(code, message) {
  // -1001 积分不足；10024 + generator exit 是服务端过载
  if (code === -1001) return apiError('quota', '剩余积分不足，可购买积分充值包获得更多积分');
  if (code === 10024) return apiError('upstream', '服务器被挤爆了，请稍后重试');
  return apiError('upstream', '上游错误 ' + code + (message ? '：' + message : ''));
}

/**
 * SSE 逐行读取：按字节攒行，避免多字节字符跨分片时出现替换符。
 *
 * 上游一帧就是一行 `data: {...}`（不是标准的两行一帧），所以逐行解析，
 * 非 data 行、空行、[DONE]、HEARTBEAT 一律跳过。
 */
function createSseReader(onFrame) {
  let tail = Buffer.alloc(0);

  function handleLine(line) {
    const text = String(line || '').trim();
    if (text.indexOf('data:') !== 0) return;
    const payload = text.slice(5).trim();
    if (!payload || payload === '[DONE]' || payload.toUpperCase() === 'HEARTBEAT') return;
    const obj = safeJson(payload);
    if (obj && typeof obj === 'object') onFrame(obj);
  }

  function feed(chunk) {
    tail = Buffer.concat([tail, chunk]);
    let idx = tail.indexOf(0x0a);
    while (idx >= 0) {
      const line = tail.slice(0, idx).toString('utf8').replace(/\r$/, '');
      tail = tail.slice(idx + 1);
      handleLine(line);
      idx = tail.indexOf(0x0a);
    }
  }

  function finish() {
    if (tail.length === 0) return;
    const rest = tail.toString('utf8');
    tail = Buffer.alloc(0);
    handleLine(rest);
  }

  return { feed, finish };
}

// ── 会话注册表 ────────────────────────────────────────────────

/**
 * 把「OpenAI 消息列表」映射到 conversation_id。
 *
 * 指纹 = md5(accountId + \0 + system + \0 + 首条 user 文本)：同一对话开头落进
 * 同一会话；编辑首条消息自然换新会话。user 条数变少说明客户端历史被截断，
 * 旧会话上下文不可用，作废重建。
 */
const conversations = new Map();
const MAX_RECORDS_PER_ACCOUNT = 300;
const agents = new Map();

function conversationKey(accountId, system, firstUser) {
  return md5Hex(String(accountId) + '\x00' + String(system) + '\x00' + String(firstUser));
}

function loadRecords(accountId) {
  return conversations.get(String(accountId)) || new Map();
}

function saveRecords(accountId, map) {
  let entries = Array.from(map.entries());
  if (entries.length > MAX_RECORDS_PER_ACCOUNT) {
    entries = entries
      .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
      .slice(0, MAX_RECORDS_PER_ACCOUNT);
  }
  conversations.set(String(accountId), new Map(entries));
}

function planConversation(accountId, system, userTexts, tools, toolResultPrompt) {
  const key = conversationKey(accountId, system, userTexts[0]);
  let records = loadRecords(accountId);
  let record = records.get(key) || null;

  const wantsBridge = Array.isArray(tools) && tools.length > 0;
  if (record && userTexts.length < Number(record.userCount || 0)) {
    records = new Map(records);
    records.delete(key);
    saveRecords(accountId, records);
    record = null;
    log('info', '智谱清言会话历史被截断，重建会话');
  }
  if (record && !record.bridge && wantsBridge) {
    records = new Map(records);
    records.delete(key);
    saveRecords(accountId, records);
    record = null;
    log('info', '智谱清言会话升级为工具桥，重建会话');
  }

  const bridge = record ? record.bridge === true : wantsBridge;
  const toolsHash = toolsFingerprint(tools);
  const toolSystem = wantsBridge ? buildToolSystemPrompt(tools) : null;
  const user = userTexts[userTexts.length - 1];

  if (toolResultPrompt) {
    if (record) {
      return {
        accountId,
        key,
        prompt: toolResultPrompt,
        conversationId: record.conversationId,
        agentId: record.agentId,
        userCount: userTexts.length,
        toolsHash: record.toolsHash || '',
        bridge: record.bridge === true,
      };
    }
    const chunks = [];
    if (system.trim()) chunks.push(system);
    if (toolSystem) chunks.push(toolSystem);
    chunks.push(user);
    chunks.push(toolResultPrompt);
    return {
      accountId,
      key,
      prompt: chunks.join('\n\n'),
      conversationId: '',
      agentId: '',
      userCount: userTexts.length,
      toolsHash,
      bridge,
    };
  }

  if (!record) {
    const chunks = [];
    if (system.trim()) chunks.push(system);
    if (toolSystem) chunks.push(toolSystem);
    chunks.push(user);
    return {
      accountId,
      key,
      prompt: chunks.join('\n\n'),
      conversationId: '',
      agentId: '',
      userCount: userTexts.length,
      toolsHash,
      bridge,
    };
  }

  const inject = toolSystem !== null && record.toolsHash !== toolsHash;
  return {
    accountId,
    key,
    prompt: inject ? toolSystem + '\n\n' + user : user,
    conversationId: record.conversationId,
    agentId: record.agentId,
    userCount: userTexts.length,
    toolsHash,
    bridge,
  };
}

function commitConversation(plan, conversationId, agentId) {
  const records = new Map(loadRecords(plan.accountId));
  records.set(plan.key, {
    conversationId,
    agentId,
    userCount: plan.userCount,
    lastUser: plan.prompt,
    toolsHash: plan.toolsHash,
    bridge: plan.bridge,
    updatedAt: Date.now(),
  });
  saveRecords(plan.accountId, records);
}

function rebindConversation(accountId, key, conversationId) {
  const records = new Map(loadRecords(accountId));
  const record = records.get(key);
  if (!record) return;
  records.set(key, Object.assign({}, record, { conversationId, updatedAt: Date.now() }));
  saveRecords(accountId, records);
}

// ── 智能体发现 ────────────────────────────────────────────────

function firstNonEmpty(values) {
  for (const value of values) {
    if (value) return value;
  }
  return '';
}

function collectAgents(node, agentIdFieldOnly, out, seen) {
  if (Array.isArray(node)) {
    for (const item of node) collectAgents(item, agentIdFieldOnly, out, seen);
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  const explicitType = String((node.meta_data && node.meta_data.type) || '');
  // group / showcase 的 id 与 claw 无关，发给上游会报「claw 不存在」
  if (agentIdFieldOnly || (explicitType !== 'group' && explicitType !== 'showcase')) {
    const info = node.agent_info && typeof node.agent_info === 'object' ? node.agent_info : null;
    let id;
    if (agentIdFieldOnly) {
      id = String(node.agent_id || '').trim();
    } else {
      id = firstNonEmpty([
        String((info && info.id) || '').trim(),
        String(node.relate_id || '').trim(),
        String(node.agent_id || '').trim(),
        explicitType === '' ? String(node.id || '').trim() : '',
        explicitType === '' ? String(node.agentId || '').trim() : '',
      ]);
    }
    const name = firstNonEmpty([
      String(node.name || '').trim(),
      String(node.agent_name || '').trim(),
      String(node.title || '').trim(),
    ]);
    if (id && name) {
      const key = (agentIdFieldOnly ? 'strict:' : 'loose:') + id;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          id,
          name,
          isDefault: node.is_default === true || node.default === true,
        });
      }
    }
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') collectAgents(value, agentIdFieldOnly, out, seen);
  }
  return out;
}

function pickAgent(list) {
  const preferred =
    list.find((a) => a.isDefault) ||
    list.find((a) => a.name.indexOf('助手') >= 0 || a.name.indexOf('通用') >= 0) ||
    list[0];
  return preferred ? preferred.id : '';
}

function parseAgentList(payload) {
  const obj = payload || {};
  const result =
    (obj.result && typeof obj.result === 'object' && obj.result) ||
    (obj.data && typeof obj.data === 'object' && obj.data) ||
    null;

  if (result && Array.isArray(result.list)) {
    const list = [];
    for (const node of result.list) {
      if (!node || typeof node !== 'object') continue;
      if (String((node.meta_data && node.meta_data.type) || '') !== 'agent') continue;
      const info = node.agent_info && typeof node.agent_info === 'object' ? node.agent_info : null;
      // 条目的 id 是项目 id，发给上游会报「claw 不存在」，只有 agent_info.id 等才是 claw id
      const id = firstNonEmpty([
        String((info && info.id) || '').trim(),
        String(node.relate_id || '').trim(),
        String(node.agent_id || '').trim(),
      ]);
      if (!id) continue;
      const name = firstNonEmpty([
        String((info && info.name) || '').trim(),
        String(node.title || '').trim(),
      ]);
      list.push({ id, name, isDefault: node.is_default === true || node.default === true });
    }
    if (list.length > 0) return pickAgent(list);
  }

  const roots = [];
  if (result) {
    for (const key of ['list', 'agents', 'data', 'items']) {
      const value = result[key];
      if (value && typeof value === 'object') roots.push(value);
    }
  }
  if (roots.length === 0 && result) roots.push(result);
  if (roots.length === 0) roots.push(payload);

  for (const root of roots) {
    const strict = collectAgents(root, true, [], new Set());
    const list = strict.length > 0 ? strict : collectAgents(root, false, [], new Set());
    if (list.length > 0) return pickAgent(list);
  }
  return '';
}

async function resolveAgent(account, cred) {
  const key = String(account.uid || '');
  if (agents.has(key)) return agents.get(key);
  const res = await withAuth(account, (c) =>
    apiRequest('GET', PATH_PROJECT_LIST, { token: c.accessToken, deviceId: c.deviceId }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '获取智能体列表失败（HTTP ' + res.status + '）');
  }
  const id = parseAgentList(res.obj);
  if (!id) throw apiError('upstream', '无法从智能体列表里找到可用的 agent');
  agents.set(key, id);
  log('info', '智谱清言选用智能体：' + id);
  return id;
}

async function createConversation(cred, agentId) {
  const res = await apiRequest('POST', PATH_CONVERSATION, {
    token: cred.accessToken,
    deviceId: cred.deviceId,
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (res.status === 401 || res.status === 403) throw apiError('token_rejected', '登录态已失效，请重新登录');
  if (res.status < 200 || res.status >= 300) {
    throw apiError('upstream', '创建会话失败（HTTP ' + res.status + '）');
  }
  const result = envelopeResult(res.obj, '创建会话');
  const conversationId = String(result.conversation_id || '').trim();
  if (!conversationId) throw apiError('upstream', '创建会话成功但上游没有返回 conversation_id');
  return conversationId;
}

// ── 消息解析 ──────────────────────────────────────────────────

function messageText(content) {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (Array.isArray(content)) {
    let text = '';
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'text' || type === 'input_text') text += String(part.text || '');
    }
    return text.trim() ? text : null;
  }
  return null;
}

/** 抽 system 与全部 user 文本；结尾连续 tool 消息作为工具结果回填。 */
function extractMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let system = '';
  const userTexts = [];
  const tailToolResults = [];
  const toolCallNames = new Map();

  let firstTailTool = messages.length;
  let k = messages.length - 1;
  while (k >= 0) {
    const role = messages[k] && typeof messages[k] === 'object' ? String(messages[k].role || '') : '';
    if (role !== 'tool') break;
    firstTailTool = k;
    k--;
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '');
    if (role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const id = String(call.id || '').trim();
        const name = String((call.function && call.function.name) || '').trim();
        if (id && name) toolCallNames.set(id, name);
      }
      continue;
    }
    if (role === 'tool') {
      if (i >= firstTailTool) {
        const callId = String(message.tool_call_id || '').trim();
        const name =
          String(message.name || '').trim() || toolCallNames.get(callId) || 'unknown_tool';
        tailToolResults.push([name, messageText(message.content) || '']);
      }
      continue;
    }
    const text = messageText(message.content);
    if (text === null) continue;
    if (role === 'system' || role === 'developer') {
      system += (system ? '\n\n' : '') + text;
    } else if (role === 'user') {
      userTexts.push(text);
    }
  }

  return {
    system,
    userTexts,
    toolResultPrompt: tailToolResults.length > 0 ? buildToolResultPrompt(tailToolResults) : '',
  };
}

/** 客户端档位 → 上游 reasoning_effort。 */
function normalizeEffort(body) {
  let raw = String(body.reasoning_effort || '').trim();
  if (!raw && body.reasoning && typeof body.reasoning === 'object') {
    raw = String(body.reasoning.effort || '').trim();
  }
  const lower = raw.toLowerCase();
  if (lower === 'low' || lower === 'minimal' || lower === 'none') return 'low';
  if (lower === 'medium') return 'high';
  if (lower === 'high' || lower === 'max') return 'max';
  return 'high';
}

// ── 对话 ──────────────────────────────────────────────────────

function chunkLine(chatId, model, delta, finishReason) {
  const body = {
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
  };
  return 'data: ' + JSON.stringify(body);
}

/**
 * 打开上游 SSE，等**整个流结束**才 resolve。
 *
 * lib/http 的 stream() 在响应头到达时就 resolve，调用方拿到返回值就会写
 * [DONE] 并关掉响应——长流会被截断。这里改成读到 EOF 才算完。
 */
function openSse(opts, onChunk) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(opts.url);
    } catch (e) {
      reject(new Error('URL 非法：' + opts.url));
      return;
    }
    const lib = urlObj.protocol === 'https:' ? https : httpNative;
    const headers = Object.assign({ 'Accept-Encoding': 'identity' }, opts.headers || {});
    const bodyBuf = Buffer.from(String(opts.body || ''), 'utf8');
    if (!headers['Content-Length']) headers['Content-Length'] = bodyBuf.length;

    const req = lib.request(
      {
        method: 'POST',
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        headers,
      },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let head = '';
        res.on('data', (chunk) => {
          if (ok) onChunk(chunk);
          else if (head.length < 8192) head += chunk.toString('utf8');
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode || 0, headers: res.headers, head });
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      },
    );

    const timeout = opts.timeout || CHAT_TIMEOUT;
    const timer = setTimeout(() => req.destroy(new Error('流式请求超时（' + timeout + 'ms）')), timeout);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * 发起一轮对话。
 *
 * 上游只给 SSE，且帧形不是 OpenAI——这里直接翻译成 OpenAI 帧喂给 onLine，
 * 流式与非流式由上层（gateway.js）决定是否聚合。
 */
async function openChat(account, openAiBody, onLine) {
  const body = typeof openAiBody === 'string' ? safeJson(openAiBody) : openAiBody;
  if (!body || typeof body !== 'object') {
    return { status: 400, model: '', error: { status: 400, message: '请求体不是合法 JSON' } };
  }

  let cred = requireCred(account);
  if (!cred) {
    return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };
  }
  if (cred.refreshToken && isExpiring(cred)) {
    cred = (await refreshOnce(account, '临期')) || cred;
  }

  const extracted = extractMessages(body);
  if (extracted.userTexts.length === 0) {
    return { status: 400, model: '', error: { status: 400, message: '请求里没有可发送的用户消息' } };
  }
  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null;
  const accountId = String(account.uid || account.nickname || '');
  const plan = planConversation(
    accountId,
    extracted.system,
    extracted.userTexts,
    tools,
    extracted.toolResultPrompt,
  );
  const model = resolveSelectedModel(body.model);
  const effort = normalizeEffort(body);
  const chatId = 'chatcmpl-' + newUuidHex().slice(0, 24);

  let agentId = plan.agentId;
  let conversationId = plan.conversationId;
  try {
    if (!agentId) {
      agentId = await resolveAgent(account, cred);
      // resolveAgent 内部的 withAuth 可能已刷新凭证，局部变量要跟上
      cred = parse(account) || cred;
    }
    if (!conversationId) {
      conversationId = await createConversation(cred, agentId);
      cred = parse(account) || cred;
    }
  } catch (e) {
    const status = e.kind === 'token_rejected' ? 401 : 502;
    return { status, model, error: { status, message: e.message } };
  }
  commitConversation(plan, conversationId, agentId);

  const requestBody = JSON.stringify({
    agent_id: agentId,
    conversation_id: conversationId,
    meta_data: { platform: 'pc', reasoning_effort: effort, selected_model: model },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: plan.prompt }],
      },
    ],
  });

  let sawFinish = false;
  let sawError = false;
  let sawIntervene = false;
  let roleSent = false;
  let callCount = 0;

  const emit = (delta, finishReason) => {
    if (!roleSent) {
      roleSent = true;
      onLine('data: ' + JSON.stringify({
        id: chatId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }));
    }
    onLine(chunkLine(chatId, model, delta, finishReason));
  };

  /** 跑一次流。返回 {res, error}；error 非空时 retryable 标记能否换 token 重试。 */
  const runStream = async (creds) => {
    sawFinish = false;
    sawError = false;
    sawIntervene = false;
    roleSent = false;
    callCount = 0;

    let streamError = null;
    const buffer = new ToolStreamBuffer(plan.bridge);
    const parser = createStreamParser();

    const emitText = (text) => {
      if (!text) return;
      emit({ content: text }, null);
    };

    const emitCalls = (calls) => {
      const coerced = coerceToolArguments(calls, tools);
      const indexed = coerced.map((call, i) => Object.assign({}, call, { index: callCount + i }));
      if (indexed.length === 0) return;
      callCount += indexed.length;
      emit({ tool_calls: indexed }, null);
    };

    const handleFrame = (frame) => {
      const result = parser.consume(frame);
      if (result.conversationId && result.conversationId !== conversationId) {
        rebindConversation(accountId, plan.key, result.conversationId);
      }
      for (const event of result.events) {
        if (event.type === 'status') {
          if (event.value === 'finish') sawFinish = true;
          else if (event.value === 'error') sawError = true;
          else if (event.value === 'intervene') sawIntervene = true;
        } else if (event.type === 'delta') {
          if (event.thinking) emit({ reasoning_content: event.thinking }, null);
          if (event.text) buffer.feed(event.text, emitText, emitCalls);
        }
      }
    };

    const reader = createSseReader((frame) => {
      if (streamError) return;
      try {
        handleFrame(frame);
      } catch (e) {
        streamError = e;
      }
    });

    let res;
    try {
      res = await openSse(
        {
          url: BASE + PATH_CHAT_STREAM,
          headers: Object.assign(signedHeaders(creds.deviceId), {
            Authorization: 'Bearer ' + creds.accessToken,
            // 复刻 Web 端形态：Accept 双写（官方成功样本如此）
            Accept: 'text/event-stream, text/event-stream',
          }),
          body: requestBody,
          timeout: CHAT_TIMEOUT,
        },
        (chunk) => {
          if (streamError) return;
          try {
            reader.feed(chunk);
          } catch (e) {
            streamError = e;
          }
        },
      );
    } catch (e) {
      return { error: { status: 502, message: e.message || '对话请求失败' } };
    }

    if (res.status === 401 || res.status === 403) {
      // 401 时流里不会有任何帧，换新 token 重试是安全的
      return { error: { status: 401, message: '登录态已失效，请重新登录' }, retryable: true };
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = String(res.head || '').trim().slice(0, 160);
      return {
        res,
        error: {
          status: 502,
          message: '对话请求失败（HTTP ' + res.status + '）' + (detail ? '：' + detail : ''),
        },
      };
    }

    reader.finish();
    if (streamError) {
      const status = streamError.kind === 'quota' ? 429 : 502;
      return { res, error: { status, message: streamError.message } };
    }

    buffer.flush(emitText, emitCalls);
    if (sawError && !sawFinish && !sawIntervene) {
      return { res, error: { status: 502, message: '上游流以错误状态结束' } };
    }

    emit({}, callCount > 0 ? 'tool_calls' : 'stop');
    onLine('data: [DONE]');
    return { res };
  };

  let outcome = await runStream(cred);
  if (outcome.error && outcome.retryable && cred.refreshToken) {
    const current = parse(account);
    let next = current;
    if (!current || current.accessToken === cred.accessToken) {
      next = (await refreshOnce(account, '对话被拒')) || cred;
    }
    if (next && next.accessToken !== cred.accessToken) {
      cred = next;
      outcome = await runStream(cred);
    }
  }

  if (outcome.error) {
    return { status: outcome.error.status, model, error: outcome.error };
  }
  return { status: 200, headers: outcome.res.headers, model };
}

// ── 登录 / 导入 ──────────────────────────────────────────────

function loginUrl() {
  return LOGIN_URL;
}

function cookieValue(cookie, name) {
  const parts = String(cookie || '').split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function tokensFromCookie(cookie) {
  return {
    accessToken: cookieValue(cookie, 'chatglm_token'),
    refreshToken: cookieValue(cookie, 'chatglm_refresh_token'),
    deviceId: cookieValue(cookie, 'chatglm-deid') || cookieValue(cookie, 'chatglm_deid'),
  };
}

/**
 * 用 cookie 建账号。
 *
 * 登录页把 token 同时写进 cookie 与 localStorage（`chatglm-deid` 只在
 * localStorage，拿不到就现生成一个）。访客态会被拒——上游对未登录也回 200。
 */
async function accountFromCookie(cookie) {
  const tokens = tokensFromCookie(cookie);
  const accessToken = tokens.accessToken || cookieValue(cookie, 'access_token');
  if (!accessToken) {
    throw new Error('cookie 里没有 chatglm_token，请确认已在智谱清言完成登录');
  }
  const cred = {
    accessToken,
    refreshToken: tokens.refreshToken || '',
    deviceId: tokens.deviceId || newUuidHex(),
    expiresAt: jwtExpiry(accessToken),
    userId: '',
  };
  const draft = makeAccount('agentmore', jwtUid(accessToken) || 'pending', '', secretOf(cred));
  let result;
  try {
    result = await fetchUserInfo(draft);
  } catch (e) {
    // 网络类失败不该把凭证丢掉：先按 JWT 里能拿到的信息建档
    if (e.kind === 'token_rejected') throw e;
    const uid = jwtUid(accessToken) || 'agentmore-' + accessToken.slice(-8);
    return makeAccount('agentmore', uid, '账号 ' + uid.slice(-6), secretOf(Object.assign({}, cred, { userId: uid })));
  }
  if (result.is_guest === true) throw apiError('token_rejected', '当前仍是访客态，请完成登录');
  const userId = String(result._id || '');
  const uid = userId || jwtUid(accessToken) || 'agentmore-' + accessToken.slice(-8);
  return makeAccount(
    'agentmore',
    uid,
    '账号 ' + String(uid).slice(-6),
    secretOf(Object.assign({}, cred, { userId })),
  );
}

function tryParseAccountsJson(text) {
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.accounts)) return obj.accounts;
    if (obj && typeof obj === 'object') return [obj];
    return [];
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
          const obj = safeJson(text.slice(start, i + 1));
          if (obj) out.push(obj);
          start = -1;
        }
      }
    }
    return out;
  }
}

function accountFromImport(obj, fallbackToken, fallbackCookie) {
  const src = obj && typeof obj === 'object' ? obj : {};
  let accessToken = String(
    src.accessToken || src.access_token || src.token || fallbackToken || '',
  ).trim();
  let refreshToken = String(src.refreshToken || src.refresh_token || '').trim();
  let deviceId = String(src.deviceId || src.device_id || src['chatglm-deid'] || '').trim();
  let cookie = String(src.cookie || '').trim() || fallbackCookie || '';

  if (!accessToken && cookie) {
    const tokens = tokensFromCookie(cookie);
    accessToken = tokens.accessToken;
    if (!refreshToken) refreshToken = tokens.refreshToken;
    if (!deviceId) deviceId = tokens.deviceId;
  }
  if (!accessToken) return null;

  const userId = String(src.userId || src.user_id || src._id || '').trim();
  const uid = userId || jwtUid(accessToken) || 'agentmore-' + accessToken.slice(-8);
  const cred = {
    accessToken,
    refreshToken,
    deviceId: deviceId || newUuidHex(),
    expiresAt: Number(src.expiresAt || 0) || jwtExpiry(accessToken),
    userId,
  };
  return makeAccount(
    'agentmore',
    String(uid),
    String(src.nickname || '').trim() || '账号 ' + String(uid).slice(-6),
    secretOf(cred),
  );
}

/**
 * 导入智谱清言凭证：App 导出 JSON、`{cookie: "..."}`、裸 cookie 串、
 * 或每行一个裸 access_token。
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

    const uid = importer.resolveUid(item, secret, 'agentmore');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('agentmore', uid, nickname, JSON.stringify(built), extraOf(built)));
  }

  return list;
}

// ── 导出 ──────────────────────────────────────────────────────

module.exports = {
  id: 'agentmore',
  displayName: '智谱清言',
  authKind: 'WEBVIEW_CALLBACK',
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
  loginUrl,
  accountFromCookie,
  importCredentials,

  // 测试用：无副作用的纯函数
  _internal: {
    makeTimestamp,
    sign: (ts, nonce) => md5Hex(ts + '-' + nonce + '-' + SIGN_SALT),
    resolveSelectedModel,
    normalizeRemote,
    parseTaskCenter,
    parseAgentList,
    extractMessages,
    createStreamParser,
    ToolStreamBuffer,
    parseToolCallJson,
    tokensFromCookie,
  },
};
