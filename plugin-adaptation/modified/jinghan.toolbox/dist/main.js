'use strict';
// JH 工具箱 · Guru 插件 runtime
//
// 宿主 ↔ 插件协议（与 jinghan.* 系列插件一致）：
//   宿主 → 插件 {jsonrpc:'2.0', id, method:'tool.invoke', params:{handler:'tools.xxx', args:{...}}}
//   插件 → 宿主 {jsonrpc:'2.0', id, result|error}
//   插件 → 宿主 {jsonrpc:'2.0', id:'host-N', method:'host.log', params:{level, message}}
//
// 工具本体来自 dist/bundle.js（原 dsh 实现经 esbuild 降到 node12 语法打成的单文件）。
// 这里只做三件事：注册、把参数转交、把返回值和异常翻译成宿主能读的形态。

const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PKG_ROOT = path.resolve(__dirname, '..');
const PLUGIN_ID = 'jinghan.toolbox';
const HOST_TIMEOUT_MS = 30000;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// ── 宿主调用（插件 → 宿主）─────────────────────────────────
let hostSeq = 0;
const hostPending = new Map();

function hostCall(method, params, timeoutMs) {
  const id = 'host-' + (++hostSeq);
  const limit = typeof timeoutMs === 'number' ? timeoutMs : HOST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (hostPending.has(id)) {
        hostPending.delete(id);
        reject(new Error('宿主未在 ' + limit + 'ms 内回应 ' + method));
      }
    }, limit);
    hostPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
  });
}
const log = (message) => hostCall('host.log', { level: 'info', message }).catch(() => {});

// ── 工作区 ─────────────────────────────────────────────────
function workspaceRoot() {
  const cands = [
    process.env.AICODE_WORKSPACE,
    path.join(os.homedir(), 'workspace')
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* 下一个 */ }
  }
  return process.cwd();
}


// ── 子代理定义落盘 ─────────────────────────────────────────
// Guru 的 task 工具从 ~/.guru/agents/*.md 读取定义；插件清单里的 contributes.agents 只作声明。
// 所以启动时把本插件带的 7 个角色复制过去，只碰 jh- 前缀，不动别人的定义。
const AGENT_PREFIX = 'jh-';
const AGENT_MANIFEST = '.jh-toolbox-agents.json';

function agentsDir() {
  const home = process.env.AICODE_HOME || path.join(os.homedir(), '.guru');
  return path.join(home, 'agents');
}

function installAgents() {
  const srcDir = path.join(PKG_ROOT, 'agents');
  const dstDir = agentsDir();
  const report = { installed: [], skipped: [], failed: [] };
  let entries;
  try {
    entries = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md') && f.startsWith(AGENT_PREFIX));
  } catch (e) {
    return report;
  }
  try {
    fs.mkdirSync(dstDir, { recursive: true });
  } catch (e) {
    report.failed.push('agents dir: ' + String(e && e.message ? e.message : e));
    return report;
  }
  const manifest = { files: [], installedAt: new Date().toISOString() };
  for (const file of entries) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    try {
      const next = fs.readFileSync(src);
      let same = false;
      try { same = Buffer.compare(next, fs.readFileSync(dst)) === 0; } catch (e) { same = false; }
      if (!same) fs.writeFileSync(dst, next);
      manifest.files.push(file);
      report.installed.push(file);
    } catch (e) {
      report.failed.push(file + ': ' + String(e && e.message ? e.message : e));
    }
  }
  try {
    fs.writeFileSync(path.join(dstDir, AGENT_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) { /* 清单写不了不影响使用 */ }
  return report;
}

// ── 工具注册 ───────────────────────────────────────────────
let state = null;

function registry() {
  if (state !== null) return state;
  const bundle = require('./bundle.js');
  const map = new Map();
  const ctx = {
    get: () => undefined,
    tools: { register: (def) => { if (def && def.name) map.set(def.name, def); } }
  };
  let report = { registered: [], skipped: [], failures: [] };
  try {
    report = bundle.collectTools(ctx);
  } catch (error) {
    report.failures = [{ domain: 'bootstrap', error: String((error && error.message) || error) }];
  }
  state = { map, report };
  return state;
}

function execContext() {
  const root = workspaceRoot();
  return {
    agent: {
      id: 'jh-nox',
      cwd: root,
      workspace: root,
      session: { header: { cwd: root } }
    }
  };
}

async function invoke(handler, args) {
  const name = String(handler || '').replace(/^tools\./, '');
  const { map } = registry();
  const tool = map.get(name);
  if (tool === undefined) {
    throw new Error('未注册的工具: ' + name);
  }
  const out = await tool.execute(args || {}, execContext());
  if (typeof out === 'string') return out;
  if (out === undefined || out === null) return '';
  try { return JSON.stringify(out, null, 2); } catch (e) { return String(out); }
}

const handlers = {
  'hooks.boot': async () => {
    const { report } = registry();
    return { plugin: PLUGIN_ID, registered: report.registered.length, failures: report.failures };
  },
  'tools.status': async () => {
    const { map, report } = registry();
    return JSON.stringify({
      plugin: PLUGIN_ID,
      tools: [...map.keys()].sort(),
      skipped: report.skipped,
    categories: CATEGORY_ORDER,
      failures: report.failures,
      workspace: workspaceRoot(),
      node: process.version
    }, null, 2);
  },
  'hooks.invoke': async () => 'ok'
};





// ── 工具中文短说明（面板展示用） ───────────────────────────
const TOOL_ZH = {
  jh_reference: '读离线知识库，365 篇安全文档',
  triage_artifact: '样本初筛：魔数、熵、字符串',
  hash_artifact: '打印文件 SHA-256 与大小',
  scan_strings: '提取 ASCII / UTF-16LE 字符串',
  detect_packer: '识别加壳：UPX、VMProtect、Themida、OLLVM',
  encoding_detect: '识别并解码 Base64 / Hex / ROT13 / XOR',
  xor_bruteforce: 'XOR 密钥爆破，按英文密度排序',
  apk_fingerprint: 'APK 指纹：框架、HTTP 栈、混淆',
  bot_analyze: '分析 Bot 服务端，抽参数与攻击时序',
  pcap_parse: '解析 PCAP，列出 TCP/UDP 流',
  parse_har: '解析 HAR 的请求响应字段',
  state_machine: '从消息日志推断协议状态机',
  ioc_extract: '提取 IOC：IP / URL / 域名 / 邮箱 / 哈希',
  yara_gen: '从字符串与导入表生成 YARA 规则',
  llm_sim: '本地跑 LLM 应用，测提示注入',
  recon_passive: '被动侦察：DoH 查 A / AAAA 记录',
  recon_ports: '小端口列表 TCP 连接扫描',
  recon_http: '单次 HTTP GET 基线 + 技术指纹',
  recon_crawl: '同源链接爬取（深度 2 / 10 页）',
  recon_import: '导入 nmap / httpx / nuclei 结果',
  run_poc: '跑一条 PoC 配方，带独立负对照',
  oob_start: '起回环 OOB 监听，拿一次性地址',
  oob_poll: '查 OOB 会话的回调命中',
  oob_stop: '停 OOB 监听并释放端口',
  mine_candidates: '从 HAR / OpenAPI / JS / APK 挖端点参数',
  toolbox: '外部工具目录：查询、安装、更新',
  tool_recommend: '按任务推荐工具与存证格式',
  begin_case: '建案件工作区，样本哈希入证据',
  case_status: '读案件状态，可按名字恢复',
  record_finding: '登记发现，带严重度、证据、复现',
  update_finding: '改发现的状态或严重度',
  record_hypothesis: '记一条可验证的假设',
  update_hypothesis: '更新假设结论：确认 / 否定 / 阻塞',
  save_evidence: '把文本或文件存成 E-nnn 证据',
  end_case: '结案并解绑当前会话',
  team_create: '建团队工单',
  team_status: '读工单状态与各角色报告',
  team_report: '角色回填报告',
  team_steer: '给运行中的角色发指令',
  team_dispatch: '生成角色子代理的派发指令'
};

// ── 工具分组（面板用） ─────────────────────────────────────
const CATEGORY_ORDER = ['参考文档', '静态分析', '协议 / 流量', '恶意样本', 'AI 安全', '侦察', '验证', '候选挖掘', '工具目录', '案件', '团队'];
const CATEGORY = {
  jh_reference: '参考文档',
  triage_artifact: '静态分析', hash_artifact: '静态分析', scan_strings: '静态分析',
  detect_packer: '静态分析', encoding_detect: '静态分析', xor_bruteforce: '静态分析',
  apk_fingerprint: '静态分析', bot_analyze: '静态分析',
  pcap_parse: '协议 / 流量', parse_har: '协议 / 流量', state_machine: '协议 / 流量',
  ioc_extract: '恶意样本', yara_gen: '恶意样本',
  llm_sim: 'AI 安全',
  recon_passive: '侦察', recon_ports: '侦察', recon_http: '侦察', recon_crawl: '侦察', recon_import: '侦察',
  run_poc: '验证', oob_start: '验证', oob_poll: '验证', oob_stop: '验证',
  mine_candidates: '候选挖掘',
  toolbox: '工具目录', tool_recommend: '工具目录',
  begin_case: '案件', case_status: '案件', record_finding: '案件', update_finding: '案件',
  record_hypothesis: '案件', update_hypothesis: '案件', save_evidence: '案件', end_case: '案件',
  team_create: '团队', team_status: '团队', team_report: '团队', team_steer: '团队', team_dispatch: '团队'
};




// ── 数据目录与设置 ─────────────────────────────────────────
function dataDir() {
  return process.env.AICODE_DATA_DIR || path.join(process.env.AICODE_HOME || path.join(os.homedir(), '.guru'), 'plugins', 'data', PLUGIN_ID);
}
function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (e) {
    return {};
  }
}
function writeSettings(patch) {
  const current = readSettings();
  const next = {
    team: Object.assign({}, current.team || {}, (patch && patch.team) || {}),
    toolbox: Object.assign({}, current.toolbox || {}, (patch && patch.toolbox) || {}),
    injection: Object.assign({ enabled: false, text: '', position: 'system-append' }, current.injection || {}, (patch && patch.injection) || {})
  };
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) { /* 只读环境：本次进程内仍返回合并值 */ }
  return next;
}

// ── 面板接口 ───────────────────────────────────────────────
handlers['ui.status'] = async () => {
  const { map, report } = registry();
  const tools = [];
  for (const [name, def] of map) {
    tools.push({
      id: name,
      label: TOOL_ZH[name] || '',
      category: CATEGORY[name] || '其他'
    });
  }
  tools.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.id < b.id ? -1 : 1;
  });
  return {
    plugin: PLUGIN_ID,
    node: process.version,
    toolCount: tools.length,
    tools: tools,
    skipped: report.skipped,
    categories: CATEGORY_ORDER,
    failures: report.failures,
    workspace: workspaceRoot(),
    dataDir: dataDir(),
    settings: readSettings(),
    injection: readInjection(),
    defaultInjectionText: DEFAULT_INJECTION_TEXT,
    injectionFile: injectFilePath(),
    settingsFile: settingsFile(),
    agentsDir: agentsDir(),
    agents: (function () {
      try { return fs.readdirSync(agentsDir()).filter((f) => f.endsWith('.md') && f.startsWith(AGENT_PREFIX)).sort(); }
      catch (e) { return []; }
    })()
  };
};
handlers['ui.settings.get'] = async () => readSettings();
handlers['ui.settings.set'] = async (args) => writeSettings(args && args.patch);
handlers['ui.injection.read'] = async () => readInjection();
handlers['ui.injection.enable'] = async (args) => writeInjection((args && args.text) || '');
handlers['ui.injection.disable'] = async () => removeInjection();
handlers['ui.injection.save'] = async (args) => writeInjection((args && args.text) || '');
handlers['ui.installAgents'] = async () => installAgents();
handlers['ui.selftest'] = async () => {
  try {
    const out = await invoke('tools.hash_artifact', { path: '/etc/hostname' });
    return { ok: true, output: String(out) };
  } catch (error) {
    return { ok: false, output: String((error && error.message) || error) };
  }
};


// ── 提示注入（写 prompts.custom 片段） ─────────────────────
// 走 Guru 的自定义提示词机制：片段文件由宿主在组装系统提示时读入，与供应商、请求格式无关。
// 开关就是建/删这个文件；编号 05 落在 03-han-内核 与 10-rules 之间，不动用户现有片段。
const INJECT_FILE = '05-jh-inject.md';
const DEFAULT_INJECTION_TEXT = [
  '## 安全分析纪律',
  '',
  '- 先用工具拿事实再下结论；没有证据的判断标成「推测」。',
  '- 每个结论附证据：文件路径、偏移、哈希、或命令输出。',
  '- 工具失败就换轨道，并在记录里写明失败原因，不重复同一条死路。',
  '- 分诊优先：类型/架构/保护 → 再决定走静态还是动态。',
  '- 未验证的部分明确说出来，不用推测填空。',
  '',
  '## 工具优先',
  '',
  '- 安全分析动作优先用 jh_* 工具（plugin__jinghan_toolbox__*）：分诊、字符串、加壳识别、IOC、编码、侦察、PoC、案件与团队都有对应工具，不要用 Bash 手搓等效命令。',
  '- 需要方法论或命令模板时用 jh_reference(domain, path)：先读 index.md，再按需取单篇，不要整本灌进上下文。',
  '- 多个工具都能做同一件事时，选描述最贴近当前动作的那个，不要串一堆试。',
  '',
  '## 外部工具安装',
  '',
  '- 装之前先核对平台与架构：先确认本机的系统与 CPU 架构（uname -m、getprop ro.product.cpu.abi、node -p process.arch 之类），再比对 asset 的目标平台；不匹配的装上去也执行不了。',
  '- catalog 里不少 asset 是 Windows x64 的（jadx-*.zip、x64dbg、pe-sieve、upx-*win64 等）；跨平台 jar（apktool、jadx，需要 java）与 pip 包通常更通用。',
  '- 装之前先 toolbox(action="catalog", query="<id>") 看 kind 与 asset 名；不确定目标平台时先 toolbox(action="probe") 验证命令能否解析。',
  '- 单个 asset 超过约 10 MB 时留意网络耗时：工具调用有超时上限，大文件改为手动下载再本地引用。',
  '- 不要为了"先用起来"安装架构不匹配的二进制，跑不起来时先回头核对平台，而不是换着参数重试。',
  ''
].join('\n');

function promptsCustomDir() {
  const home = process.env.AICODE_HOME || path.join(os.homedir(), '.guru');
  return path.join(home, 'prompts.custom');
}

function injectFilePath() {
  return path.join(promptsCustomDir(), INJECT_FILE);
}

function readInjection() {
  const file = injectFilePath();
  try {
    return { enabled: true, text: fs.readFileSync(file, 'utf8'), path: file };
  } catch (e) {
    return { enabled: false, text: '', path: file };
  }
}

function writeInjection(text) {
  const dir = promptsCustomDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = injectFilePath();
  let body = typeof text === 'string' && text.trim() !== '' ? text : DEFAULT_INJECTION_TEXT;
  // 文本可能已是完整文件内容（面板回填的），先剥旧头再统一补，避免重复
  body = body.replace(/^<!--\s*JH 工具箱 · 提示注入片段[^>]*-->\s*/, '').replace(/^\s+/, '');
  const header = '<!-- JH 工具箱 · 提示注入片段 · 由插件面板生成，可手改 -->\n\n';
  fs.writeFileSync(file, header + body, 'utf8');
  return readInjection();
}

function removeInjection() {
  try { fs.unlinkSync(injectFilePath()); } catch (e) { /* 本来就不存在 */ }
  return readInjection();
}

// 每个工具一个 handler：tools.<name>
function dispatch(handler, args) {
  if (handlers[handler] !== undefined) return handlers[handler](args);
  if (handler.indexOf('tools.') === 0) return invoke(handler, args);
  throw new Error('未知 handler: ' + handler);
}

// ── 主循环 ─────────────────────────────────────────────────
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = String(line || '').trim();
  if (text === '') return;
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg === null || typeof msg !== 'object') return;

  // 宿主回包：只有 id 没有 method
  if (msg.method === undefined) {
    if (msg.id !== undefined && hostPending.has(msg.id)) {
      const pending = hostPending.get(msg.id);
      hostPending.delete(msg.id);
      if (msg.error) pending.reject(new Error(String((msg.error && msg.error.message) || '宿主返回错误')));
      else pending.resolve(msg.result);
    }
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method !== 'tool.invoke' && msg.method !== 'hook.invoke' && msg.method !== 'ui.invoke') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: 'METHOD_UNKNOWN', message: String(msg.method) } });
    return;
  }
  const params = msg.params || {};
  const handler = String(params.handler || '');
  Promise.resolve()
    .then(() => dispatch(handler, params.args || {}))
    .then((result) => send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result }))
    .catch((error) => send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: 'PLUGIN_ERROR', message: String((error && error.message) || error) }
    }));
});

// 启动即注册一次，把失败信息写进宿主日志（不阻塞，失败也不影响逐次调用时的报错）。
try {
  const { report } = registry();
  const agents = installAgents();
  log(PLUGIN_ID + ' 就绪：工具 ' + report.registered.length + ' 个 · 子代理 ' + agents.installed.length + ' 个'
    + (report.failures.length ? '，失败域 ' + report.failures.map((f) => f.domain).join(',') : '')
    + (agents.failed.length ? '，子代理失败 ' + agents.failed.join(';') : ''));
} catch (error) {
  log(PLUGIN_ID + ' 初始化失败：' + String((error && error.message) || error));
}
