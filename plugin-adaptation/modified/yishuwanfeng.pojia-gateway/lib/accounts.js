'use strict';

/**
 * 账号持久化。
 *
 * 存到 data://accounts.json —— 插件私有目录，卸载时自动清除，不进宿主备份。
 * 结构与 App 版导出的 JSON 兼容，方便直接把 App 里导出的账号贴进来。
 */

const fs = require('fs');
const path = require('path');

const MAX_BODY = 8 * 1024 * 1024;

// ── data:// 路径解析 ─────────────────────────────────────────
//
// 宿主把插件私有存储映射到某个目录，但 runtime 侧没有 aicode.fs 便捷方法，
// 只能走 host.fs.* 的 RPC。为了不给每次账号读写都加一次往返，
// 这里把 data:// 解析成真实路径后直接用 node 的 fs。
//
// 解析顺序：环境变量（宿主注入）→ 已知默认位置 → 临时目录兜底。

function dataDir() {
  const candidates = [process.env.AICODE_DATA_DIR].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      // 下一个候选
    }
  }
  throw new Error('Guru 插件数据目录不可用');
}

let cachedDataDir = null;
function accountsFile() {
  if (!cachedDataDir) cachedDataDir = migrateIfNeeded();
  return path.join(cachedDataDir, 'accounts.json');
}

/**
 * 早期版本把账号存在 plugin-data 裱目录（不分插件），这里搬过来。
 *
 * 不搬的话升级后用户会看到账号全没了——数据其实还在旧位置。
 *
 * 目标文件「不存在」或「是空数组」都算需要搬：
 * 空数组往往是迁移前的一次无效写入，不能因此跳过真实数据。
 */
function migrateIfNeeded() {
  const dir = dataDir();
  const target = path.join(dir, 'accounts.json');

  try {
    if (isEmptyOrMissing(target)) {
      // 旧位置：plugin-data 裱目录（当前目录的上一级）
      const legacy = path.join(path.dirname(dir), 'accounts.json');
      if (legacy !== target && fs.existsSync(legacy)) {
        const legacyList = readList(legacy);
        const currentList = readList(target);
        // 只在旧数据比当前多时搬，避免回退用户后来新加的账号
        if (legacyList.length > currentList.length) {
          fs.writeFileSync(target, JSON.stringify(legacyList, null, 2), 'utf8');
          log('info', `已从旧位置迁移 ${legacyList.length} 个账号：${legacy}`);
        }
      }
    }
  } catch (e) {
    // 迁移失败不影响使用
  }
  return dir;
}

function isEmptyOrMissing(file) {
  try {
    if (!fs.existsSync(file)) return true;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return true;
    const arr = JSON.parse(raw);
    return !Array.isArray(arr) || arr.length === 0;
  } catch (e) {
    return true;
  }
}

function readList(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// ── 读写 ──────────────────────────────────────────────────────

function listAll() {
  try {
    const raw = fs.readFileSync(accountsFile(), 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    log('warn', `读账号文件失败：${e.message}`);
    return [];
  }
}

function saveAll(list) {
  const file = accountsFile();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    log('error', `写账号文件失败：${e.message}`);
  }
}

// ── 账号对象 ──────────────────────────────────────────────────

/**
 * 构造一条账号记录。
 *
 * 字段对齐 App 版 ProviderAccount：providerId / uid / nickname / secret / enabled。
 * secret 是各供应商自己的凭证 JSON 串（cookie、token 的组合）。
 */
function makeAccount(providerId, uid, nickname, secret, extra) {
  const e = extra || {};
  return {
    providerId,
    uid,
    nickname: nickname || '',
    secret,
    enabled: e.enabled !== false,
    // 展示用：区域、积分、最后刷新时间
    region: e.region || '',
    credit: e.credit === undefined ? null : e.credit,
    creditText: e.creditText || '',
    creditAt: e.creditAt || 0,
    checkinAt: e.checkinAt || 0,
    cooldownUntil: 0,
    addedAt: e.addedAt || Date.now(),
  };
}

/** 把 secret（JSON 串）解析成对象，失败返回 null。 */
function parseSecret(account) {
  if (!account || !account.secret) return null;
  try {
    const obj = JSON.parse(account.secret);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

// ── 日志 ──────────────────────────────────────────────────────

let logSink = null;
function setLogSink(sink) {
  logSink = sink;
}

function log(level, message) {
  if (logSink) {
    try {
      logSink(level, message);
      return;
    } catch (e) {
      // 落到 stderr
    }
  }
  try {
    process.stderr.write(`[${level}] ${message}\n`);
  } catch (e) {
    // 忽略
  }
}

module.exports = {
  MAX_BODY,
  listAll,
  saveAll,
  makeAccount,
  parseSecret,
  setLogSink,
  log,
  accountsFile,
};
