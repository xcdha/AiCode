'use strict';

const https = require('https');
const { URL } = require('url');

const API_BASE = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'guru-github-mcp/1.0.0';

class GithubError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'GithubError';
    Object.assign(this, extra || {});
  }
}

function httpRequest(options) {
  const target = new URL(options.url);
  const method = options.method || 'GET';
  const headers = Object.assign({ 'User-Agent': USER_AGENT }, options.headers || {});
  const timeout = options.timeout || 25000;
  const body = options.body == null ? null : Buffer.from(String(options.body), 'utf8');
  if (body) headers['Content-Length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function followRedirects(options, max) {
  let res = await httpRequest(options);
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && res.headers.location && hops < (max || 3)) {
    hops += 1;
    res = await httpRequest(Object.assign({}, options, { url: new URL(res.headers.location, options.url).toString() }));
  }
  return res;
}

function parseRate(headers) {
  if (!headers) return null;
  const limit = Number(headers['x-ratelimit-limit']);
  if (!Number.isFinite(limit)) return null;
  return {
    limit,
    remaining: Number(headers['x-ratelimit-remaining']),
    reset: Number(headers['x-ratelimit-reset']) * 1000,
    resource: headers['x-ratelimit-resource'] || '',
  };
}

function buildUrl(path, query) {
  const url = new URL(path.startsWith('http') ? path : API_BASE + path);
  if (query) {
    Object.keys(query).forEach((key) => {
      const value = query[key];
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

async function call(token, path, options) {
  const opts = options || {};
  const headers = { Accept: opts.accept || ACCEPT, 'X-GitHub-Api-Version': API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await followRedirects({
      url: buildUrl(path, opts.query),
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
      timeout: opts.timeout,
    });
  } catch (e) {
    throw new GithubError(`连接 GitHub 失败：${(e && e.message) || e}`, { status: 0 });
  }

  const rate = parseRate(res.headers);
  let json = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      json = null;
    }
  }

  if (res.status >= 200 && res.status < 300) {
    return { data: json, headers: res.headers, rate };
  }

  const message = (json && json.message) || res.body.slice(0, 300) || `HTTP ${res.status}`;
  const hint = (() => {
    if (res.status === 401) return 'Token 无效或已过期，请在插件配置页重新登录。';
    if (res.status === 403 && rate && rate.remaining === 0) {
      return `GitHub API 配额已用尽（${rate.limit} 次/小时），将在 ${new Date(rate.reset).toLocaleString('zh-CN')} 重置。`;
    }
    if (res.status === 403) return '权限不足：请确认 Token 勾选了需要的 scope（私有仓库需要 repo）。';
    if (res.status === 404) return '资源不存在，或 Token 无权访问该仓库。';
    if (res.status === 422) return '请求参数不被接受，请检查名称、路径或查询语法。';
    return '';
  })();
  throw new GithubError(hint ? `${message}（${hint}）` : message, {
    status: res.status,
    rate,
    scopes: res.headers['x-oauth-scopes'] || '',
    documentation: (json && json.documentation_url) || '',
  });
}

async function getUser(token) {
  const res = await call(token, '/user');
  return {
    login: res.data.login,
    name: res.data.name || '',
    avatar: res.data.avatar_url || '',
    htmlUrl: res.data.html_url || '',
    type: res.data.type || '',
    publicRepos: res.data.public_repos || 0,
    totalPrivateRepos: res.data.total_private_repos || 0,
    scopes: res.headers['x-oauth-scopes'] || '',
  };
}

async function getRateLimit(token) {
  const res = await call(token, '/rate_limit');
  return res.data;
}

async function listRepos(token, options) {
  const opts = options || {};
  const res = await call(token, '/user/repos', {
    query: {
      per_page: opts.perPage || 100,
      page: opts.page || 1,
      sort: opts.sort || 'updated',
      direction: opts.direction || 'desc',
      affiliation: opts.affiliation || 'owner,collaborator,organization_member',
      visibility: opts.visibility || 'all',
    },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function listStarred(token, options) {
  const opts = options || {};
  const res = await call(token, '/user/starred', {
    query: { per_page: opts.perPage || 100, page: opts.page || 1 },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function getRepo(token, fullName) {
  const res = await call(token, `/repos/${encodePath(fullName)}`);
  return res.data;
}

async function getLanguages(token, fullName) {
  const res = await call(token, `/repos/${encodePath(fullName)}/languages`);
  return res.data || {};
}

async function listIssues(token, fullName, options) {
  const opts = options || {};
  const res = await call(token, `/repos/${encodePath(fullName)}/issues`, {
    query: {
      state: opts.state || 'open',
      per_page: opts.perPage || 20,
      page: opts.page || 1,
      sort: opts.sort || 'updated',
      direction: 'desc',
    },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function listPulls(token, fullName, options) {
  const opts = options || {};
  const res = await call(token, `/repos/${encodePath(fullName)}/pulls`, {
    query: {
      state: opts.state || 'open',
      per_page: opts.perPage || 20,
      page: opts.page || 1,
      sort: opts.sort || 'updated',
      direction: 'desc',
    },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function listCommits(token, fullName, options) {
  const opts = options || {};
  const res = await call(token, `/repos/${encodePath(fullName)}/commits`, {
    query: {
      per_page: opts.perPage || 20,
      page: opts.page || 1,
      sha: opts.sha || undefined,
    },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function listBranches(token, fullName, options) {
  const opts = options || {};
  const res = await call(token, `/repos/${encodePath(fullName)}/branches`, {
    query: { per_page: opts.perPage || 50, page: opts.page || 1 },
  });
  return { items: Array.isArray(res.data) ? res.data : [], rate: res.rate };
}

async function getContent(token, fullName, path, ref) {
  const res = await call(token, `/repos/${encodePath(fullName)}/contents/${encodePath(path || '')}`, {
    query: { ref: ref || undefined },
  });
  return res.data;
}

async function getRawFile(token, fullName, path, ref) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await followRedirects({
    url: buildUrl(`/repos/${encodePath(fullName)}/contents/${encodePath(path)}`, { ref: ref || undefined }),
    method: 'GET',
    headers: Object.assign({ Accept: 'application/vnd.github.raw' }, headers),
    timeout: 30000,
  });
  if (res.status >= 200 && res.status < 300) return res.body;
  if (res.status === 404) throw new GithubError('文件不存在或无权访问。', { status: 404 });
  if (res.status === 401) throw new GithubError('Token 无效或已过期。', { status: 401 });
  throw new GithubError(`读取原始文件失败（HTTP ${res.status}）`, { status: res.status });
}

async function search(token, kind, query, options) {
  const opts = options || {};
  const map = { repos: '/search/repositories', code: '/search/code', issues: '/search/issues' };
  const path = map[kind];
  if (!path) throw new GithubError(`不支持的搜索类型：${kind}`);
  const res = await call(token, path, {
    query: { q: query, per_page: opts.perPage || 20, page: opts.page || 1, sort: opts.sort, order: 'desc' },
    accept: kind === 'code' ? 'application/vnd.github.text-match+json' : ACCEPT,
  });
  return { data: res.data, rate: res.rate };
}

async function createIssue(token, fullName, payload) {
  const body = { title: payload.title };
  if (payload.body) body.body = payload.body;
  if (payload.labels && payload.labels.length) body.labels = payload.labels;
  if (payload.assignees && payload.assignees.length) body.assignees = payload.assignees;
  const res = await call(token, `/repos/${encodePath(fullName)}/issues`, { method: 'POST', body });
  return res.data;
}

function encodePath(value) {
  return String(value || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function startDeviceFlow(clientId, scopes) {
  const form = new URLSearchParams({ client_id: clientId, scope: scopes || 'repo read:org read:user' });
  return postForm('https://github.com/login/device/code', form);
}

function pollDeviceToken(clientId, deviceCode) {
  const form = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  return postForm('https://github.com/login/oauth/access_token', form);
}

async function postForm(url, form) {
  let res;
  try {
    res = await followRedirects({
      url,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeout: 20000,
    });
  } catch (e) {
    throw new GithubError(`连接 GitHub 失败：${(e && e.message) || e}`, { status: 0 });
  }
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    json = null;
  }
  if (!json) throw new GithubError(`GitHub 返回了无法解析的内容（HTTP ${res.status}）`, { status: res.status });
  return json;
}

module.exports = {
  GithubError,
  getUser,
  getRateLimit,
  listRepos,
  listStarred,
  getRepo,
  getLanguages,
  listIssues,
  listPulls,
  listCommits,
  listBranches,
  getContent,
  getRawFile,
  search,
  createIssue,
  startDeviceFlow,
  pollDeviceToken,
};
