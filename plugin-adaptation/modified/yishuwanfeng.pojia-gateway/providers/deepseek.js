'use strict';

/**
 * DeepSeek 网页版（chat.deepseek.com）。
 *
 * 鉴权：Cookie（用户登录后从 localStorage / cookie 取 token）。
 * 对话不是标准 chat/completions，要走三步：
 *   1. POST /api/v0/chat_session/create     建会话
 *   2. POST /api/v0/chat/create_pow_challenge  拿 PoW 挑战
 *   3. POST /api/v0/chat/completion         带 x-ds-pow-response 头，返回 SSE
 *
 * PoW 是自定义的 Keccak-f23（官方叫 DeepSeekHashV1），
 * 不是标准 SHA3：rate 136 字节、只跑 24 轮里的 1~23 轮（跳过 round 0）。
 * 照搬官方 wasm 的行为，改错一个字就会一直「PoW 求解失败」。
 */

const http = require('../lib/http');
const sse = require('../lib/sse');
const { makeAccount, parseSecret } = require('../lib/accounts');
const { CAP } = require('../lib/registry');
const importer = require('../lib/importer');

const HOST = 'https://chat.deepseek.com';

const PATH_USERS_CURRENT = '/api/v0/users/current';
const PATH_CREATE_SESSION = '/api/v0/chat_session/create';
const PATH_CREATE_POW = '/api/v0/chat/create_pow_challenge';
const PATH_COMPLETION = '/api/v0/chat/completion';
const PATH_DELETE_SESSION = '/api/v0/chat_session/delete';

const CLIENT_VERSION = '2.5.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_CONTEXT_WINDOW = 128000;

// ── Keccak-f23（DeepSeekHashV1） ──────────────────────────────

const RATE = 136;
const RATE_LANES = 17;

const RC_HEX = [
  '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000',
  '000000000000808b', '0000000080000001', '8000000080008081', '8000000000008009',
  '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
  '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003',
  '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a',
  '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
];
const RC = RC_HEX.map((h) => BigInt('0x' + h));

/** r[x][y]：列 x、行 y。 */
const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;

function rotl64(v, n) {
  if (n === 0) return v & MASK64;
  const shift = BigInt(n);
  return ((v << shift) | (v >> (64n - shift))) & MASK64;
}

function readLane(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(buf[off + i]);
  }
  return v & MASK64;
}

function writeLane(v, buf, off) {
  let x = v;
  for (let i = 0; i < 8; i++) {
    buf[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

function absorb(s, data, off) {
  for (let i = 0; i < RATE_LANES; i++) {
    s[i] = (s[i] ^ readLane(data, off + i * 8)) & MASK64;
  }
}

function keccakF23(s) {
  // 只跑 round 1..23：官方实现跳过 round 0，这是 DeepSeekHashV1 与标准 SHA3 的唯一差别
  for (let round = 1; round < 24; round++) {
    // theta
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = (s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]) & MASK64;
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = (c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1)) & MASK64;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] = (s[x + 5 * y] ^ d[x]) & MASK64;
      }
    }
    // rho + pi
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], RHO[x][y]);
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const cur = b[x + 5 * y];
        const n1 = b[(x + 1) % 5 + 5 * y];
        const n2 = b[(x + 2) % 5 + 5 * y];
        s[x + 5 * y] = (cur ^ ((~n1 & MASK64) & n2)) & MASK64;
      }
    }
    // iota
    s[0] = (s[0] ^ RC[round]) & MASK64;
  }
}

/** Keccak-f23 摘要 32 字节。 */
function hash(data) {
  const s = new Array(25).fill(0n);
  let off = 0;
  while (off + RATE <= data.length) {
    absorb(s, data, off);
    keccakF23(s);
    off += RATE;
  }
  const last = Buffer.alloc(RATE);
  const remain = data.length - off;
  data.copy(last, 0, off, off + remain);
  last[remain] = 0x06;
  last[RATE - 1] |= 0x80;
  absorb(s, last, 0);
  keccakF23(s);

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) writeLane(s[i], out, i * 8);
  return out;
}

/**
 * 求解 PoW：找 n ∈ [0, difficulty) 使 hash(prefix + str(n)) 的摘要等于 challenge。
 *
 * prefix 是 `salt + "_" + expireAt + "_"`，会被预吸收以复用中间状态——
 * 这是为什么要手动做 multi-block 吸收而不是直接调 hash()。
 */
function solve(challengeHex, salt, expireAt, difficulty) {
  if (String(challengeHex).length !== 64) return null;

  const target = Buffer.from(challengeHex, 'hex');
  if (target.length !== 32) return null;
  const t0 = readLane(target, 0);
  const t1 = readLane(target, 8);
  const t2 = readLane(target, 16);
  const t3 = readLane(target, 24);

  const prefix = Buffer.from(`${salt}_${expireAt}_`, 'utf8');

  // 预吸收 prefix
  const base = new Array(25).fill(0n);
  let off = 0;
  while (off + RATE <= prefix.length) {
    absorb(base, prefix, off);
    keccakF23(base);
    off += RATE;
  }
  const tail = prefix.slice(off);

  const s = new Array(25);
  const block = Buffer.alloc(RATE);

  for (let n = 0; n < difficulty; n++) {
    const numBuf = Buffer.from(String(n), 'utf8');
    const total = tail.length + numBuf.length;

    for (let i = 0; i < 25; i++) s[i] = base[i];

    if (total < RATE) {
      block.fill(0);
      tail.copy(block, 0);
      numBuf.copy(block, tail.length);
      block[total] = 0x06;
      block[RATE - 1] = 0x80;
      absorb(s, block, 0);
      keccakF23(s);
    } else {
      // prefix 极长才会走到；照官方分两块处理
      const firstLen = RATE - tail.length;
      block.fill(0);
      tail.copy(block, 0);
      numBuf.copy(block, tail.length, 0, firstLen);
      absorb(s, block, 0);
      keccakF23(s);

      const rem = total - RATE;
      block.fill(0);
      numBuf.copy(block, 0, firstLen, firstLen + rem);
      block[rem] = 0x06;
      block[RATE - 1] = 0x80;
      absorb(s, block, 0);
      keccakF23(s);
    }

    if (s[0] === t0 && s[1] === t1 && s[2] === t2 && s[3] === t3) return n;
  }
  return null;
}

/** 组装 x-ds-pow-response：base64(JSON)。 */
function buildPowHeader(algorithm, challenge, salt, answer, signature, targetPath) {
  const json = JSON.stringify({
    algorithm,
    challenge,
    salt,
    answer,
    signature,
    target_path: targetPath,
  });
  return Buffer.from(json, 'utf8').toString('base64');
}

// ── 请求头 ────────────────────────────────────────────────────

function headers(token) {
  const h = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Referer: HOST + '/',
    Origin: HOST,
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-app-version': CLIENT_VERSION,
  };
  if (token) {
    h.Authorization = 'Bearer ' + token;
    // 网页版把 token 也放 cookie 里，上游两种都认，带上更稳
    h.Cookie = `ds_session_id=${token}`;
  }
  return h;
}

// ── 凭证 ──────────────────────────────────────────────────────

function parse(account) {
  const obj = parseSecret(account);
  if (!obj) return null;
  const token = obj.token || obj.accessToken || '';
  if (!token) return null;
  return { token, uid: obj.uid || account.uid || '', nickname: obj.nickname || '' };
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
  if (!m || m === 'auto') return DEFAULT_MODEL;
  return m;
}

/**
 * DeepSeek 没有公开的模型目录接口，这里给固定清单。
 *
 * 上游只有两个模型可切（deepseek-chat / deepseek-reasoner），
 * 与其瞎猜接口不如写死——猜错会让整个供应商从列表里消失。
 */
async function fetchModels() {
  return [
    { id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: DEFAULT_CONTEXT_WINDOW, supportsTools: false, supportsReasoning: false },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1', contextWindow: DEFAULT_CONTEXT_WINDOW, supportsTools: false, supportsReasoning: true },
  ];
}

// ── 对话 ──────────────────────────────────────────────────────

/**
 * 建会话。返回 session id。
 *
 * 上游要求每次对话前先建一个会话；建失败就没法继续，
 * 所以这里失败直接抛错，不像删会话那样静默。
 */
async function createSession(token) {
  const res = await http.postJson(HOST + PATH_CREATE_SESSION, {}, headers(token), 30000);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`创建会话 HTTP ${res.status}：${res.text.slice(0, 160)}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const biz = data.biz_data || data;
  const id = biz.id || biz.chat_session_id || data.id || '';
  if (!id) throw new Error(`创建会话失败：${obj.msg || '响应里没有会话 id'}`);
  return String(id);
}

/** 拿 PoW 挑战并求解。 */
async function createPowHeader(token) {
  const res = await http.postJson(
    HOST + PATH_CREATE_POW,
    { target_path: PATH_COMPLETION },
    headers(token),
    30000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`PoW 挑战 HTTP ${res.status}`);
  }
  const obj = safeJson(res.text) || {};
  const data = obj.data || obj;
  const biz = data.biz_data || data;
  const ch = biz.challenge || biz;
  if (!ch || !ch.challenge) {
    throw new Error(`PoW 挑战获取失败：${obj.msg || '响应里没有 challenge'}`);
  }

  const algorithm = String(ch.algorithm || '');
  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`未知 PoW 算法：${algorithm}`);
  }
  const difficulty = Number(ch.difficulty) > 0 ? Number(ch.difficulty) : 144000;
  const answer = solve(ch.challenge, ch.salt, Number(ch.expire_at || 0), difficulty);
  if (answer === null) {
    throw new Error('PoW 求解失败（挑战可能已过期）');
  }
  return buildPowHeader(
    algorithm,
    ch.challenge,
    ch.salt,
    answer,
    ch.signature || '',
    ch.target_path || PATH_COMPLETION,
  );
}

/** 尽力清理会话，失败只记日志。 */
async function deleteSession(token, sessionId) {
  try {
    await http.postJson(HOST + PATH_DELETE_SESSION, { chat_session_id: sessionId }, headers(token), 15000);
  } catch (e) {
    // 清理失败不影响对话结果
  }
}

function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // DeepSeek 网页版是单轮 prompt，多轮要自己拼
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
  if (!cred) return { status: 401, model: '', error: { status: 401, message: '凭证无法解析' } };

  const src = typeof openAiBody === 'string' ? JSON.parse(openAiBody) : openAiBody;
  const model = resolveModel(src.model);
  const prompt = flattenMessages(src.messages);
  const thinking = model === 'deepseek-reasoner';

  let sessionId = '';
  let powHeader = '';
  try {
    sessionId = await createSession(cred.token);
    powHeader = await createPowHeader(cred.token);
  } catch (e) {
    return { status: 502, model, error: { status: 502, message: e.message } };
  }

  const body = JSON.stringify({
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinking,
    search_enabled: false,
  });

  const h = headers(cred.token);
  h['x-ds-pow-response'] = powHeader;
  h.Accept = 'text/event-stream';

  // 上游帧形状：{v: {response: {fragments:[{content}]}}} 之类，逐层剥
  const splitter = sse.createLineSplitter((line) => {
    const payload = sse.dataPayload(line);
    if (payload === null || payload === '[DONE]') return;
    const obj = safeJson(payload);
    if (!obj) return;
    const text = extractText(obj);
    if (!text) return;
    onLine(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }),
    );
  });

  try {
    const res = await http.stream(
      { url: HOST + PATH_COMPLETION, headers: h, body, timeout: 300000 },
      splitter,
    );
  if (res.done) await res.done;
    if (res.status < 200 || res.status >= 300) {
      deleteSession(cred.token, sessionId);
      return {
        status: res.status,
        headers: res.headers,
        model,
        error: { status: res.status, message: `DeepSeek 返回 HTTP ${res.status}` },
      };
    }
    onLine('data: [DONE]');
    // 会话用完即删，避免上游堆积；异步做，不阻塞返回
    deleteSession(cred.token, sessionId);
    return { status: res.status, headers: res.headers, model };
  } catch (e) {
    deleteSession(cred.token, sessionId);
    return { status: 502, model, error: { status: 502, message: e.message } };
  }
}

/** 从上游帧里挖正文。结构改过几次，按可能性逐层剥。 */
function extractText(obj) {
  // 形式一：{v: {response: {fragments: [{content}]}}}
  const v = obj.v || obj;
  const response = v.response || v;
  if (Array.isArray(response.fragments)) {
    let out = '';
    for (const f of response.fragments) {
      if (f && typeof f.content === 'string') out += f.content;
    }
    if (out) return out;
  }
  // 形式二：直接 choices[].delta.content
  if (Array.isArray(response.choices)) {
    const first = response.choices[0];
    if (first && first.delta && typeof first.delta.content === 'string') return first.delta.content;
  }
  // 形式三：{content: "..."}
  if (typeof response.content === 'string') return response.content;
  if (typeof response.text === 'string') return response.text;
  return '';
}

// ── 账号与积分 ────────────────────────────────────────────────

async function fetchCredit(account) {
  const cred = parse(account);
  if (!cred) throw new Error('凭证无法解析');
  const res = await http.get(HOST + PATH_USERS_CURRENT, headers(cred.token), 30000);
  if (res.status < 200 || res.status >= 300) throw new Error(`用户信息 HTTP ${res.status}`);
  const obj = safeJson(res.text) || {};
  const data = (obj.data && (obj.data.biz_data || obj.data)) || obj;
  const credit = Number(data.balance !== undefined ? data.balance : data.points);
  return {
    credit: Number.isFinite(credit) ? credit : -1,
    creditText: Number.isFinite(credit) ? String(credit) : '',
    raw: data,
  };
}

// ── 登录与导入 ────────────────────────────────────────────────

function loginUrl() {
  return HOST + '/sign_in';
}

async function accountFromCookie(cookie) {
  const jar = parseCookieString(cookie);
  // DeepSeek 的会话 token 在 localStorage 的 userToken 里，
  // WebView 抠 cookie 时通常拿不到，需要用户手动粘 token
  const token =
    jar.ds_session_id || jar.token || jar.userToken || jar.authorization || '';
  if (!token) throw new Error('cookie 里没有会话 token，请在网页 localStorage 里复制 userToken');

  const uid =
    jar.userId || jwtClaim(token, ['user_id', 'userId', 'uid', 'sub']) ||
    'deepseek-' + hashShort(token);
  return makeAccount('deepseek', String(uid), '', JSON.stringify({ token, uid, nickname: '' }));
}


// ── 导入辅助（与 lib/importer 配合） ──────────────────────────

/** 判断归一化后的 secret 里有没有可用凭证。 */
function hasCredential(s) {
  return (s) => !!(s.token || s.accessToken || s.access_token)(s);
}

/** 组装该供应商的 secret JSON。 */
function buildSecret(s, uid, nick) {
  return (s, uid, nick) => ({
      token: s.token || s.accessToken || s.access_token || s.userToken || '',
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

    const uid = importer.resolveUid(item, secret, 'deepseek');
    const nickname = item.nickname || secret.nickname || '';
    const built = buildSecret(secret, uid, nickname);

    list.push(makeAccount('deepseek', uid, nickname, JSON.stringify(built), extraOf(built)));
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
  id: 'deepseek',
  displayName: 'DeepSeek',
  authKind: 'WEBVIEW_CALLBACK',
  capabilities: [],
  defaultModel: DEFAULT_MODEL,

  parse,
  resolveModel,
  fetchModels,
  openChat,
  fetchCredit,
  loginUrl,
  accountFromCookie,
  importCredentials,

  // 导出给测试用
  _pow: { hash, solve, buildPowHeader },
};
