'use strict';

/**
 * 供应商注册表与账号池。
 *
 * 移植自 pojia2api-android 的 Provider / ProviderRegistry / AccountPool。
 * 与原实现的差别只在语言：Kotlin 的接口在这里变成对象字面量约定。
 */

const accounts = require('./accounts');

// ── 能力位（对齐 Kotlin 的 ProviderCapability） ────────────────

const CAP = {
  CREDIT_REFRESH: 'creditRefresh',
  CHECKIN: 'checkin',
  TASKS: 'tasks',
  POINTS_BILLS: 'pointsBills',
};

// 供应商专属动作名（对齐 Kotlin 的 ACTION_CHECKIN / ACTION_TASKS）
const ACTION_CHECKIN = 'checkin';
const ACTION_TASKS = 'tasks';

/** 注册表：id → provider 实现。 */
const registry = new Map();

/**
 * 注册一家供应商。
 *
 * provider 需要提供：
 *   id / displayName / authKind / capabilities
 *   chat(account, payload, signal)        → { stream } 或 { json }
 *   models(account)                       → [{ id, name, ... }]
 *   credit(account)                       → { ... }（可选）
 *   checkin(account)                      → { ok, message }（可选）
 *   taskList(account)                     → { tasks, error }（可选）
 *   runTasks(account)                     → { ok, message }（可选）
 *   accountFromCookie(cookie, extra)      → account（登录用）
 *   importCredentials(raw)                → [account]（粘贴导入用）
 */
function register(provider) {
  if (!provider || !provider.id) throw new Error('provider 缺少 id');
  registry.set(provider.id, provider);
}

function allProviders() {
  return Array.from(registry.values());
}

function provider(id) {
  return registry.get(id) || null;
}

/** 支持某能力的供应商清单。 */
function withCapability(cap) {
  return allProviders().filter((p) => (p.capabilities || []).includes(cap));
}

/** 支持签到或任务的供应商（任务中心用）。 */
function taskCapable() {
  return allProviders().filter((p) => {
    const caps = p.capabilities || [];
    return caps.includes(CAP.CHECKIN) || caps.includes(CAP.TASKS);
  });
}

// ── 账号池 ────────────────────────────────────────────────────

/**
 * 账号池：providerId → [account]。
 *
 * 主键是 uid（与 Kotlin 版一致）：同 uid 的账号会互相覆盖，
 * 因为同一个账号重复登录只会刷出新凭证，不该出现两条。
 */
const pool = new Map();

function loadPool() {
  pool.clear();
  const stored = accounts.listAll();
  for (const account of stored) {
    if (!account || !account.providerId || !account.uid) continue;
    addAccount(account, { persist: false });
  }
  return pool;
}

function addAccount(account, opts) {
  const options = opts || {};
  const bucket = pool.get(account.providerId) || [];
  const filtered = bucket.filter((a) => a.uid !== account.uid);
  filtered.push(account);
  pool.set(account.providerId, filtered);
  if (options.persist !== false) {
    accounts.saveAll(flatten());
  }
  return account;
}

function removeAccount(providerId, uid) {
  const bucket = pool.get(providerId) || [];
  pool.set(providerId, bucket.filter((a) => a.uid !== uid));
  accounts.saveAll(flatten());
}

function listAccounts(providerId) {
  if (providerId) return (pool.get(providerId) || []).slice();
  return flatten();
}

function flatten() {
  const out = [];
  for (const bucket of pool.values()) {
    for (const account of bucket) out.push(account);
  }
  return out;
}

function count(providerId) {
  return (pool.get(providerId) || []).length;
}

/**
 * 选一个可用账号。
 *
 * 简化自 Kotlin 版的调度：跳过被显式停用的、以及处于冷却期的，
 * 都没有就退而用第一个未停用的（宁可试一次也不直接失败）。
 */
function pickAccount(providerId, opts) {
  const options = opts || {};
  const bucket = (pool.get(providerId) || []).filter((a) => a.enabled !== false);
  if (bucket.length === 0) return null;

  const now = Date.now();
  const healthy = bucket.filter((a) => !a.cooldownUntil || a.cooldownUntil <= now);
  const candidates = healthy.length > 0 ? healthy : bucket;

  if (options.exclude) {
    const excluded = options.exclude;
    const rest = candidates.filter((a) => !excluded.has(a.uid));
    if (rest.length > 0) return rest[0];
  }
  return candidates[0];
}

/** 标记账号进入冷却。 */
function cooldown(providerId, uid, ms) {
  const bucket = pool.get(providerId) || [];
  const account = bucket.find((a) => a.uid === uid);
  if (!account) return;
  account.cooldownUntil = Date.now() + ms;
  accounts.saveAll(flatten());
}

module.exports = {
  CAP,
  ACTION_CHECKIN,
  ACTION_TASKS,
  register,
  allProviders,
  provider,
  withCapability,
  taskCapable,
  pool,
  loadPool,
  addAccount,
  removeAccount,
  listAccounts,
  count,
  pickAccount,
  cooldown,
};
