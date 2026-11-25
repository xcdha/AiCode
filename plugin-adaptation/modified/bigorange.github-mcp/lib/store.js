'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ID = 'bigorange.github-mcp';
const DATA_DIR = process.env.AICODE_DATA_DIR || path.join(os.homedir(), '.guru', 'plugins', 'data', PLUGIN_ID);
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

const DEFAULT_CONFIG = {
  port: 9999,
  host: '127.0.0.1',
  autoStart: true,
  oauthClientId: '',
  defaultRepo: '',
  cacheTtlSeconds: 300,
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    /* 某些挂载点不支持 chmod，忽略 */
  }
}

function readConfig() {
  return Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
}

function writeConfig(patch) {
  const next = Object.assign(readConfig(), patch || {});
  writeJson(CONFIG_FILE, next);
  return next;
}

function readAuth() {
  const auth = readJson(AUTH_FILE, null);
  if (!auth || !auth.token) return null;
  return auth;
}

function saveAuth(auth) {
  writeJson(AUTH_FILE, Object.assign({ savedAt: new Date().toISOString() }, auth));
  return readAuth();
}

function clearAuth() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (e) {
    /* 文件不存在即视为已清除 */
  }
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 12) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function readCache(key, ttlSeconds) {
  const cache = readJson(CACHE_FILE, {});
  const entry = cache[key];
  if (!entry) return null;
  const ttl = Number(ttlSeconds == null ? DEFAULT_CONFIG.cacheTtlSeconds : ttlSeconds);
  if (ttl > 0 && Date.now() - entry.at > ttl * 1000) return null;
  return entry.value;
}

function writeCache(key, value) {
  const cache = readJson(CACHE_FILE, {});
  cache[key] = { at: Date.now(), value };
  const keys = Object.keys(cache);
  if (keys.length > 40) {
    keys
      .sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
      .slice(0, keys.length - 40)
      .forEach((k) => delete cache[k]);
  }
  try {
    writeJson(CACHE_FILE, cache);
  } catch (e) {
    /* 缓存写失败不影响主流程 */
  }
}

module.exports = {
  PLUGIN_ID,
  DATA_DIR,
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  readAuth,
  saveAuth,
  clearAuth,
  maskToken,
  readCache,
  writeCache,
};
