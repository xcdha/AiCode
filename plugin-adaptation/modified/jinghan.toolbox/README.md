# ZDP 工具箱 · Guru 插件版

原包是 DSH 插件（`@zdp/zdp-toolbox` 2.7.0，上游 `ADWMC/helm-d`，AGPL-3.0）。
此包适配 Guru 插件运行时：**只保留工具本体 + 参考文档 + 脚本 + 团队角色**，门控、点星、
更新检查、页面广告、描述改写、提示注入这一整套外围全部剔除。

## 装了什么

**40 个工具**

| 域 | 工具 |
|---|---|
| 参考库 | `jh_reference`（365 篇文档，按 9 个分区读取） |
| 静态分析 | `triage_artifact` `hash_artifact` `scan_strings` `detect_packer` `encoding_detect` `xor_bruteforce` |
| 移动/APK | `apk_fingerprint` |
| 协议/流量 | `pcap_parse` `parse_har` `state_machine` |
| 恶意样本 | `ioc_extract` `yara_gen` |
| AI 安全 | `llm_sim` |
| 侦察 | `recon_passive` `recon_ports` `recon_http` `recon_crawl` `recon_import` |
| 验证 | `run_poc` `oob_start` `oob_poll` `oob_stop` |
| 候选挖掘 | `mine_candidates` |
| 工具目录 | `toolbox` `tool_recommend` |
| 案件 | `begin_case` `case_status` `record_finding` `update_finding` `record_hypothesis` `update_hypothesis` `save_evidence` `end_case` |
| 团队 | `team_create` `team_status` `team_report` `team_steer` `team_dispatch` |

AI 侧看到的工具名形如 `plugin__jinghan_toolbox__scan_strings`。

**365 篇参考文档** 在 `references/`（web / native / protocol / malware / ai-security /
evidence / android / toolbox / playbooks），入口是各分区的 `index.md`。

**86 个脚本** 在 `scripts/`，绝大多数只用 Python 标准库。少数需要额外依赖
（`r2pipe`、`frida`、`openai`、`bs4`、`pycryptodome`），没装时对应工具会明确报错。

## 子代理（7 个角色）

`agents/` 下有 7 个角色定义，插件进程启动时会同步到 `~/.guru/agents/jh-*.md`
（Guru 的 `task` 工具从这个目录读取定义）。

| 子代理 | 干什么 |
|---|---|
| `jh-triage` | 分诊：类型/架构/壳/导入/字符串/风险面，给出路由与预算 |
| `jh-static` | 静态分析：结构、字符串、调用链，结论落到偏移 |
| `jh-dynamic` | 动态分析：隔离环境下执行，捕获可观察行为 |
| `jh-decoy-audit` | 诱饵审计：canary、假架构、死代码、预算异常 |
| `jh-critic` | 评审：逐条核对证据与复现，可否决结论 |
| `jh-reporter` | 报告：合并已接受结论，带置信度与残余风险 |
| `jh-orchestrator` | 编排：拆任务、派角色、合并结果 |

用法：

```
team_create(goal, roles: ["triage","static"])
team_dispatch(ticketId: "T-001", role: "triage")   → 返回一条现成的 task 调用
task(agent: "jh-triage", prompt: "...")           → 真正拉起子代理
team_report(ticketId, role, state, summary)         → 子代理回填结论
```

为什么不让 `team_dispatch` 自己拉起：插件的 runtime 进程没有聊天会话上下文，
`host.tools.execute` 对 `task` 这类"需要 chat session"的工具直接拒绝
（实测报 `tool requires a chat session`）。所以派发由主 AI 执行，插件负责账本与指令生成。


## 提示注入（可开关）

走 Guru 的自定义提示词机制，**不碰请求体、与供应商无关**：

```
~/.guru/prompts.custom/05-jh-inject.md
```

- **打开开关** = 生成这个文件（编号 05，落在 `03-han-内核` 与 `10-rules` 之间，不动现有片段）
- **关闭开关** = 删除这个文件
- 内容可在面板里编辑，也可直接改文件

宿主在组装系统提示时读入该片段，所以 DeepSeek / Qwen / Claude / Gemini 都一样生效——
不需要按各家请求格式做适配。

默认内容：

```markdown
## 安全分析纪律

- 先用工具拿事实再下结论；没有证据的判断标成「推测」。
- 每个结论附证据：文件路径、偏移、哈希、或命令输出。
- 工具失败就换轨道，并在记录里写明失败原因，不重复同一条死路。
- 分诊优先：类型/架构/保护 → 再决定走静态还是动态。
```

生效时机：**新会话**。系统提示只在会话开始时组装，当前会话不会中途变。

> 为什么不用 `agent.http.before`：那个钩子改的是发出去的 provider 请求体，
> 每家供应商结构不同（OpenAI `messages[]`、Anthropic 顶层 `system`、Gemini `contents[].parts[]`），
> 换一家就得重写适配；而且实测在这台宿主（上游原始环境）上根本没被调用。

## 管理面板

装好后在「设置 → AI 配置」末尾出现「ZDP 工具箱」/「ZDP Toolbox」：

- 运行状态：Node 版本、工具数、工作区、数据目录、设置文件、加载失败域
- 子代理：已同步到 `~/.guru/agents/` 的 `jh-*` 文件
- 设置：允许/禁止 `toolbox install` 下载外部工具；提示注入开关（建/删 `prompts.custom` 片段）
- 自检：跑一次 `hash_artifact` 验证整条链路
- 工具清单：按名字或说明过滤，显示每个工具的完整调用名

面板是 `pages/config.html`，通过 `aicode.invoke('ui.status' / 'ui.settings.set' / 'ui.selftest' /
'ui.installAgents')` 调 runtime，不经过 AI 推理。

## 路径一览

| 用途 | 位置 |
|---|---|
| 安装副本（宿主复制） | `~/.guru/plugins/installed/jinghan.toolbox/` |
| 数据：设置 / 案件 / 团队 / 证据 / 工具 | `~/.guru/plugins/data/jinghan.toolbox/` |
| 子代理定义 | `~/.guru/agents/jh-*.md` |
| 进程 | proot 内 `node dist/main.js`，cwd 为安装副本目录 |

Guru 负责创建插件进程并注入 `AICODE_HOME`、`AICODE_DATA_DIR` 和 `AICODE_WORKSPACE`；插件不依赖固定安装路径。

## 去掉了什么

| 原包的东西 | 处理 |
|---|---|
| 卡密 / 云租约 / Ed25519 验签 | 整层删除（`zdp-license` / `zdp-gate` / `zdp-cloud-*` / `license-gate`） |
| GitHub 点星解锁（device flow） | 删除。原 `star-gate.js` 里只有代理感知的 HTTP 传输被抽出来重写成 `http.js` |
| 版本检查（拉 GitHub release） | 删除 |
| 105KB 前端面板（卡密页、点星页、工具页） | 不移植，另写了一个纯管理面板 |
| 本地 HTTP 服务（`api-routes`） | 不移植 |
| 描述改写层（把宿主工具描述里「拒绝是终局」洗成「可以再试」） | 不移植 |
| 每轮提示注入（advisory 队列 + 自主性包裹） | 不移植 |
| 拒答检测 + 自动重试（`llm-stream-hook`） | 不移植 |
| 工具输出自动落证据（persist 包装） | 不移植，证据靠 `save_evidence` 显式存 |
| 首轮工具裁剪（bootstrap filter） | 不移植 |
| `~/.dsh` 路径依赖 | 改到 Guru 插件私有数据目录 |
| 文档里的 `\r\r\n` 双回车、旧工具名引用 | 统一换行；`*_reference --path` 全部改写成 `jh_reference(domain=..., path=...)` |

## 实现说明

实测宿主是 Node 12.22.9（不同环境可能不同，先 `node --version` 确认），而原包代码是 ESM + `?.` / `??` / `fs/promises`，在旧 Node 上直接搬会语法崩。
所以用 esbuild 以 `--target=node12 --format=cjs` 打成单文件 `dist/bundle.js`（约 225 KB），
`@deepseek-ai/dsh-tools` 换成本地的 `defineTool` 桩，`fs/promises` 桥到 `fs.promises`。
`dist/main.js` 只做 JSON-RPC 分发（`tool.invoke` / `hook.invoke` / `ui.invoke`），
把宿主调用转给 bundle 里的工具，另负责同步子代理定义与面板设置读写。

## 已知限制

- `team_dispatch` 不直接创建子代理（见上），返回的是可直接执行的 `task` 调用。
- 案件绑定用固定会话 id（`zdp-guru`），多会话共享同一个绑定；
  切换案件用 `case_status(name: "...")`。
- 没建案件时，侦察/PoC/挖掘的产物落在 `data://workspace/`；
  私有或回环地址仍需 `lab=true`。
- `toolbox install/update/mirror` 默认关闭，需在面板里打开（或改 `settings.json`）。
- 部分脚本依赖第三方 Python 包，缺依赖时工具会明确报错，不会静默失败。

## 许可

工具与文档来自 `ADWMC/helm-d`（AGPL-3.0-or-later）。本插件沿用同一许可。
