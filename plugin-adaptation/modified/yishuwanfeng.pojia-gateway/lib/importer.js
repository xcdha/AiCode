'use strict';

/**
 * 统一的账号导入解析器。
 *
 * 各供应商原本各自实现 importCredentials，从同一份样板复制扩散，带来了两个通病：
 *
 * 1. **JSON 解析成功后仍走「每行一个 token」兜底**
 *    造成 JSON 文本的每一行（`"accessToken": "xxx"`）都被当成一个 token，
 *    2  ​个账号能解析出 6~14 个垃圾账号。
 *
 * 2. **uid 取不到时回退成 `hash(token)`**
 *    但 App 导出的 JSON 里本来就带 uid，回退等于把稳定的 uid 换成随机值，
 *    同一账号每次导入都变成新账号（互相覆盖失效）。
 *
 * 本模块的行为：
 *   - 有 JSON 结构就只按 JSON 解析，绝不混入逐行兜底
 *   - uid 优先用 JSON 里的 uid，其次 JWT 声明，最后才 hash
 *   - secret 原样保留（各家 parse 时才解释字段）
 *
 * 供应商只需提供 createAccount(uid, nickname, secretObj) 回调。
 */

const crypto = require('crypto');

/**
 * 把输入文本解析成候选账号列表。
 *
 * 支持的输入形态：
 *   - App 导出的 JSON 数组：`[{provider, uid, nickname, secret}, ...]`
 *   - 单个对象：`{uid, nickname, secret}`
 *   - 包裹对象：`{accounts: [...]}`
 *   - 多条 JSON 相连：`{...}{...}`
 *   - 纯文本：每行一个 token / cookie
 *
 * @returns {{kind: 'json'|'lines', items: Array}}
 *   items 里每项是 {uid, nickname, secret}
 */
function parseInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'json', items: [] };

  // ── 先判断是不是 JSON 形态 ──
  const looksJson = text.startsWith('{') || text.startsWith('[');
  if (looksJson) {
    const arr = parseJsonAccounts(text);
    if (arr.length > 0) {
      return {
        kind: 'json',
        items: arr.map((item) => ({
          uid: String(item.uid || item.userId || item.user_id || '').trim(),
          nickname: String(item.nickname || item.name || '').trim(),
          secret: item.secret !== undefined ? item.secret : item,
        })),
      };
    }
    // 是 JSON 语法但解析不出账号 → 明确告知，不再退回逐行（那样只会产生垃圾）
    return { kind: 'json', items: [] };
  }

  // ── 纯文本：每行一个 token / cookie ──
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 太短的（如 `abc`）不是凭证；带空格的长串可能是 cookie
    if (t.length < 16) continue;
    // 明显是键值对形式（`token=xxx`）也接受
    items.push({ uid: '', nickname: '', secret: { _raw: t } });
  }
  return { kind: 'lines', items };
}

/** 从 JSON 文本里挖出账号数组。失败返回空数组。 */
function parseJsonAccounts(text) {
  // 1) 标准 JSON
  try {
    const obj = JSON.parse(text);
    const arr = extractArray(obj);
    if (arr.length > 0) return arr;
    // 单个账号对象也算
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (looksLikeAccount(obj)) return [obj];
    }
  } catch (e) {
    // 落到多段相连的解析
  }

  // 2) 多条 JSON 相连：按大括号配平切分
  const parts = [];
  let depth = 0;
  let start = -1;
  let inStr = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"') {
      inStr = c;
      if (depth > 0) continue;
    }

    if (c === '{' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        const chunk = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(chunk);
          parts.push(obj);
        } catch (e) {
          // 跳过
        }
        start = -1;
      }
    }
  }

  const out = [];
  for (const obj of parts) {
    const arr = extractArray(obj);
    if (arr.length > 0) out.push(...arr);
    else if (obj && typeof obj === 'object' && !Array.isArray(obj) && looksLikeAccount(obj)) {
      out.push(obj);
    }
  }
  return out;
}

/** 从各种包裹形态里取出账号数组。 */
function extractArray(obj) {
  if (Array.isArray(obj)) {
    // 直接是数组
    return obj.filter((x) => x && typeof x === 'object');
  }
  if (!obj || typeof obj !== 'object') return [];
  for (const key of ['accounts', 'data', 'list', 'items', 'result']) {
    if (Array.isArray(obj[key])) {
      return obj[key].filter((x) => x && typeof x === 'object');
    }
  }
  return [];
}

/** 粗略判断一个对象像不像账号记录。 */
function looksLikeAccount(obj) {
  return (
    obj.secret !== undefined ||
    obj.uid !== undefined ||
    obj.accessToken !== undefined ||
    obj.access_token !== undefined ||
    obj.token !== undefined ||
    obj.cookie !== undefined
  );
}

/**
 * 从 JWT 里取声明。token 不是 JWT 或解析失败返回空串。
 */
function jwtClaim(token, names) {
  const parts = String(token || '').split('.');
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
    // 不是 JWT
  }
  return '';
}

/**
 * 从 JWT 取声明，支持 payload 嵌套在 `data` 里的情况。
 *
 * Trae 的 accessToken 把业务字段放在 `payload.data` 下（如 `data.id` 就是账号 id），
 * 标准 jwtClaim 只看顶层，会拿不到。
 */
function jwtClaimDeep(token, names) {
  const top = jwtClaim(token, names);
  if (top) return top;

  const parts = String(token || '').split('.');
  if (parts.length < 2) return '';
  try {
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const obj = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    for (const wrap of ['data', 'payload', 'user', 'account']) {
      const inner = obj[wrap];
      if (!inner || typeof inner !== 'object') continue;
      for (const n of names) {
        const v = inner[n];
        if (v !== undefined && v !== null && String(v)) return String(v);
      }
    }
  } catch (e) {
    // 不是 JWT
  }
  return '';
}

function hashShort(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
}

/**
 * 给一个账号决定稳定的 uid。
 *
 * 优先级：显式 uid → 凭证里的 uid 字段 → JWT 声明 → 凭证内容 hash。
 * 最后一级是兜底，同一份凭证永远得到同一个 uid（而不是随机值）。
 */
function resolveUid(candidate, secretObj, providerId, uidFields) {
  const fields = uidFields || [];
  if (candidate.uid) return candidate.uid;

  // 先看扁平层，再看可能存在的嵌套层（如 Trae 的 secret.account.uid）
  const layers = [secretObj];
  if (secretObj && typeof secretObj === 'object') {
    for (const k of ['account', 'auth', 'user', 'profile']) {
      if (secretObj[k] && typeof secretObj[k] === 'object') layers.push(secretObj[k]);
    }
  }

  for (const layer of layers) {
    for (const f of ['uid', 'userId', 'user_id', 'accountId', 'account_id', 'aid', 'sub']) {
      const v = layer[f];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
  }

  // JWT 声明（trae 的 JWT payload 在 data.id，单独处理）
  let token = '';
  for (const layer of layers) {
    const t = layer.accessToken || layer.access_token || layer.token;
    if (t) {
      token = t;
      break;
    }
  }
  const fromJwt = jwtClaimDeep(token, ['uid', 'userId', 'user_id', 'sub', 'account_id', 'id']);
  if (fromJwt) return fromJwt;

  // 供应商自定义的 uid 字段
  for (const layer of layers) {
    for (const f of fields) {
      const v = layer[f];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
  }

  // 最终兜底：凭证内容的 hash（稳定，不会每次变成新账号）
  let basis = '';
  for (const layer of layers) {
    const t = layer.accessToken || layer.token || layer.cookie;
    if (t) {
      basis = String(t);
      break;
    }
  }
  if (!basis) basis = JSON.stringify(secretObj || {});
  return providerId + '-' + hashShort(basis);
}

/**
 * 把候选归一化成一个 secret 对象。
 *
 * 逐行输入的项只有一个 `_raw`，要按各家习惯包装成 {token} 或 {cookie}。
 */
function normalizeSecret(secret, rawLine) {
  if (secret && typeof secret === 'string') {
    try {
      const obj = JSON.parse(secret);
      if (obj && typeof obj === 'object') return obj;
    } catch (e) {
      // 不是 JSON，当裸 token
    }
    return { token: secret };
  }
  if (secret && typeof secret === 'object') {
    if (secret._raw !== undefined) {
      const raw = String(secret._raw);
      // cookie 串含 `=` 与 `;`，token 一般是单段
      if (raw.includes('=') && (raw.includes(';') || raw.split('=').length > 2)) {
        return { cookie: raw, token: raw };
      }
      return { token: raw, cookie: raw };
    }
    return secret;
  }
  return rawLine ? { token: String(rawLine) } : {};
}

module.exports = {
  parseInput,
  parseJsonAccounts,
  resolveUid,
  normalizeSecret,
  jwtClaim,
  hashShort,
};
