'use strict';
// Guru 子代理团队插件 · runtime
//
// 作用：插件启用/宿主启动时，把随插件打包的 8 个子代理定义（agents/*.md）
//       写进全局子代理目录 ~/.guru/agents/，装完即用，无需手动复制。
//
// 协议（与宿主真实约定一致，参照 han / messenger 插件）：
//   宿主 → 插件 {jsonrpc:'2.0', id, method:'tool.invoke'|'hook.invoke'|'ui.invoke',
//                params:{handler:'tools.xxx'|'hooks.xxx'|'ui.xxx', args:{...}}}
//   插件 → 宿主 {jsonrpc:'2.0', id, result|error}
//   插件 → 宿主 {jsonrpc:'2.0', id:'host-N', method:'host.log', params:{...}}
//
// AICODE_HOME 由宿主指向当前 Guru 配置目录。

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG_ROOT = path.resolve(__dirname, '..');
const BUNDLED_AGENTS_DIR = path.join(PKG_ROOT, 'agents');
const MANIFEST_NAME = '.aicode-subagents-manifest.json';
const CONFIG_NAME = 'config.json';
const HOST_TIMEOUT_MS = 5000;
const PLUGIN_ID = 'jinghan.subagents-pack';

const DEFAULTS = {
  autoInstall: true,     // app.started / plugin.enabled 时自动安装
  overwrite: 'changed'   // 批量安装时同名文件策略；单个「安装」按钮一律强制覆盖
};

// ── JSON-RPC 传输 ────────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let hostSeq = 0;
const hostPending = new Map();

function hostCall(method, params) {
  const id = 'host-' + (++hostSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (hostPending.has(id)) {
        hostPending.delete(id);
        reject(Object.assign(new Error('宿主未在 ' + HOST_TIMEOUT_MS + 'ms 内回应 ' + method), { code: 'HOST_TIMEOUT' }));
      }
    }, HOST_TIMEOUT_MS);
    hostPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
  });
}
const log = (message) => hostCall('host.log', { level: 'info', message: '[子代理团队] ' + message }).catch(() => {});

// ── 路径解析 ─────────────────────────────────────────────────
function agentsHome() {
  return process.env.AICODE_HOME || path.join(os.homedir(), '.guru');
}
const agentsDir = () => path.join(agentsHome(), 'agents');
const manifestPath = () => path.join(agentsDir(), MANIFEST_NAME);
const configPath = () => path.join(
  process.env.AICODE_DATA_DIR || path.join(agentsHome(), 'plugins', 'data', PLUGIN_ID),
  CONFIG_NAME
);

// ── 配置读写（落插件自身 data 目录，不污染目标）──────────────
function normalizeConfig(raw) {
  const c = Object.assign({}, DEFAULTS, raw || {});
  c.autoInstall = c.autoInstall !== false;
  if (['always', 'changed', 'never'].indexOf(c.overwrite) < 0) c.overwrite = DEFAULTS.overwrite;
  return c;
}
function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch (e) {
    return normalizeConfig({});
  }
}
function writeConfig(patch) {
  const next = normalizeConfig(Object.assign({}, readConfig(), patch || {}));
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ── 清单：只记录本插件装过的文件，卸载时精准移除 ─────────────
function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    return { pluginId: PLUGIN_ID, files: Array.isArray(m.files) ? m.files : [] };
  } catch (e) {
    return { pluginId: PLUGIN_ID, files: [] };
  }
}
function writeManifest(files) {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const m = { pluginId: PLUGIN_ID, installedAt: new Date().toISOString(), files: files.slice().sort() };
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2), 'utf8');
  return m;
}
function removeManifest() {
  try {
    fs.unlinkSync(manifestPath());
    return true;
  } catch (e) {
    return false;
  }
}

// ── 内置定义枚举 ─────────────────────────────────────────────
function bundled() {
  if (!fs.existsSync(BUNDLED_AGENTS_DIR)) return [];
  return fs.readdirSync(BUNDLED_AGENTS_DIR)
    .filter((f) => /\.md$/i.test(f))
    .sort()
    .map((f) => {
      const buf = fs.readFileSync(path.join(BUNDLED_AGENTS_DIR, f));
      const head = buf.toString('utf8').slice(0, 800);
      const nameMatch = head.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
      const descMatch = head.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(/\.md$/i, ''),
        description: descMatch ? descMatch[1].trim() : '',
        bytes: buf.length
      };
    });
}

// ── 安装：把内置定义写进全局目录 ─────────────────────────────
function installAgents(opts) {
  const cfg = readConfig();
  const mode = (opts && opts.overwrite) || cfg.overwrite;
  const force = !!(opts && opts.force);
  const dir = agentsDir();
  fs.mkdirSync(dir, { recursive: true });

  const manifest = readManifest();
  const managed = new Set(manifest.files);
  const results = [];
  const written = [];

  for (const a of bundled()) {
    const target = path.join(dir, a.file);
    const src = fs.readFileSync(path.join(BUNDLED_AGENTS_DIR, a.file));
    const existed = fs.existsSync(target);
    let action = 'created';

    if (existed) {
      const same = fs.readFileSync(target).equals(src);
      if (same) {
        action = 'unchanged';
      } else if (!force && mode === 'never') {
        action = 'skipped-never';
      } else if (!force && mode === 'changed' && !managed.has(a.file)) {
        // 内容不同且不是我们之前装的（用户自建同名）：默认不覆盖
        action = 'skipped-user-file';
      } else {
        fs.copyFileSync(path.join(BUNDLED_AGENTS_DIR, a.file), target);
        action = 'updated';
      }
    } else {
      fs.copyFileSync(path.join(BUNDLED_AGENTS_DIR, a.file), target);
    }

    if (['created', 'updated', 'unchanged'].indexOf(action) >= 0) written.push(a.file);
    results.push({ file: a.file, name: a.name, action });
  }

  // 清单取「仍在管理且存在」的并集：保留本次写过的 + 之前管理且仍在的
  const keep = written.slice();
  for (const f of managed) {
    if (keep.indexOf(f) < 0 && fs.existsSync(path.join(dir, f)) && bundled().some((b) => b.file === f)) {
      keep.push(f);
    }
  }
  writeManifest(keep);

  return {
    ok: true,
    targetDir: dir,
    overwriteMode: mode,
    bundled: bundled().length,
    results,
    summary: {
      created: results.filter((r) => r.action === 'created').length,
      updated: results.filter((r) => r.action === 'updated').length,
      unchanged: results.filter((r) => r.action === 'unchanged').length,
      skipped: results.filter((r) => /^skipped/.test(r.action)).length
    }
  };
}

// ── 卸载/停用：只删清单里记录的文件，不动用户自己的定义 ──────
function cleanupAgents(reason) {
  const dir = agentsDir();
  const manifest = readManifest();
  const removed = [];
  const skipped = [];
  for (const f of manifest.files) {
    const p = path.join(dir, f);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(f);
      } else {
        skipped.push(f);
      }
    } catch (e) {
      skipped.push(f);
    }
  }
  removeManifest();
  return { ok: true, reason: reason || 'manual', targetDir: dir, removed, skipped };
}

// ── 单个安装 / 单个卸载 ──────────────────────────────────────
function installOne(file) {
  const a = bundled().find((b) => b.file === file);
  if (!a) throw new Error('插件里没有这个子代理：' + file);
  const dir = agentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, a.file);
  // 单个「安装」按钮：无条件用插件版本覆盖（含系统内置 explore.md）
  fs.copyFileSync(path.join(BUNDLED_AGENTS_DIR, a.file), target);
  const manifest = readManifest();
  if (manifest.files.indexOf(a.file) < 0) manifest.files.push(a.file);
  writeManifest(manifest.files);
  return { ok: true, action: 'installed', file: a.file, name: a.name, targetDir: dir };
}

function removeOne(file) {
  const dir = agentsDir();
  const manifest = readManifest();
  const p = path.join(dir, file);
  let removed = false;
  // 只删清单里记录的，避免误删用户自建文件
  if (manifest.files.indexOf(file) >= 0) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } } catch (e) {}
    manifest.files = manifest.files.filter((f) => f !== file);
    writeManifest(manifest.files);
  }
  return { ok: true, action: removed ? 'removed' : 'not-managed', file, removed };
}

// ── 状态汇总 ─────────────────────────────────────────────────
function status() {
  const dir = agentsDir();
  const manifest = readManifest();
  const installed = bundled().map((a) => {
    const p = path.join(dir, a.file);
    const exists = fs.existsSync(p);
    let matches = false;
    if (exists) {
      matches = fs.readFileSync(p).equals(fs.readFileSync(path.join(BUNDLED_AGENTS_DIR, a.file)));
    }
    return {
      file: a.file,
      name: a.name,
      description: a.description,
      installed: exists,
      matchesBundle: exists ? matches : null,
      managed: manifest.files.indexOf(a.file) >= 0,
      bytes: a.bytes
    };
  });
  const allInDir = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.md$/i.test(f) && f !== MANIFEST_NAME).sort()
    : [];
  return {
    ok: true,
    pluginId: PLUGIN_ID,
    pluginRoot: PKG_ROOT,
    bundledDir: BUNDLED_AGENTS_DIR,
    targetDir: dir,
    manifest: manifest.files,
    config: readConfig(),
    installed,
    allAgentFilesInDir: allInDir,
    summary: {
      bundled: installed.length,
      installed: installed.filter((a) => a.installed).length,
      upToDate: installed.filter((a) => a.matchesBundle === true).length,
      divergent: installed.filter((a) => a.matchesBundle === false).length,
      missing: installed.filter((a) => !a.installed).length
    },
    hint: '装好后「新开一个会话」主代理才能看到新子代理；已打开的会话沿用开场清单。'
  };
}

// ── handlers ─────────────────────────────────────────────────
const handlers = {
  // 生命周期 hooks
  'hooks.boot': async () => {
    const cfg = readConfig();
    if (!cfg.autoInstall) {
      await log('启动：autoInstall 关闭，跳过');
      return { ok: true, installed: false, reason: 'autoInstall=false' };
    }
    const r = installAgents(null);
    await log('启动自动安装：新增 ' + r.summary.created + '，更新 ' + r.summary.updated + '，跳过 ' + r.summary.skipped);
    return { ok: true, installed: true, summary: r.summary };
  },
  'hooks.pluginEnabled': async () => {
    const cfg = readConfig();
    if (!cfg.autoInstall) return { ok: true, installed: false, reason: 'autoInstall=false' };
    const r = installAgents(null);
    await log('插件启用自动安装：新增 ' + r.summary.created + '，更新 ' + r.summary.updated);
    return { ok: true, installed: true, summary: r.summary };
  },
  'hooks.pluginDisabled': async () => {
    // 停用即清理：用户要求「删除插件时也会删除子代理」
    const r = cleanupAgents('plugin.disabled');
    await log('插件停用：清理 ' + r.removed.length + ' 个定义');
    return { ok: true, cleaned: true, removed: r.removed };
  },
  'hooks.pluginUninstalled': async () => {
    const r = cleanupAgents('plugin.uninstalled');
    await log('插件卸载：清理 ' + r.removed.length + ' 个定义');
    return { ok: true, cleaned: true, removed: r.removed, skipped: r.skipped };
  },

  // AI 工具
  'tools.subagents_status': async () => status(),
  'tools.subagents_install': async (args) => {
    const r = installAgents(args || {});
    await log('手动安装：新增 ' + r.summary.created + '，更新 ' + r.summary.updated);
    return r;
  },
  'tools.subagents_remove': async () => {
    const r = cleanupAgents('manual');
    await log('手动移除：删除 ' + r.removed.length + ' 个定义');
    return r;
  },

  // 设置页
  'ui.status': async () => status(),
  'ui.install': async (args) => installAgents(args || {}),
  'ui.remove': async () => cleanupAgents('ui'),
  'ui.installOne': async (args) => installOne((args && args.file) || ''),
  'ui.removeOne': async (args) => removeOne((args && args.file) || ''),
  'ui.info': async () => ({
    ok: true,
    pluginId: PLUGIN_ID,
    bundled: bundled().map((a) => ({ file: a.file, name: a.name })),
    targetDir: agentsDir(),
    defaultMode: DEFAULTS
  })
};

// ── 宿主请求分发 ────────────────────────────────────────────
const CALL_METHODS = ['tool.invoke', 'hook.invoke', 'ui.invoke'];
const replyOk = (id, result) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message: String(message) } });

function handleHostRequest(id, method, params) {
  params = params || {};
  let handlerName = params.handler;
  let args = params.args;
  if (CALL_METHODS.indexOf(method) < 0) {
    if (handlers[method]) { handlerName = method; args = params; }
    else return replyErr(id, 'METHOD_UNKNOWN', method);
  }
  const handler = handlers[handlerName];
  if (typeof handler !== 'function') return replyErr(id, 'HANDLER_NOT_FOUND', handlerName || '(空)');
  Promise.resolve()
    .then(() => handler(args || {}))
    .then((result) => replyOk(id, result))
    .catch((error) => replyErr(id, 'PLUGIN_ERROR', (error && error.message) || error));
}

function handleHostResponse(id, message) {
  const p = hostPending.get(String(id));
  if (!p) return;
  hostPending.delete(String(id));
  if (message.error) {
    p.reject(new Error((message.error && message.error.message) || 'host error'));
  } else {
    p.resolve(message.result === undefined ? null : message.result);
  }
}

// ── 进程存活兜底 ────────────────────────────────────────────
process.on('uncaughtException', (error) => {
  try { send({ jsonrpc: '2.0', id: 'crash-' + Date.now(), error: { code: 'PLUGIN_UNCAUGHT', message: String((error && error.stack) || error) } }); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  try { send({ jsonrpc: '2.0', id: 'reject-' + Date.now(), error: { code: 'PLUGIN_UNHANDLED', message: String((reason && reason.message) || reason) } }); } catch (e) {}
});
const keepAlive = setInterval(() => {}, 1 << 30);
keepAlive.unref && keepAlive.unref();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch (e) { return; }
  try {
    if (message.method && message.id !== undefined) {
      handleHostRequest(message.id, message.method, message.params || {});
    } else if (message.id !== undefined) {
      handleHostResponse(message.id, message);
    }
  } catch (error) {
    if (message && message.id !== undefined) replyErr(message.id, 'PLUGIN_ERROR', (error && error.message) || error);
  }
});
rl.on('close', () => process.exit(0));

module.exports = { handlers, status, installAgents, cleanupAgents, installOne, removeOne, bundled, agentsDir };
