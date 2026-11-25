'use strict';

/**
 * 插件 runtime 入口。
 *
 * 宿主通过 stdin/stdout 上的 JSON-RPC 单行消息调用我们：
 *   method 固定是 tool.invoke / hook.invoke / ui.invoke 三者之一，
 *   handler 名在 params.handler，参数在 params.args。
 */

const readline = require('readline');

const registry = require('../lib/registry');
const accounts = require('../lib/accounts');
const gateway = require('../lib/gateway');
const config = require('../lib/config');

// ── 宿主通道 ──────────────────────────────────────────────────

const send = (msg) => {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    // stdout 关闭即插件被结束，忽略
  }
};

let hostSeq = 0;
const hostPending = new Map();

/** 调宿主能力，等应答。 */
function hostCall(method, params) {
  const id = 'host-' + ++hostSeq;
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
    // 宿主不保证每个方法都有实现，超时兜底避免永久挂起
    setTimeout(() => {
      if (hostPending.has(id)) {
        hostPending.delete(id);
        reject(new Error(`宿主方法 ${method} 超时`));
      }
    }, 30000);
  });
}

function handleHostResponse(msg) {
  const pending = hostPending.get(msg.id);
  if (!pending) return;
  hostPending.delete(msg.id);
  if (msg.error) pending.reject(new Error(msg.error.message || '宿主调用失败'));
  else pending.resolve(msg.result);
}

// 日志接到宿主的 host.log
accounts.setLogSink((level, message) => {
  hostCall('host.log', { level, message: String(message) }).catch(() => {
    try {
      process.stderr.write(`[${level}] ${message}\n`);
    } catch (e) {
      // 忽略
    }
  });
});

// ── 供应商装配 ────────────────────────────────────────────────

function bootProviders() {
  // 按供应商 id 的字母序注册，便于日志排查。
  // 新增供应商只需在这里加一行 require + 一个文件。
  const providers = [
    require('../providers/agentmore'),
    require('../providers/astudio'),
    require('../providers/catpaw'),
    require('../providers/codebuddy'),
    require('../providers/dangbei'),
    require('../providers/deepseek'),
    require('../providers/loomy'),
    require('../providers/meoo'),
    require('../providers/qoder'),
    require('../providers/raccoon'),
    require('../providers/tabbit'),
    require('../providers/trae'),
    require('../providers/wenxin'),
    require('../providers/zhipu'),
  ];
  for (const p of providers) {
    try {
      registry.register(p);
    } catch (e) {
      accounts.log('error', `注册 ${p && p.id} 失败：${e.message}`);
    }
  }
  registry.loadPool();
  accounts.log('info', `已注册 ${registry.allProviders().length} 家供应商，账号 ${registry.listAccounts().length} 个`);
}

// ── handler ───────────────────────────────────────────────────

const handlers = {
  // ── 状态 ──
  'tools.status': async () => {
    const cfg = config.read();
    return {
      running: gateway.isRunning(),
      port: gateway.port() || cfg.port,
      providers: registry.allProviders().map((p) => ({
        id: p.id,
        name: p.displayName,
        accounts: registry.count(p.id),
        capabilities: p.capabilities || [],
      })),
      totalAccounts: registry.listAccounts().length,
    };
  },

  'tools.start': async (args) => {
    const cfg = config.read();
    const port = Number(args && args.port) || cfg.port || 7864;
    const keys = (cfg.apiKeys || []).slice();
    gateway.setApiKeys(keys);
    const result = await gateway.start(port, keys);
    config.write(Object.assign({}, cfg, { port }));
    return { ok: true, port: result.port, baseUrl: `http://127.0.0.1:${result.port}/v1` };
  },

  'tools.stop': async () => {
    const result = await gateway.stop();
    return { ok: true, stopped: result.stopped };
  },

  'tools.models': async (args) => {
    const providerId = args && args.provider;
    const providers = providerId
      ? [registry.provider(providerId)].filter(Boolean)
      : registry.allProviders();
    const out = [];
    for (const p of providers) {
      const account = registry.pickAccount(p.id);
      if (!account) {
        out.push({ provider: p.id, name: p.displayName, error: '没有账号', models: [] });
        continue;
      }
      try {
        const list = await p.fetchModels(account);
        out.push({ provider: p.id, name: p.displayName, models: list || [] });
      } catch (e) {
        out.push({ provider: p.id, name: p.displayName, error: e.message, models: [] });
      }
    }
    return { providers: out };
  },

  // ── 账号 ──
  'tools.accounts': async () => {
    const out = registry.allProviders().map((p) => ({
      provider: p.id,
      name: p.displayName,
      accounts: registry.listAccounts(p.id).map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        enabled: a.enabled !== false,
        credit: a.credit,
        creditText: a.creditText,
        region: a.region,
        checkedInToday: isCheckedInToday(a),
      })),
    }));
    return { providers: out };
  },

  'tools.add_account': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider) throw new Error(`未知供应商：${providerId}`);
    const raw = String((args && args.credentials) || '');
    const list = provider.importCredentials(raw);
    if (list.length === 0) throw new Error('没有解析出任何账号');
    for (const account of list) registry.addAccount(account);
    return { ok: true, added: list.length, accounts: list.map((a) => ({ uid: a.uid, nickname: a.nickname })) };
  },

  'tools.remove_account': async (args) => {
    const providerId = String((args && args.provider) || '');
    const uid = String((args && args.uid) || '');
    registry.removeAccount(providerId, uid);
    return { ok: true };
  },

  'tools.refresh_credit': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.fetchCredit !== 'function') {
      throw new Error('该供应商不支持刷新积分');
    }
    const results = [];
    for (const account of registry.listAccounts(providerId)) {
      try {
        const credit = await provider.fetchCredit(account);
        account.credit = credit.credit;
        account.creditText = credit.creditText || '';
        account.creditAt = Date.now();
        results.push({ uid: account.uid, ok: true, credit: credit.credit });
      } catch (e) {
        results.push({ uid: account.uid, ok: false, error: e.message });
      }
    }
    accounts.saveAll(registry.listAccounts());
    return { results };
  },

  // ── 签到与任务 ──
  'tools.checkin': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.checkin !== 'function') {
      return { unsupported: true, message: '该供应商不支持签到' };
    }
    const results = [];
    for (const account of registry.listAccounts(providerId)) {
      try {
        const r = await provider.checkin(account);
        if (r.ok) account.checkinAt = Date.now();
        results.push({ uid: account.uid, ok: r.ok, message: r.message });
      } catch (e) {
        results.push({ uid: account.uid, ok: false, message: e.message });
      }
    }
    accounts.saveAll(registry.listAccounts());
    return { results };
  },

  'tools.tasks': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.taskList !== 'function') {
      return { unsupported: true, message: '该供应商没有任务中心' };
    }
    const account = registry.pickAccount(providerId);
    if (!account) throw new Error('没有可用账号');
    const result = await provider.taskList(account);
    return { provider: providerId, tasks: result.tasks || [], error: result.error || '' };
  },

  'tools.run_tasks': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.runTasks !== 'function') {
      return { unsupported: true, message: '该供应商没有可执行的任务' };
    }
    const results = [];
    for (const account of registry.listAccounts(providerId)) {
      try {
        const r = await provider.runTasks(account);
        results.push({ uid: account.uid, ok: r.ok, message: r.message });
      } catch (e) {
        results.push({ uid: account.uid, ok: false, message: e.message });
      }
    }
    return { results };
  },

  // ── 供页面调用 ──
  'ui.providers': async () => {
    const icons = require('../lib/icons');
    return {
      providers: registry.allProviders().map((p) => ({
        id: p.id,
        name: p.displayName,
        authKind: p.authKind || '',
        capabilities: p.capabilities || [],
        accounts: registry.count(p.id),
        // 图标给 data URI，页面直接塞 <img src>
        icon: icons.dataUri(p.id),
        // 能否 WebView 登录（要同时有 loginUrl 与 accountFromCookie）
        canWebLogin:
          typeof p.loginUrl === 'function' && typeof p.accountFromCookie === 'function',
        loginUrl: typeof p.loginUrl === 'function' ? p.loginUrl() : '',
      })),
    };
  },

  'ui.accounts': async (args) => {
    const providerId = String((args && args.provider) || '');
    return {
      accounts: registry.listAccounts(providerId).map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        enabled: a.enabled !== false,
        credit: a.credit,
        creditText: a.creditText,
        checkedInToday: isCheckedInToday(a),
      })),
    };
  },

  'ui.login_url': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.loginUrl !== 'function') {
      throw new Error('该供应商不支持 WebView 登录');
    }
    return { url: provider.loginUrl(args && args.redirect) };
  },

  'ui.login_with_code': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider || typeof provider.accountFromCode !== 'function') {
      throw new Error('该供应商不支持 code 换凭证');
    }
    const account = await provider.accountFromCode(
      String((args && args.code) || ''),
      args && args.redirect,
    );
    registry.addAccount(account);
    return { ok: true, uid: account.uid, nickname: account.nickname };
  },

  'ui.login_with_cookie': async (args) => {
    const providerId = String((args && args.provider) || '');
    const provider = registry.provider(providerId);
    if (!provider) throw new Error(`未知供应商：${providerId}`);
    if (typeof provider.accountFromCookie !== 'function') {
      throw new Error('该供应商不支持 cookie 登录，请手工粘贴');
    }
    const account = await provider.accountFromCookie(
      String((args && args.cookie) || ''),
      args && args.region,
    );
    registry.addAccount(account);
    return {
      ok: true,
      uid: account.uid,
      nickname: account.nickname || account.uid,
    };
  },

  'ui.state': async () => {
    const cfg = config.read();
    return {
      running: gateway.isRunning(),
      port: gateway.port() || cfg.port,
      baseUrl: `http://127.0.0.1:${gateway.port() || cfg.port}/v1`,
      apiKeys: (cfg.apiKeys || []).length,
    };
  },
};

function isCheckedInToday(account) {
  if (!account || !account.checkinAt) return false;
  const d = new Date(account.checkinAt);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// ── 分发 ──────────────────────────────────────────────────────

const CALL_METHODS = ['tool.invoke', 'hook.invoke', 'ui.invoke'];

function handleHostRequest(id, method, params) {
  params = params || {};
  if (CALL_METHODS.indexOf(method) < 0) {
    return send({ jsonrpc: '2.0', id, error: { code: 'METHOD_UNKNOWN', message: String(method) } });
  }
  const name = params.handler;
  const handler = handlers[name];
  if (typeof handler !== 'function') {
    return send({ jsonrpc: '2.0', id, error: { code: 'HANDLER_NOT_FOUND', message: String(name) } });
  }
  Promise.resolve()
    .then(() => handler(params.args || {}))
    .then((result) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result }))
    .catch((error) =>
      send({
        jsonrpc: '2.0',
        id,
        error: { code: 'PLUGIN_ERROR', message: String((error && error.message) || error) },
      }),
    );
}

// ── 启动 ──────────────────────────────────────────────────────

process.on('uncaughtException', (e) => {
  try {
    send({
      jsonrpc: '2.0',
      id: 'crash-' + Date.now(),
      error: { code: 'PLUGIN_UNCAUGHT', message: String((e && e.stack) || e) },
    });
  } catch (x) {
    // 忽略
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    send({
      jsonrpc: '2.0',
      id: 'reject-' + Date.now(),
      error: { code: 'PLUGIN_UNHANDLED', message: String((reason && reason.message) || reason) },
    });
  } catch (x) {
    // 忽略
  }
});

bootProviders();

// 自动启动网关：插件启用即提供服务，省得用户每次手动点
try {
  const cfg = config.read();
  gateway.setApiKeys(cfg.apiKeys || []);
  gateway.start(cfg.port || 7864, cfg.apiKeys || []).catch((e) => {
    accounts.log('error', `网关自动启动失败：${e.message}`);
  });
} catch (e) {
  accounts.log('error', `读取配置失败：${e.message}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  try {
    if (msg.method && msg.id !== undefined) {
      handleHostRequest(msg.id, msg.method, msg.params || {});
    } else if (msg.id !== undefined) {
      handleHostResponse(msg);
    }
  } catch (e) {
    // 单条消息异常不影响后续
  }
});

rl.on('close', () => {
  gateway.stop().finally(() => process.exit(0));
});
