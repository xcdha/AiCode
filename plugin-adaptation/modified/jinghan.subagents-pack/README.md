# Guru 子代理团队插件

装上插件后，自动把 8 个精选子代理定义写进全局目录 `~/.guru/agents/`，所有项目共享、装完即用。

## 子代理清单

| 定义文件 | 角色 | 能力 |
| --- | --- | --- |
| `explore.md` | 探索 | 只读探索、定位代码与调用链 |
| `researcher.md` | 调研 | 只读调研、查资料比方案，结论带依据 |
| `reviewer.md` | 审查 | 只读审查，找缺陷/风险/测试缺口 |
| `debugger.md` | 故障诊断 | 复现→定位根因→最小修复→验证 |
| `implementer.md` | 实现 | 按规格写代码、改模块、跑构建测试 |
| `designer.md` | 设计 | 界面视觉方案并落到文件 |
| `docwriter.md` | 文档 | 先读真实代码再写，确保与实现一致 |
| `tester.md` | 测试 | 补测试、跑测试、确认缺陷是否修复 |

## 安装方式

- 在 Guru「插件管理」中导入本 zip；插件安装目录由 Guru 管理。

## 工作原理

`contributes.hooks` 监听宿主事件：

- `app.started` / `plugin.enabled`：把插件内置 `agents/*.md` 拷到 `~/.guru/agents/`（幂等）
- `plugin.disabled` / `plugin.uninstalled`：只清理本插件装过的文件（靠 `.aicode-subagents-manifest.json` 记录），不碰用户自建定义

覆盖策略 `overwrite` 取 `always` / `changed`（默认）/ `never`；`changed` 下只覆盖「内容不同且由本插件管理」的文件，用户自建的同名文件默认跳过，`force:true` 可强制覆盖。

## 工具

- `subagents_status`：查看 8 个子代理的安装/一致性状态
- `subagents_install`：手动安装/重装，参数 `overwrite` / `force`
- `subagents_remove`：只移除本插件装过的定义

设置页（设置 → AI → 子代理团队）里可开关自动安装、覆盖策略，并手动安装/移除。

## 生效时机

新增/改动子代理定义后，**新开一个会话**主代理才能看到；已打开的会话沿用开场清单。

目标目录可通过环境变量 `AICODE_HOME` 覆盖（默认 `~/.guru`）。
