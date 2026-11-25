'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const gh = require('./github');

const SCHEMA_DIR = path.join(__dirname, '..', 'schemas');

// 工具名用下划线，schema 文件名也用下划线；清单里引用时允许连字符写法
function schema(name) {
  const base = String(name);
  const candidates = [
    `${base}.input.json`,
    `${base.replace(/_/g, '-')}.input.json`,
    `${base.replace(/-/g, '_')}.input.json`,
  ];
  for (const name2 of candidates) {
    const file = path.join(SCHEMA_DIR, name2);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  throw new Error(`缺少工具 ${base} 的 inputSchema（试过 ${candidates.join(', ')}）`);
}

function currentToken() {
  const auth = store.readAuth();
  return auth && auth.token ? auth.token : null;
}

// 账号类工具必须登录；仓库类工具允许匿名读公共仓库，登录后自动获得私有仓库权限
function requireToken() {
  const token = currentToken();
  if (!token) {
    const error = new Error(
      '尚未登录 GitHub。请在插件配置页完成登录，或调用 login 工具传入 Personal Access Token。',
    );
    error.code = 'NOT_LOGGED_IN';
    throw error;
  }
  return token;
}

function normalizeRepo(input, fallback) {
  let value = String(input || '').trim();
  if (!value) value = String(fallback || '').trim();
  if (!value) throw new Error('缺少仓库参数，格式为 owner/repo，例如 octocat/Hello-World');
  const fromUrl = value.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (fromUrl) value = `${fromUrl[1]}/${fromUrl[2]}`;
  value = value.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = value.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`仓库格式不对：${value}。应为 owner/repo，例如 octocat/Hello-World`);
  }
  return `${parts[0]}/${parts[1]}`;
}

function repoSummary(item) {
  return {
    fullName: item.full_name,
    name: item.name,
    private: !!item.private,
    fork: !!item.fork,
    archived: !!item.archived,
    description: item.description || '',
    language: item.language || '',
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    openIssues: item.open_issues_count || 0,
    defaultBranch: item.default_branch || '',
    pushedAt: item.pushed_at || '',
    updatedAt: item.updated_at || '',
    htmlUrl: item.html_url || '',
    topics: Array.isArray(item.topics) ? item.topics : [],
  };
}

function issueSummary(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    kind: item.pull_request ? 'pull_request' : 'issue',
    user: item.user && item.user.login,
    labels: (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    comments: item.comments || 0,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    htmlUrl: item.html_url,
  };
}

function pullSummary(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    draft: !!item.draft,
    user: item.user && item.user.login,
    head: item.head && item.head.ref,
    base: item.base && item.base.ref,
    mergedAt: item.merged_at || null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    htmlUrl: item.html_url,
  };
}

function commitSummary(item) {
  const commit = item.commit || {};
  const author = commit.author || {};
  return {
    sha: String(item.sha || '').slice(0, 10),
    message: String(commit.message || '').split('\n')[0],
    author: author.name || (item.author && item.author.login) || '',
    date: author.date || '',
    htmlUrl: item.html_url || '',
  };
}

function decodeBase64(content) {
  return Buffer.from(String(content || '').replace(/\s/g, ''), 'base64').toString('utf8');
}

function limitText(text, max) {
  const cap = max || 40000;
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

// contents API 对超过 1MB 的文件返回 encoding=none 且 content 为空，此时必须走 raw 通道
async function readFileText(token, fullName, data, ref) {
  if (data.encoding === 'base64' && data.content) return decodeBase64(data.content);
  if (data.size > 0 && (data.encoding === 'none' || !data.content)) {
    return gh.getRawFile(token, fullName, data.path, ref);
  }
  return String(data.content || '');
}

// ── 工具实现 ────────────────────────────────────────────────

async function toolStatus() {
  const config = store.readConfig();
  const auth = store.readAuth();
  const running = await require('./mcp-server').statusLive();
  if (!auth) {
    return {
      ok: true,
      loggedIn: false,
      mcp: running,
      config: { port: config.port, host: config.host, autoStart: config.autoStart },
      summary: '未登录。在插件配置页登录 GitHub 后即可拉取仓库。',
    };
  }
  let user = null;
  let rate = null;
  let error = '';
  try {
    user = await gh.getUser(auth.token);
    const limits = await gh.getRateLimit(auth.token);
    rate = limits && limits.resources ? limits.resources.core : null;
  } catch (e) {
    error = String(e.message || e);
  }
  return {
    ok: !error,
    loggedIn: true,
    user: user
      ? {
          login: user.login,
          name: user.name,
          avatar: user.avatar,
          htmlUrl: user.htmlUrl,
          type: user.type,
          publicRepos: user.publicRepos,
          totalPrivateRepos: user.totalPrivateRepos,
          scopes: user.scopes ? user.scopes.split(',').map((s) => s.trim()) : [],
        }
      : null,
    token: { masked: store.maskToken(auth.token), loginMethod: auth.method || 'token' },
    rate,
    mcp: running,
    config: { port: config.port, host: config.host, autoStart: config.autoStart, defaultRepo: config.defaultRepo },
    error: error || undefined,
    summary: error
      ? `Token 校验失败：${error}`
      : `已登录 ${user.login}${user.totalPrivateRepos ? `（含 ${user.totalPrivateRepos} 个私有仓库）` : ''}。`,
  };
}

async function toolLogin(args) {
  const token = String(args.token || '').trim();
  if (!token) throw new Error('缺少 token。Personal Access Token 在 GitHub → Settings → Developer settings → Personal access tokens 生成。');
  const user = await gh.getUser(token);
  store.saveAuth({
    token,
    method: 'token',
    login: user.login,
    name: user.name,
    avatar: user.avatar,
    scopes: user.scopes,
  });
  return {
    ok: true,
    login: user.login,
    name: user.name,
    scopes: user.scopes ? user.scopes.split(',').map((s) => s.trim()) : [],
    privateRepos: user.totalPrivateRepos,
    summary: `登录成功：${user.login}${user.totalPrivateRepos ? `，可访问 ${user.totalPrivateRepos} 个私有仓库` : ''}。`,
  };
}

async function toolLogout() {
  store.clearAuth();
  return { ok: true, summary: '已退出登录，本地 Token 已删除。' };
}

async function toolListRepos(args) {
  const token = requireToken();
  // /user/repos 必须认证：未登录时无法枚举「我的仓库」
  const perPage = Math.min(Math.max(Number(args.perPage) || 30, 1), 100);
  const page = Math.max(Number(args.page) || 1, 1);
  const res = await gh.listRepos(token, {
    perPage,
    page,
    sort: args.sort || 'updated',
    visibility: args.visibility || 'all',
    affiliation: args.affiliation,
  });
  const items = res.items.filter((item) => {
    if (args.kind === 'owner' && item.owner && item.owner.login) {
      const me = (store.readAuth() || {}).login;
      if (me && item.owner.login !== me) return false;
    }
    if (args.kind === 'private' && !item.private) return false;
    if (args.kind === 'public' && item.private) return false;
    if (args.kind === 'fork' && !item.fork) return false;
    if (args.kind === 'source' && item.fork) return false;
    return true;
  });
  const repos = items.map(repoSummary);
  return {
    ok: true,
    count: repos.length,
    page,
    perPage,
    hasMore: items.length === perPage,
    rate: res.rate,
    repos,
    summary: `第 ${page} 页取到 ${repos.length} 个仓库${args.kind ? `（筛选：${args.kind}）` : ''}。`,
  };
}

async function toolRepoInfo(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const data = await gh.getRepo(token, fullName);
  const languages = await gh.getLanguages(token, fullName);
  const totalBytes = Object.values(languages).reduce((sum, n) => sum + n, 0) || 1;
  const languageShare = Object.keys(languages)
    .map((name) => ({ name, percent: Math.round((languages[name] / totalBytes) * 1000) / 10 }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 6);
  return {
    ok: true,
    repo: Object.assign(repoSummary(data), {
      sizeKb: data.size,
      license: (data.license && data.license.spdx_id) || '',
      createdAt: data.created_at,
      homepage: data.homepage || '',
      subscribers: data.subscribers_count || 0,
      watchers: data.watchers_count || 0,
      network: data.network_count || 0,
      disabled: !!data.disabled,
      allowForking: data.allow_forking,
    }),
    languageShare,
    summary: `${data.full_name}｜${data.private ? '私有' : '公开'}｜★${data.stargazers_count}｜主要语言 ${data.language || (languageShare[0] && languageShare[0].name) || '未统计'}`,
  };
}

async function toolRepoOverview(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const cacheKey = `overview:${fullName}:${args.branch || ''}`;
  const config = store.readConfig();
  const cached = args.fresh ? null : store.readCache(cacheKey, config.cacheTtlSeconds);
  if (cached) return Object.assign({ cached: true }, cached);

  const repo = await gh.getRepo(token, fullName);
  const branch = args.branch || repo.default_branch;
  const [languages, branches, commits, issues, pulls] = await Promise.all([
    gh.getLanguages(token, fullName).catch(() => ({})),
    gh.listBranches(token, fullName, { perPage: 10 }).catch(() => ({ items: [] })),
    gh.listCommits(token, fullName, { perPage: 8, sha: branch }).catch(() => ({ items: [] })),
    gh.listIssues(token, fullName, { state: 'open', perPage: 8 }).catch(() => ({ items: [] })),
    gh.listPulls(token, fullName, { state: 'open', perPage: 8 }).catch(() => ({ items: [] })),
  ]);

  const totalBytes = Object.values(languages).reduce((sum, n) => sum + n, 0) || 1;
  const result = {
    ok: true,
    repo: repoSummary(repo),
    branch,
    languageShare: Object.keys(languages)
      .map((name) => ({ name, percent: Math.round((languages[name] / totalBytes) * 1000) / 10 }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 6),
    branches: branches.items.map((b) => b.name),
    commits: commits.items.map(commitSummary),
    openIssues: issues.items.filter((i) => !i.pull_request).map(issueSummary),
    openPulls: pulls.items.map(pullSummary),
    summary: `${repo.full_name}（${branch}）：${commits.items.length} 条最近提交，${issues.items.filter((i) => !i.pull_request).length} 个未关闭 issue，${pulls.items.length} 个待合并 PR。`,
  };
  store.writeCache(cacheKey, result);
  return result;
}

async function toolListIssues(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const res = await gh.listIssues(token, fullName, {
    state: args.state || 'open',
    perPage: Math.min(Math.max(Number(args.perPage) || 20, 1), 100),
    page: Math.max(Number(args.page) || 1, 1),
  });
  const items = res.items.filter((i) => !i.pull_request).map(issueSummary);
  return { ok: true, repo: fullName, count: items.length, rate: res.rate, issues: items, summary: `${fullName} 有 ${items.length} 个 ${args.state || 'open'} issue。` };
}

async function toolListPulls(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const res = await gh.listPulls(token, fullName, {
    state: args.state || 'open',
    perPage: Math.min(Math.max(Number(args.perPage) || 20, 1), 100),
    page: Math.max(Number(args.page) || 1, 1),
  });
  const items = res.items.map(pullSummary);
  return { ok: true, repo: fullName, count: items.length, rate: res.rate, pulls: items, summary: `${fullName} 有 ${items.length} 个 ${args.state || 'open'} PR。` };
}

async function toolListCommits(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const res = await gh.listCommits(token, fullName, {
    perPage: Math.min(Math.max(Number(args.perPage) || 20, 1), 100),
    page: Math.max(Number(args.page) || 1, 1),
    sha: args.branch,
  });
  const items = res.items.map(commitSummary);
  return { ok: true, repo: fullName, branch: args.branch || '', count: items.length, rate: res.rate, commits: items, summary: `${fullName} 取到 ${items.length} 条提交。` };
}

async function toolListBranches(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const res = await gh.listBranches(token, fullName, {
    perPage: Math.min(Math.max(Number(args.perPage) || 50, 1), 100),
    page: Math.max(Number(args.page) || 1, 1),
  });
  const items = res.items.map((b) => ({ name: b.name, sha: String((b.commit && b.commit.sha) || '').slice(0, 10), protected: !!b.protected }));
  return { ok: true, repo: fullName, count: items.length, branches: items, summary: `${fullName} 有 ${items.length} 个分支。` };
}

async function toolListDir(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  const data = await gh.getContent(token, fullName, args.path || '', args.ref);
  const list = Array.isArray(data) ? data : [data];
  const entries = list.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type,
    size: item.size,
    sha: String(item.sha || '').slice(0, 10),
    htmlUrl: item.html_url,
  }));
  return { ok: true, repo: fullName, path: args.path || '/', ref: args.ref || '', count: entries.length, entries, summary: `${fullName}/${args.path || ''} 下有 ${entries.length} 项。` };
}

async function toolReadFile(args) {
  const token = currentToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  if (!args.path) throw new Error('缺少 path 参数，例如 src/index.js');
  const data = await gh.getContent(token, fullName, args.path, args.ref);
  if (Array.isArray(data)) throw new Error(`${args.path} 是目录，请用 list_dir 查看。`);
  if (data.type !== 'file') throw new Error(`${args.path} 不是普通文件（type=${data.type}）。`);
  const decoded = await readFileText(token, fullName, data, args.ref);
  const capped = limitText(decoded, Number(args.maxChars) || 40000);
  return {
    ok: true,
    repo: fullName,
    path: data.path,
    ref: args.ref || '',
    size: data.size,
    sha: String(data.sha || '').slice(0, 10),
    encoding: 'utf8',
    truncated: capped.truncated,
    content: capped.text,
    htmlUrl: data.html_url,
    summary: `读取 ${fullName}/${data.path}（${data.size} 字节${capped.truncated ? '，已截断' : ''}）。`,
  };
}

async function toolSearch(args) {
  const token = currentToken();
  const kind = args.type || 'repos';
  const query = String(args.query || '').trim();
  if (!query) throw new Error('缺少 query 参数。');
  const perPage = Math.min(Math.max(Number(args.perPage) || 20, 1), 100);
  const res = await gh.search(token, kind, query, { perPage, sort: args.sort, page: args.page });
  const payload = res.data || {};
  const items = (payload.items || []).map((item) => {
    if (kind === 'repos') return repoSummary(item);
    if (kind === 'code') {
      return {
        name: item.name,
        path: item.path,
        repo: item.repository && item.repository.full_name,
        htmlUrl: item.html_url,
        fragments: (item.text_matches || []).map((m) => String(m.fragment || '').slice(0, 200)),
      };
    }
    return issueSummary(item);
  });
  return {
    ok: true,
    type: kind,
    total: payload.total_count || 0,
    count: items.length,
    incomplete: !!payload.incomplete_results,
    rate: res.rate,
    items,
    summary: `搜索 ${kind}「${query}」命中 ${payload.total_count || 0} 条，返回 ${items.length} 条。`,
  };
}

async function toolCreateIssue(args) {
  const token = requireToken();
  const fullName = normalizeRepo(args.repo, store.readConfig().defaultRepo);
  if (!args.title) throw new Error('缺少 title 参数。');
  const data = await gh.createIssue(token, fullName, {
    title: args.title,
    body: args.body,
    labels: Array.isArray(args.labels) ? args.labels : undefined,
    assignees: Array.isArray(args.assignees) ? args.assignees : undefined,
  });
  return { ok: true, repo: fullName, issue: issueSummary(data), summary: `已创建 #${data.number}：${data.title}` };
}

async function toolDashboard(args) {
  const token = requireToken();
  const auth = store.readAuth() || {};
  const cached = args.fresh ? null : store.readCache('dashboard', 60);
  if (cached) return Object.assign({ cached: true }, cached);

  const [user, repos, assigned, review] = await Promise.all([
    gh.getUser(token),
    gh.listRepos(token, { perPage: 10, sort: 'pushed' }),
    gh.search(token, 'issues', 'is:open assignee:@me', { perPage: 10 }).catch(() => ({ data: { items: [], total_count: 0 } })),
    gh.search(token, 'issues', 'is:open review-requested:@me', { perPage: 10 }).catch(() => ({ data: { items: [], total_count: 0 } })),
  ]);
  const recent = repos.items.slice(0, 8).map(repoSummary);
  const result = {
    ok: true,
    user: {
      login: user.login,
      name: user.name,
      avatar: user.avatar,
      publicRepos: user.publicRepos,
      totalPrivateRepos: user.totalPrivateRepos,
      scopes: user.scopes ? user.scopes.split(',').map((s) => s.trim()) : [],
    },
    recentRepos: recent,
    assignedIssues: {
      total: (assigned.data && assigned.data.total_count) || 0,
      items: ((assigned.data && assigned.data.items) || []).map(issueSummary),
    },
    reviewRequests: {
      total: (review.data && review.data.total_count) || 0,
      items: ((review.data && review.data.items) || []).map(issueSummary),
    },
    token: { masked: store.maskToken(auth.token), method: auth.method || 'token' },
    summary: `${user.login}：最近活跃仓库 ${recent.length} 个，待处理 issue ${(assigned.data && assigned.data.total_count) || 0} 个，待评审 PR ${(review.data && review.data.total_count) || 0} 个。`,
  };
  store.writeCache('dashboard', result);
  return result;
}

async function toolProbeOpenUrl() {
  return {
    ok: true,
    supportedMethod: 'host.ui.openUrl',
    note: '网页登录需使用系统浏览器；Guru 不提供内嵌 WebView 登录桥。',
  };
}

async function toolHostMcpStatus() {
  // 由 dist/main.js 注入宿主调用器，避免 lib 层直接依赖 stdio
  const call = module.exports.hostCall;
  if (typeof call !== 'function') {
    return { ok: false, error: '宿主调用器未注入' };
  }
  const status = await call('host.mcp.status', {});
  const servers = (status && status.servers) || [];
  const github = servers.filter((s) => /github/i.test(s.name || ''));
  return {
    ok: true,
    all: servers,
    github,
    summary: github.length
      ? `宿主识别到 ${github.length} 个 github 相关服务器：` +
        github.map((s) => `${s.name}(${s.state}, ${s.toolCount} 个工具)`).join('；')
      : '宿主没有识别到 github 相关服务器。请确认 mcp.json 已保存，且插件已启动、9999 端口在监听。',
  };
}

const TOOLS = [
  {
    name: 'status',
    title: { 'zh-CN': '账号状态', default: 'Account status' },
    description: {
      'zh-CN': '查看 GitHub 登录状态、账号信息、API 配额与本地 MCP 服务地址。未登录时这一步告诉你该怎么登。',
      default: 'Show GitHub login state, account info, API quota and the local MCP endpoint.',
    },
    handler: toolStatus,
  },
  {
    name: 'probe_open_url',
    title: { 'zh-CN': '探测打开链接', default: 'Probe openUrl' },
    description: { 'zh-CN': '查看 Guru 支持的打开链接方法。', default: 'Report the supported Guru openUrl method.' },
    handler: toolProbeOpenUrl,
  },
  {
    name: 'host_mcp_status',
    title: { 'zh-CN': '宿主 MCP 状态', default: 'Host MCP status' },
    description: {
      'zh-CN': '查看宿主 MCP 层识别到的服务器列表，确认 github 这一项是否已连接。',
      default: 'Show MCP servers recognized by the host.',
    },
    handler: toolHostMcpStatus,
  },
  {
    name: 'login',
    title: { 'zh-CN': '登录 GitHub', default: 'Log in to GitHub' },
    description: {
      'zh-CN': '用 Personal Access Token 登录并保存到本地。登录后可访问该 Token 授权范围内的公开与私有仓库。',
      default: 'Log in with a personal access token and persist it locally.',
    },
    handler: toolLogin,
  },
  {
    name: 'logout',
    title: { 'zh-CN': '退出登录', default: 'Log out' },
    description: { 'zh-CN': '删除本地保存的 GitHub Token。', default: 'Delete the locally stored GitHub token.' },
    handler: toolLogout,
  },
  {
    name: 'dashboard',
    title: { 'zh-CN': '我的工作台', default: 'My dashboard' },
    description: {
      'zh-CN': '一次拿到：账号概览、最近推送的仓库、指派给我的未关闭 issue、等待我评审的 PR。适合「登录后先看看我有什么项目」的场景。',
      default: 'One-shot overview: account, recently pushed repos, assigned open issues, pending review requests.',
    },
    handler: toolDashboard,
  },
  {
    name: 'list_repos',
    title: { 'zh-CN': '列出仓库', default: 'List repositories' },
    description: {
      'zh-CN': '分页列出当前账号可见的仓库（公开 + 私有 + 协作 + 组织），可按 owner/private/public/fork/source 过滤，按 updated/pushed/created/full_name 排序。',
      default: 'List repositories visible to the token, with filtering and sorting.',
    },
    handler: toolListRepos,
  },
  {
    name: 'repo_info',
    title: { 'zh-CN': '仓库详情', default: 'Repository info' },
    description: {
      'zh-CN': '获取单个仓库的元数据：星标、分支、语言构成占比、许可证、大小、默认分支等。',
      default: 'Get metadata for one repository including language breakdown.',
    },
    handler: toolRepoInfo,
  },
  {
    name: 'repo_overview',
    title: { 'zh-CN': '仓库总览', default: 'Repository overview' },
    description: {
      'zh-CN': '一次性聚合仓库的核心动态：元数据 + 语言构成 + 分支列表 + 最近提交 + 未关闭 issue + 待合并 PR。结果缓存 5 分钟。',
      default: 'Aggregate repository activity: metadata, languages, branches, recent commits, open issues and pulls.',
    },
    handler: toolRepoOverview,
  },
  {
    name: 'list_issues',
    title: { 'zh-CN': 'Issue 列表', default: 'List issues' },
    description: { 'zh-CN': '列出仓库的 issue（自动排除 PR），可按 open/closed/all 过滤。', default: 'List repository issues, excluding pull requests.' },
    handler: toolListIssues,
  },
  {
    name: 'list_pulls',
    title: { 'zh-CN': 'PR 列表', default: 'List pull requests' },
    description: { 'zh-CN': '列出仓库的 Pull Request，含 draft 状态与来源/目标分支。', default: 'List pull requests with draft state and branches.' },
    handler: toolListPulls,
  },
  {
    name: 'list_commits',
    title: { 'zh-CN': '提交历史', default: 'List commits' },
    description: { 'zh-CN': '列出仓库某分支的提交历史（默认分支可用 branch 指定）。', default: 'List commits for a repository branch.' },
    handler: toolListCommits,
  },
  {
    name: 'list_branches',
    title: { 'zh-CN': '分支列表', default: 'List branches' },
    description: { 'zh-CN': '列出仓库分支及其 HEAD SHA、是否受保护。', default: 'List branches with HEAD sha and protection flag.' },
    handler: toolListBranches,
  },
  {
    name: 'list_dir',
    title: { 'zh-CN': '浏览目录', default: 'Browse directory' },
    description: { 'zh-CN': '查看仓库某个目录下的文件与子目录，可指定分支或 commit ref。', default: 'List files and subdirectories of a repository path.' },
    handler: toolListDir,
  },
  {
    name: 'read_file',
    title: { 'zh-CN': '读取文件', default: 'Read file' },
    description: {
      'zh-CN': '读取仓库内单个文本文件的内容（自动 base64 解码，超长截断），可指定分支或 commit ref。',
      default: 'Read a single text file from a repository, base64-decoded and truncated when large.',
    },
    handler: toolReadFile,
  },
  {
    name: 'search',
    title: { 'zh-CN': '搜索', default: 'Search' },
    description: {
      'zh-CN': '搜索仓库（repos）、代码（code）或 issue/PR（issues）。code 搜索支持 GitHub 的限定语法，如 repo:owner/name。',
      default: 'Search repositories, code, or issues and pull requests.',
    },
    handler: toolSearch,
  },
  {
    name: 'create_issue',
    title: { 'zh-CN': '创建 Issue', default: 'Create issue' },
    description: { 'zh-CN': '在指定仓库创建 issue，可带正文、标签与指派人。', default: 'Create an issue with body, labels and assignees.' },
    handler: toolCreateIssue,
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function definitions() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schema(tool.name),
  }));
}

function mcpToolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : tool.description['zh-CN'] || tool.description.default,
    inputSchema: schema(tool.name),
  }));
}

async function invoke(name, args) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  const result = await tool.handler(args || {});
  return result;
}

module.exports = { TOOLS, definitions, mcpToolList, invoke, normalizeRepo };
