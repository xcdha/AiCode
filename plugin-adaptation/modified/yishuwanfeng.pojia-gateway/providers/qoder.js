'use strict';

/**
 * Qoder（`qoder.com.cn` / `qoder.sh`）。
 *
 * 鉴权是一整套自研协议，不是 Bearer：
 *   1. 生成 16 字节 tempKey
 *   2. cosy-key = base64(RSA_PKCS1(tempKey))          用服务端公钥
 *   3. info     = base64(AES-CBC(identityJson, tempKey, tempKey))
 *   4. body 用自定义 Base64 编码（三段轮转 + 换字母表）
 *   5. authorization = "Bearer COSY.{payloadB64}.{sig}"
 *      其中 sig = md5(payloadB64 \n cosyKey \n date \n body \n path)
 *
 * 三处极易写错：
 *   - identityJson 必须**键排序 + 无空白**，服务端按同规则重算
 *   - signPath 要去掉 `/algo` 前缀（签名只认 path）
 *   - 模型目录接口是 JSON 不是流，带 accept: text/event-stream 会 400
 */

const crypto = require('crypto');
const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const SERVER_PUB_B64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc' +
  '4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l' +
  '6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17' +
  'XcW+ML9FoCI6AOvOzwIDAQAB';

const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = '$';

const COSY_VERSION = '0.1.11';

const REGIONS = {
  cn: {
    id: 'cn',
    label: '国内版',
    openApi: 'https://openapi.qoder.com.cn',
    chatHost: 'https://gateway.qoder.com.cn',
    consoleHost: 'https://qoder.com.cn',
    clientId: '',
  },
  global: {
    id: 'global',
    label: '国际版',
    openApi: 'https://openapi.qoder.sh',
    chatHost: 'https://api1.qoder.sh',
    consoleHost: 'https://qoder.com',
    clientId: '',
  },
};

const PATHS = {
  devPoll: '/api/v1/deviceToken/poll',
  devRefresh: '/api/v1/deviceToken/refresh',
  userInfo: '/api/v1/userinfo',
  quota: '/api/v2/quota/usage',
  campaigns: '/sash/api/v1/me/campaigns',
  campaignClaim: '/sash/api/v1/me/campaigns/%s/claim',
  checkinStatus: '/sash/api/v1/me/daily-check-in/status',
  checkinClaim: '/sash/api/v1/me/daily-check-in/claim',
  chat: '/algo/api/v1/chat/completions',
  models: '/algo/api/v1/models',
};

const DEFAULT_MODEL = 'default-model';

// ── 自定义 Base64 ────────────────────────────────────────────

const STD_TO_CUSTOM = (() => {
  const table = new Array(128).fill(PAD);
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET[i];
  }
  table['='.charCodeAt(0)] = PAD;
  return table;
})();

/**
 * 自定义 Base64：先标准编码，再按「尾/中/首」三段轮转，最后换字母表。
 *
 * 短请求体时三段会出现空段，轮转退化为恒等——这是上游正常行为，
 * 不要「优化」掉，否则短 body 签名对不上。
 */
function encodeBody(plain) {
  const std = Buffer.from(plain).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    out += code < 128 ? STD_TO_CUSTOM[code] : PAD;
  }
  return out;
}

// ── 指纹派生 ─────────────────────────────────────────────────

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function deriveMachineId(uid) {
  return md5('machine:' + uid);
}

function deriveMachineType(uid) {
  return md5('machinetype:' + uid).slice(0, 18);
}

function deriveMachineToken(uid) {
  const raw = crypto.createHash('sha512').update('machinetoken:' + uid, 'utf8').digest();
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43);
}

// ── 签名会话 ──────────────────────────────────────────────────

/**
 * 建一个签名会话（绑定账号身份）。
 *
 * cosy-key 与 info 在构造时算好，之后每次请求只重算 sig——
 * 与官方客户端行为一致，且避免每次请求都做 RSA 运算。
 */
function createSession(cred) {
  const tempKey = Buffer.from(
    crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    'utf8',
  );

  // identityJson：9 键，键名与顺序由服务端决定，不能增删
  const fields = {
    aid: cred.uid,
    name: cred.nickname || '',
    organization_id: '',
    organization_name: '',
    refresh_token: cred.refreshToken || '',
    security_oauth_token: cred.accessToken,
    uid: cred.uid,
    user_type: 'personal_professional_trial',
    yx_uid: '',
  };
  const sortedKeys = Object.keys(fields).sort();
  const identityJson =
    '{' + sortedKeys.map((k) => `"${k}":"${escapeJson(fields[k])}"`).join(',') + '}';

  // cosy-key = base64(RSA_PKCS1(tempKey))
  const der = Buffer.from(SERVER_PUB_B64, 'base64');
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  const rsaEncrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    tempKey,
  );
  const cosyKey = rsaEncrypted.toString('base64');

  // info = base64(AES-256-CBC(identityJson, tempKey, tempKey))
  const cipher = crypto.createCipheriv('aes-128-cbc', tempKey, tempKey);
  const info = Buffer.concat([cipher.update(identityJson, 'utf8'), cipher.final()]).toString('base64');

  const machineId = deriveMachineId(cred.uid);
  const machineToken = deriveMachineToken(cred.uid);
  const machineType = deriveMachineType(cred.uid);

  return {
    uid: cred.uid,
    cosyKey,
    info,
    machineId,
    machineToken,
    machineType,

    /** 为一次请求生成头族。body 必须是最终要发出去的字符串。 */
    headers(body, rawUrl, opts) {
      const o = opts || {};
      const sse = o.sse !== false;

      const path = signPath(rawUrl);
      const payload = JSON.stringify({
        cosyVersion: COSY_VERSION,
        ideVersion: '',
        info,
        requestId: crypto.randomUUID(),
        version: 'v1',
      });
      const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
      const date = String(Math.floor(Date.now() / 1000));
      const raw = `${payloadB64}\n${cosyKey}\n${date}\n${body}\n${path}`;
      const sig = md5(raw);

      const h = {
        'cosy-data-policy': 'AGREE',
        'content-type': 'application/json',
        'cosy-machinetype': machineType,
        'cosy-clienttype': '5',
        'cosy-date': date,
        'cosy-user': cred.uid,
        'cosy-key': cosyKey,
        accept: o.accept || (sse ? 'text/event-stream' : 'application/json'),
        'cosy-clientip': '169.254.198.161',
        authorization: `Bearer COSY.${payloadB64}.${sig}`,
        'accept-encoding': 'identity',
        'cosy-version': COSY_VERSION,
        'cosy-machineid': machineId,
        'cosy-machinetoken': machineToken,
        'login-version': 'v2',
        'user-agent': 'Go-http-client/2.0',
      };
      if (sse) h['cache-control'] = 'no-cache';
      if (o.modelKey) {
        h['x-model-key'] = o.modelKey;
        h['x-model-source'] = 'system';
      }
      return h;
    },
  };
}

/** 签名只认 path，且要去掉 /algo 前缀。 */
function signPath(rawUrl) {
  let path = '/';
  try {
    path = new URL(rawUrl).pathname || '/';
  } catch (e) {
    return '/';
  }
  return path.startsWith('/algo') ? path.slice(5) : path;
}

function escapeJson(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const accessToken = obj.accessToken || obj.access_token || obj.security_oauth_token || '';
  if (!accessToken) return null;
  const regionKey = String(obj.region || '').trim().toLowerCase();
  return {
    accessToken,
    refreshToken: obj.refreshToken || obj.refresh_token || '',
    uid: obj.uid || obj.aid || account.uid || '',
    nickname: obj.nickname || obj.name || '',
    region: REGIONS[regionKey] || REGIONS.cn,
    tokenKind: obj.tokenKind || '',
  };
}

// ── 模型 ──────────────────────────────────────────────────────

function resolveModel(requested) {
  const m = String(requested || '').trim();
  if (!m || m === 'auto') return DEFAULT_MODEL;
  return m;
}

async function fetchModels(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const session = createSession(cred);

  const url = cred.region.chatHost + PATHS.models;
  // 模型目录是 JSON，用 GET 且不能带 sse 头
  const headers = session.headers('', url, { sse: false, accept: 'application/json' });

  const res = await http.get(url, headers, 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`模型接口 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const arr = Array.isArray(obj.data) ? obj.data : (obj.data && obj.data.models) || obj.models || [];

  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = item.model_key || item.modelKey || item.id || item.name || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: String(id),
      name: String(item.display_name || item.displayName || item.name || id),
      contextWindow: Number(item.context_window || item.max_tokens || 0) || 0,
      supportsTools: item.support_tool !== false,
      supportsReasoning: item.support_think === true || item.thinking === true,
    });
  }
  if (out.length === 0) {
    out.push({ id: DEFAULT_MODEL, name: DEFAULT_MODEL, contextWindow: 0, supportsTools: true, supportsReasoning: false });
  }
  return out;
}

// ── 对话 ──────────────────────────────────────────────────────

async function openChat(account, openAiBody, onLine) {
  const cred = parse(account);
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);

  const payload = Object.assign({}, src, { model, stream: true });
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  // 请求体要过自定义 Base64
  const body = encodeBody(plain);

  const session = createSession(cred);
  const url = cred.region.chatHost + PATHS.chat;
  const headers = session.headers(body, url, { sse: true, modelKey: model });
  headers['content-type'] = 'text/plain';

  const splitter = sse.createLineSplitter((line) => {
    const p = sse.dataPayload(line);
    if (p === null || p === '[DONE]') return;
    const obj = safeJson(p);
    if (!obj) return;
    // 上游帧基本是 OpenAI 形状，补个 role 就能直接转
    if (Array.isArray(obj.choices)) {
      onLine('data: ' + p);
      return;
    }
    if (typeof obj.content === 'string' && obj.content) {
      onLine(
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: obj.content }, finish_reason: null }],
          }),
      );
    }
  });

  try {
    const res = await http.stream({ url, headers, body, timeout: 300000 }, splitter);
  if (res.done) await res.done;
    if (res.status < 200 || res.status >= 300) {
      return {
        status: res.status,
        headers: res.headers,
        model,
        error: { status: res.status, message: `Qoder 返回 HTTP ${res.status}` },
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
  const session = createSession(cred);

  const url = cred.region.openApi + PATHS.quota;
  const headers = session.headers('', url, { sse: false, accept: 'application/json' });

  const res = await http.get(url, headers, 30000);
  if (res.status < 200 || res.status >= 300) throw new Error(`额度接口 HTTP ${res.status}`);

  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  let credit = -1;
  for (const k of ['remaining', 'remain', 'credits', 'balance', 'total_remaining']) {
    const n = Number(data[k]);
    if (Number.isFinite(n)) {
      credit = n;
      break;
    }
  }
  return { credit, creditText: credit >= 0 ? String(credit) : '', raw: data };
}

// ── 签到（活动平台 + 旧版兜底） ──────────────────────────────

async function checkin(account) {
  const cred = parse(account);
  if (!cred) return { ok: false, message: '凭证无法解析' };
  const session = createSession(cred);

  // 先试活动平台（新版每日 100 Credits 在这里）
  try {
    const listUrl = cred.region.openApi + PATHS.campaigns;
    const listHeaders = session.headers('', listUrl, { sse: false, accept: 'application/json' });
    const listRes = await http.get(listUrl, listHeaders, 30000);

    if (listRes.status >= 200 && listRes.status < 300) {
      const obj = safeJson(listRes.text) || {};
      const arr = Array.isArray(obj.data) ? obj.data : (obj.data && obj.data.campaigns) || obj.campaigns || [];
      const claimable = arr.filter((c) => c && (c.can_claim === true || c.claimable === true));

      if (claimable.length > 0) {
        let gained = 0;
        let claimed = 0;
        for (const campaign of claimable) {
          const id = campaign.id || campaign.campaign_id || '';
          if (!id) continue;
          const claimUrl = cred.region.openApi + PATHS.campaignClaim.replace('%s', encodeURIComponent(id));
          const claimHeaders = session.headers('', claimUrl, { sse: false, accept: 'application/json' });
          try {
            const res = await http.postJson(claimUrl, {}, claimHeaders, 30000);
            if (res.status >= 200 && res.status < 300) {
              const r = safeJson(res.text) || {};
              const n = Number((r.data && r.data.credits) || r.credits || 0);
              if (Number.isFinite(n)) gained += n;
              claimed++;
            }
          } catch (e) {
            // 单个活动失败不影响其余
          }
        }
        if (claimed > 0) {
          return {
            ok: true,
            message: gained > 0 ? `领取 ${claimed} 个活动，+${gained} Credits` : `领取 ${claimed} 个活动`,
            gained,
          };
        }
      } else if (arr.length > 0) {
        return { ok: true, message: '今日活动奖励已领完' };
      }
    }
  } catch (e) {
    // 活动平台不可用，落到旧版签到
  }

  // 旧版签到兜底（多数区域已停用，但能领到就是白得的）
  try {
    const statusUrl = cred.region.openApi + PATHS.checkinStatus;
    const statusHeaders = session.headers('', statusUrl, { sse: false, accept: 'application/json' });
    const statusRes = await http.get(statusUrl, statusHeaders, 30000);
    if (statusRes.status >= 200 && statusRes.status < 300) {
      const obj = safeJson(statusRes.text) || {};
      const data = obj.data || obj;
      if (data.checked_in === true || data.has_checked_in === true) {
        return { ok: true, message: '今日已签到' };
      }
    }

    const claimUrl = cred.region.openApi + PATHS.checkinClaim;
    const claimHeaders = session.headers('', claimUrl, { sse: false, accept: 'application/json' });
    const res = await http.postJson(claimUrl, {}, claimHeaders, 30000);
    const text = res.text || '';

    if (/已签到|already|checked/i.test(text)) return { ok: true, message: '今日已签到' };
    if (res.status >= 200 && res.status < 300) {
      const obj = safeJson(text) || {};
      const n = Number((obj.data && obj.data.credits) || obj.credits || 0);
      return {
        ok: true,
        message: Number.isFinite(n) && n > 0 ? `签到成功，+${n} Credits` : '签到成功',
        gained: Number.isFinite(n) ? n : 0,
      };
    }
    return { ok: false, message: `签到失败 HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl(regionId) {
  const region = REGIONS[String(regionId || '').toLowerCase()] || REGIONS.cn;
  return `${region.consoleHost}/device`;
}

function accountFromCookie(cookie, regionId) {
  const region = REGIONS[String(regionId || '').toLowerCase()] || REGIONS.cn;
  const jar = parseCookieString(cookie);
  const token =
    jar.security_oauth_token || jar.access_token || jar.accessToken || jar.qoder_token || '';
  if (!token) throw new Error('cookie 里没有 access_token；Qoder 用设备授权，建议直接从 App 导出账号后粘贴');

  const uid = jar.uid || jar.aid || 'qoder-' + hashShort(token);
  return makeAccount('qoder', String(uid), '', JSON.stringify({
    accessToken: token,
    refreshToken: jar.refresh_token || '',
    uid: String(uid),
    nickname: '',
    region: region.id,
    tokenKind: '',
  }), { region: region.id });
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return !!(s.accessToken || s.access_token || s.security_oauth_token || s.token);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return ((s, uid, nick) => {
      const region = String(s.region || 'cn').toLowerCase();
      return {
        accessToken: s.accessToken || s.access_token || s.security_oauth_token || s.token || '',
        refreshToken: s.refreshToken || s.refresh_token || '',
        uid,
        aid: s.aid || uid,
        nickname: nick,
        region: ['cn', 'global'].includes(region) ? region : 'cn',
        tokenKind: s.tokenKind || '',
      };
    })(s, uid, nick);
}

/** makeAccount 的额外字段。 */
function extraOf(secret) {
  return { region: secret.region || 'cn' };
}


function importCredentials(raw) {
  const parsed = importer.parseInput(raw);
  const list = [];

  for (const item of parsed.items) {
    const secret = importer.normalizeSecret(item.secret);
    if (!hasCredential(secret)) continue;

    const uid = importer.resolveUid(item, secret, 'qoder');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('qoder', uid, nickname, JSON.stringify(built), extraOf(built)));
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
  id: 'qoder',
  displayName: 'Qoder',
  authKind: 'DEVICE_CODE',
  capabilities: [CAP.CREDIT_REFRESH, CAP.CHECKIN],
  defaultModel: DEFAULT_MODEL,
  regions: ['cn', 'global'],

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  checkin,
  loginUrl,
  accountFromCookie,
  importCredentials,

  _internal: { encodeBody, createSession, signPath, deriveMachineId, deriveMachineType },
};
