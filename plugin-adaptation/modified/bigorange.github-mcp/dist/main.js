'use strict';

/**
 * GitHub MCP 插件 runtime。
 *
 * 三条通道共用同一套工具实现（lib/tools.js）：
 *   1. contributes.tools → 宿主 AI 直接调用，本会话立即可用
 *   2. contributes.mcp   → 本地 Streamable HTTP 服务，外部 MCP 客户端接入
 *   3. 配置页            → aicode.invoke 调本文件的 ui.* handler
 */

const readline = require('readline');
const store = require('../lib/store');
const gh = require('../lib/github');
const tools = require('../lib/tools');
const mcpServer = require('../lib/mcp-server');

const send = (message) => {
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch (e) {
    /* stdout 已关闭，进程即将退出 */
  }
};

// ── 宿主 RPC ────────────────────────────────────────────────

let hostSeq = 0;
const hostPending = new Map();

function hostCall(method, params) {
  const id = `host-${++hostSeq}`;
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
    setTimeout(() => {
      if (hostPending.has(id)) {
        hostPending.delete(id);
        reject(new Error(`宿主调用超时：${method}`));
      }
    }, 20000);
  });
}

tools.hostCall = hostCall;

async function hostLog(level, message) {
  try {
    await hostCall('host.log', { level, message });
  } catch (e) {
    process.stderr.write(`[github-mcp] ${level}: ${message}\n`);
  }
}

function hostNotify(title, message) {
  return hostCall('host.notify', { title, body: message }).catch(() => null);
}

// ── 设备码登录（OAuth Device Flow）───────────────────────────

let deviceLogin = null;

function deviceFlowClientId() {
  const config = store.readConfig();
  return String(config.oauthClientId || process.env.GITHUB_OAUTH_CLIENT_ID || '').trim();
}

async function beginDeviceLogin() {
  const clientId = deviceFlowClientId();
  if (!clientId) {
    throw new Error(
      '未配置 OAuth Client ID。请到配置页粘贴一个 GitHub OAuth App 的 Client ID（无客户端密钥的 Device Flow 方式），或用 Personal Access Token 登录。',
    );
  }
  const res = await gh.startDeviceFlow(clientId, 'repo read:org read:user');
  if (res.error) throw new Error(`${res.error_description || res.error}`);
  deviceLogin = {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri,
    expiresAt: Date.now() + Number(res.expires_in || 900) * 1000,
    interval: Number(res.interval || 5) * 1000,
    status: 'pending',
    startedAt: new Date().toISOString(),
    error: '',
    login: '',
  };
  pollDeviceLogin();
  return {
    ok: true,
    userCode: deviceLogin.userCode,
    verificationUri: deviceLogin.verificationUri,
    expiresIn: Math.round((deviceLogin.expiresAt - Date.now()) / 1000),
    interval: Math.round(deviceLogin.interval / 1000),
  };
}

async function pollDeviceLogin() {
  const current = deviceLogin;
  if (!current || current.status !== 'pending') return;
  const clientId = deviceFlowClientId();
  while (deviceLogin === current && current.status === 'pending') {
    if (Date.now() > current.expiresAt) {
      current.status = 'expired';
      current.error = '设备码已过期，请重新发起登录。';
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, current.interval));
    let res;
    try {
      res = await gh.pollDeviceToken(clientId, current.deviceCode);
    } catch (e) {
      current.status = 'error';
      current.error = String(e.message || e);
      return;
    }
    if (res.access_token) {
      try {
        const user = await gh.getUser(res.access_token);
        store.saveAuth({
          token: res.access_token,
          method: 'device',
          tokenType: res.token_type || 'bearer',
          scope: res.scope || '',
          login: user.login,
          name: user.name,
          avatar: user.avatar,
          scopes: user.scopes,
        });
        current.status = 'success';
        current.login = user.login;
        hostLog('info', `GitHub 设备码登录成功：${user.login}`);
        hostNotify('GitHub 登录成功', `已登录 ${user.login}`).catch(() => {});
      } catch (e) {
        current.status = 'error';
        current.error = `登录成功但读取账号失败：${String(e.message || e)}`;
      }
      return;
    }
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') {
      current.interval += 5000;
      continue;
    }
    if (res.error === 'expired_token') {
      current.status = 'expired';
      current.error = '设备码已过期，请重新发起登录。';
      return;
    }
    if (res.error === 'access_denied') {
      current.status = 'denied';
      current.error = '你已取消授权。';
      return;
    }
    if (res.error === 'incorrect_client_credentials' || res.error === 'device_flow_disabled') {
      current.status = 'error';
      current.error = res.error === 'device_flow_disabled'
        ? '该 OAuth App 未开启 Device Flow，请在其设置里勾选 Enable Device Flow。'
        : 'Client ID 无效。';
      return;
    }
    current.status = 'error';
    current.error = res.error_description || res.error || '未知错误';
    return;
  }
}

// ── 页面与工具 handler ──────────────────────────────────────

const uiHandlers = {
  // 探明宿主 MCP 层是否已识别并连接本插件登记的服务
  'ui.host.mcp': async () => {
    try {
      const status = await hostCall('host.mcp.status', {});
      return { ok: true, status };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },

  'ui.status': async () => {
    const config = store.readConfig();
    const auth = store.readAuth();
    const out = {
      ok: true,
      loggedIn: !!auth,
      account: auth
        ? {
            login: auth.login || '',
            name: auth.name || '',
            avatar: auth.avatar || '',
            method: auth.method || 'token',
            scopes: String(auth.scopes || auth.scope || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            tokenMasked: store.maskToken(auth.token),
            savedAt: auth.savedAt || '',
          }
        : null,
      config: {
        port: config.port,
        host: config.host,
        autoStart: config.autoStart,
        defaultRepo: config.defaultRepo,
        oauthClientId: config.oauthClientId,
        cacheTtlSeconds: config.cacheTtlSeconds,
      },
      mcp: await mcpServer.statusLive(),
      deviceLogin: deviceLogin
        ? {
            status: deviceLogin.status,
            userCode: deviceLogin.userCode,
            verificationUri: deviceLogin.verificationUri,
            error: deviceLogin.error,
            login: deviceLogin.login,
            expiresIn: Math.max(0, Math.round((deviceLogin.expiresAt - Date.now()) / 1000)),
          }
        : null,
    };
    if (auth) {
      try {
        out.rate = await gh.getRateLimit(auth.token);
      } catch (e) {
        out.rateError = String(e.message || e);
      }
    }
    return out;
  },

  'ui.login.webview': async () => ({
    ok: false,
    needManual: true,
    error: 'Guru 不提供内嵌网页登录。请在浏览器生成 GitHub Token，再手动粘贴或从剪贴板导入。',
  }),

  'ui.login.token': async (args) => {
    const token = String((args && args.token) || '').trim();
    if (!token) throw new Error('请粘贴 Personal Access Token。');
    const user = await gh.getUser(token);
    store.saveAuth({
      token,
      method: 'token',
      login: user.login,
      name: user.name,
      avatar: user.avatar,
      scopes: user.scopes,
    });
    store.writeCache('dashboard', null);
    return {
      ok: true,
      login: user.login,
      name: user.name,
      avatar: user.avatar,
      scopes: user.scopes ? user.scopes.split(',').map((s) => s.trim()) : [],
      privateRepos: user.totalPrivateRepos,
    };
  },

  'ui.login.device.start': async () => beginDeviceLogin(),

  'ui.login.device.status': async () =>
    deviceLogin
      ? {
          status: deviceLogin.status,
          userCode: deviceLogin.userCode,
          verificationUri: deviceLogin.verificationUri,
          error: deviceLogin.error,
          login: deviceLogin.login,
          expiresIn: Math.max(0, Math.round((deviceLogin.expiresAt - Date.now()) / 1000)),
        }
      : { status: 'idle' },

  'ui.login.device.cancel': async () => {
    if (deviceLogin && deviceLogin.status === 'pending') {
      deviceLogin.status = 'canceled';
      deviceLogin.error = '已取消。';
    }
    return { ok: true };
  },

  'ui.logout': async () => {
    store.clearAuth();
    deviceLogin = null;
    return { ok: true };
  },

  'ui.config.save': async (args) => {
    const patch = {};
    if (args && args.port !== undefined) patch.port = Number(args.port) || 9999;
    if (args && args.host !== undefined) patch.host = String(args.host || '127.0.0.1');
    if (args && args.autoStart !== undefined) patch.autoStart = !!args.autoStart;
    if (args && args.defaultRepo !== undefined) patch.defaultRepo = String(args.defaultRepo || '').trim();
    if (args && args.oauthClientId !== undefined) patch.oauthClientId = String(args.oauthClientId || '').trim();
    if (args && args.cacheTtlSeconds !== undefined) patch.cacheTtlSeconds = Math.max(0, Number(args.cacheTtlSeconds) || 0);
    const config = store.writeConfig(patch);
    const portChanged =
      args && args.port !== undefined && Number(args.port) !== mcpServer.status().port;
    return { ok: true, config, needRestart: portChanged && mcpServer.status().running };
  },

  'ui.mcp.start': async () => {
    try {
      const status = await mcpServer.start();
      return { ok: true, mcp: status };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), mcp: mcpServer.status() };
    }
  },

  'ui.probe.openUrl': async () => {
    try {
      const result = await hostCall('host.ui.openUrl', { url: 'https://github.com/settings/tokens' });
      return { ok: true, method: 'host.ui.openUrl', result };
    } catch (e) {
      return { ok: false, method: 'host.ui.openUrl', error: String((e && e.message) || e) };
    }
  },

  'ui.mcp.status': async () => ({ ok: true, mcp: mcpServer.status() }),

  'ui.mcp.stop': async () => ({ ok: true, mcp: await mcpServer.stop() }),

  'ui.mcp.restart': async () => {
    try {
      const status = await mcpServer.restart();
      return { ok: true, mcp: status };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), mcp: mcpServer.status() };
    }
  },

  'ui.repos.preview': async (args) => {
    const auth = store.readAuth();
    if (!auth) return { ok: false, error: 'NOT_LOGGED_IN', repos: [] };
    try {
      const res = await gh.listRepos(auth.token, { perPage: Math.min(Number(args && args.perPage) || 10, 50) });
      return {
        ok: true,
        repos: res.items.map((item) => ({
          fullName: item.full_name,
          private: !!item.private,
          description: item.description || '',
          language: item.language || '',
          stars: item.stargazers_count || 0,
          pushedAt: item.pushed_at || '',
        })),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), repos: [] };
    }
  },
};

const handlers = Object.assign({}, uiHandlers);

tools.TOOLS.forEach((tool) => {
  handlers[`tools.${tool.name}`] = tool.handler;
});

const CALL_METHODS = ['tool.invoke', 'hook.invoke', 'ui.invoke'];

function handleHostRequest(id, method, params) {
  params = params || {};
  if (CALL_METHODS.indexOf(method) < 0) {
    return send({ jsonrpc: '2.0', id, error: { code: 'METHOD_UNKNOWN', message: method } });
  }
  const handler = handlers[params.handler];
  if (typeof handler !== 'function') {
    return send({ jsonrpc: '2.0', id, error: { code: 'HANDLER_NOT_FOUND', message: params.handler } });
  }
  Promise.resolve()
    .then(() => handler(params.args || {}))
    .then((result) => send({ jsonrpc: '2.0', id, result: result === undefined ? null : result }))
    .catch((error) =>
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: (error && error.code) || 'PLUGIN_ERROR',
          message: String((error && error.message) || error),
        },
      }),
    );
}

// ── 进程生命周期 ────────────────────────────────────────────

process.on('uncaughtException', (error) => {
  process.stderr.write(`[github-mcp] uncaughtException: ${(error && error.stack) || error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[github-mcp] unhandledRejection: ${(reason && reason.stack) || reason}\n`);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    return;
  }
  try {
    if (message.method && message.id !== undefined) {
      handleHostRequest(message.id, message.method, message.params || {});
      return;
    }
    if (message.id !== undefined && hostPending.has(message.id)) {
      const pending = hostPending.get(message.id);
      hostPending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || '宿主调用失败'));
      else pending.resolve(message.result);
    }
  } catch (e) {
    process.stderr.write(`[github-mcp] line handler: ${e && e.message}\n`);
  }
});

rl.on('close', () => {
  process.stderr.write('[github-mcp] stdin 关闭，保持常驻\n');
});

setInterval(() => {}, 1 << 30);

async function autoStart() {
  const config = store.readConfig();
  if (!config.autoStart) {
    process.stderr.write('[github-mcp] 自动启动已关闭\n');
    return;
  }
  const delays = [0, 500, 1500, 4000];
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]) await new Promise((resolve) => setTimeout(resolve, delays[i]));
    try {
      const status = await mcpServer.start();
      process.stderr.write(`[github-mcp] MCP 服务已启动：${status.url}\n`);
      return;
    } catch (e) {
      const message = String((e && e.message) || e);
      process.stderr.write(`[github-mcp] 第 ${i + 1} 次启动失败：${message}\n`);
      if (e && e.code === 'EADDRINUSE') return;
      if (/EADDRINUSE|已被占用/.test(message)) return;
    }
  }
  process.stderr.write('[github-mcp] 自动启动放弃，可在配置页手动启动\n');
}

process.on('SIGTERM', async () => {
  await mcpServer.stop().catch(() => {});
  process.exit(0);
});

autoStart();
