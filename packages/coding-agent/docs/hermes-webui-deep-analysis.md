# hermes-webui 深度分析 — 架构、模块与 multidevice-host 改善建议

> 2026-08-18 · 基于 source clone（tmp/hermes-webui，v0.51.792）全量遍历 + 本机实跑（127.0.0.1:8787）交互验证
> 对照对象：本 worktree（serve WS host + pi-wire/pi-client + web-app React）

---

## 一、总体架构

```
browser (vanilla JS ×9 模块, 7.3k 行 ui.js + 6.5k 行 panels.js + …)
   │  REST (234 条路由) + SSE 流（chat/approval/clarify/session events）
   ▼
server.py（薄路由壳）→ api/routes.py（27k 行 if/elif 分发）
   ▼
api/* 业务模块（30+ 文件）──sys.path──▶ Hermes Agent（AIAgent、tools/、cron/、state.db）
```

单进程、stdlib ThreadingHTTPServer、无框架无构建。agent 以 **in-process import** 方式运行（非子进程），靠 Python 模块缓存共享审批状态。

**核心取舍**：它用「进程内直连 agent」换来零部署成本，代价是 TD1（进程级 env var 并发互踩，至今 PARTIAL）和单用户假设。我们的 serve 用独立 host + WS 协议，多端天然成立——这个分叉是我们架构占优的地方，下面所有建议都在「不放弃 WS 快照模型」的前提下做。

## 二、前端模块地图（功能密度来源）

| 文件 | 规模 | 职责 |
|---|---|---|
| ui.js | ~7.2k | DOM/渲染底座：renderMd（自研 md 管线+Mermaid+KaTeX）、工具卡、消息操作条、context 指示、文件树渲染 |
| panels.js | ~13k（含设置） | 11 个侧栏 panel 全部实现 + Settings 8 分区 + tab 可视性/排序编辑器 + composer 控件排序 |
| sessions.js | ~3.5k | 会话 CRUD/分组/搜索/pin/archive/project/lineage/CLI 投影/滑动操作 |
| messages.js | ~2.3k | SSE 消费、send 全链路、审批/澄清卡、恢复、14 种错误态分类 |
| commands.js | ~1.3k | 29 个 slash 命令注册表 + 解析器 + 自动补全下拉 |
| workspace.js | ~0.4k | 文件预览/操作/git badge/上传 |
| boot.js | ~1.6k | 事件装配、移动端导航、语音、主题引导、bfcache、键盘守卫 |
| sw.js | — | Service Worker 离线壳 + 版本钉扎 |
| i18n.js | — | en/es/de/zh/zh-Hant/ru… 本地化 |

## 三、值得抄的机制（按价值排序）

### 3.1 会话操作全集（session_ops）
`undo / retry / truncate / branch(fork) / duplicate / move / rename / title-regenerate / draft / yolo / toolsets / handoff-summary / export(HTML) / import / import_cli / lineage-report / recovery-audit / share(create/revoke)`。
消息级操作条（ui.js:16936-16964）：edit（用户消息改后重发）、undo exchange（回滚一轮）、regenerate、copy、**fork from here（从任意消息分叉新会话）**、TTS listen。
→ 我们已有：branch/get_branch_messages/回放。缺：**undo、retry（消息级）、fork-from-message、draft、yolo 开关、分享链接**。

### 3.2 审批 + 澄清双卡（api/approval + clarify）
独立 SSE 流（不轮询）；once/session/always/deny + pattern keys + 持久化 allowlist；`inject_test` 端点专测该链路。clarify 与审批同构：agent 反问 → 结构化选项卡 → 回填。
→ 我们完全没有。这是 P0。

### 3.3 压缩工程链（compression_anchor / recovery）
异步手动压缩（compress/start + status 轮询）、压缩锚点（anchor-scene 保存可见消息窗口）、崩溃后按锚点恢复（recovery/repair-safe + audit）、`compression_exhausted` 错误态。
→ 我们有 compact 命令但无锚点/恢复语义。快照权威模型下做恢复比它容易（重拉快照即恢复），但**压缩过程的 UI 语义**（进行中分割线、恢复提示）该抄。

### 3.4 错误分类学（messages.js SSE 错误态）
14 种：rate_limit / quota_exhausted / compression_exhausted / model_not_found / interrupted / silent_failure / tool_limit_reached / fallback / gateway_auth_error / approval_gateway_offline / auth_mismatch / cancelled / no_response…
每种有专属 UI 文案与恢复动作（如 quota → 跳 provider 面板）。
→ 我们的 wire response 只有 ok:false+error 字符串。**错误应该在协议层枚举化**（wire 加 error.code），前端才能做差异化恢复。

### 3.5 Slash 命令系统
29 命令：background / branch / btw / clear / compact / goal / interrupt / model / new / personality / queue / reasoning / retry / skills / status / steer / stop / theme / title / undo / usage / voice / workspace / yolo…
composer 输入 `/` 触发下拉补全（commands.js 注册表驱动）。
→ omp TUI 本身有丰富 slash 命令，web 端却是裸输入框。**serve 暴露命令注册表 + web composer 补全**是白捡的功能面。

### 3.6 Cron 面板（panels.js:474-2115）
preset 体系（hourly/daily/weekdays/weekly/monthly/custom）+ **实时 cron 表达式预览** + kind 自动识别（cron/interval/once）+ run watch（运行中实时跟踪）+ completion alerts（后台任务完成提醒）+ delivery options（多渠道投递）+ history/output 流。
→ 对照我们 Agent 详情里的 cron tab（规划中）：preset + 表达式预览 + run watch 三个交互直接抄；数据面走 gateway scheduler 已有的 test-run/logs 契约。

### 3.7 Kanban 桥（kanban_bridge + api/kanban）
看板任务 → **claim → spawn worker 子进程** → 结果回写；dry-run 预览 claim 范围；lane 按 profile 分列或合并；assignee/tenant/archive 过滤。
→ 对应我们的 task 子 agent 体系。价值在于「任务队列 → agent 消化 → 结果落卡」的闭环可视化。P2 再看。

### 3.8 Insights（panels.js:4411）
period 选择（30d）+ 并行拉 /api/insights + wiki status + skill usage + **model health 成本表**（每模型 in/out 单价 + 推荐降级路径）+ system health 面板。
→ 我们有 self-evolution DB + stats 包，缺一个 web 端汇总视图。CEO 视角的成本表值得做。

### 3.9 Memory 五分区（panels.js:5276）
memory（agent 笔记）/ user（用户画像）/ soul（人格）/ project_context（只读）/ external_notes（Joplin/Obsidian/Notion 源检索）。
→ 我们 memories/ 协议 + user.md 已有对应物，web 端做只读投影 + memory 编辑即可，不抄外部笔记源（暂无需求）。

### 3.10 Providers 面板（panels.js:10885）
provider 卡片 CRUD + **quota 卡 + 费用曲线图** + self-hosted 预设（ollama/lmstudio 默认 URL）+ OAuth 连接 + **Auxiliary Models**（辅助模型选择：总结/压缩用便宜模型）。
→ 「压缩/总结走廉价辅助模型」是好机制，对应 agent-core 的 compaction 模型可配置。

### 3.11 设置中心
8 分区（conversation/preferences/appearance/providers/plugins/extensions/system/help）+ **设置搜索索引**（跨分区搜设置项）+ appearance 即时预览 + 打开时快照/discard 回滚 + **侧栏 tab 隐藏/拖拽排序** + **composer 控件排序**（均 localStorage 持久化）。
→ 设置搜索 + tab 自定义是界面复杂度上去后的刚需，抄。

### 3.12 其他一手证据
- **Saved prompts**：composer 常驻下拉，保存常用 prompt（live 页面实测有此按钮）
- **Artifacts tab**：右栏文件/产物双 tab（live 实测）
- **Update banner**：页面顶部 agent 版本更新提示 + What's new（live 实测）
- **消息 TTS**：每条消息 Listen 按钮（body.tts-enabled 才显示）
- **queue 卡**：index.html 有 queue card 容器（排队消息可视化）
- **steer 指示条**：steer-indicator 斜体 banner + steer-badge（messages.js）
- **web 终端**：/api/terminal/* xterm.js 直连
- **i18n**：全站 key 化（data-i18n-title），6+ 语言

## 四、测试与 CI

~1150 文件 / ~11.5k 测试；conftest 强隔离（独立 port + state dir，永不碰生产）；CI：3 Python 版本 × 3 分片 + ruff + **headless browser smoke** + docker smoke + conversation-lifecycle 专项。
→ 我们缺的只有 browser smoke（前面已提）。协议 e2e 我们已有（fake RPC 模式），质量不输。

## 五、multidevice-host 改善建议（最终优先级）

| # | 建议 | 落点 | 量级 | 依据 |
|---|---|---|---|---|
| 1 | **审批+澄清闸门**：pi-agent-core 挂起钩子 → wire `permission_request` push + `permission_respond` 命令（含 once/session/always + pattern keys）→ web 审批卡/澄清卡 | agent-core + pi-wire + serve + web-app | 大 | §3.2 |
| 2 | **wire 错误码枚举**：response.error 从字符串升级 `{code, message, hint?}`，先定 12 个码（对齐 §3.4 分类学） | pi-wire + serve | 小 | §3.4 |
| 3 | **slash 命令面**：serve 加 `list_commands`；web composer `/` 补全下拉 | serve + web-app | 小 | §3.5 |
| 4 | **消息级 undo/retry/fork**：wire 加 `undo_exchange`、`retry_from`；fork 复用现有 branch 语义 | pi-wire + serve | 中 | §3.1 |
| 5 | **cron 面板三件套**：preset+表达式预览+run watch，数据走 gateway scheduler 契约 | web-app（+serve 只读代理） | 中 | §3.6 |
| 6 | **Insights 汇总页**：self-evolution + stats + 模型成本表（单价从 models.json 取） | web-app + serve 只读 | 中 | §3.8 |
| 7 | **Memory/画像只读投影**：五分区简化为 memory/user/project 三区 | web-app | 小 | §3.9 |
| 8 | **辅助模型配置**：compaction/summarization 模型可配 | agent-core + web-app | 中 | §3.10 |
| 9 | **Saved prompts + 设置搜索 + tab 自定义** | web-app | 小 | §3.11 |
| 10 | **Artifacts 产物 tab**：右栏文件/产物双 tab（图片、导出物） | web-app | 小 | §3.12 |
| 11 | **queue 可视化 + steer 指示条**：排队消息卡、steer 斜体 banner | web-app | 小 | §3.12 |
| 12 | **费用曲线**：per-agent token/费用聚合（serve 已有 get_session_stats 基础） | serve + web-app | 中 | §3.10 |
| 13 | browser smoke 进 CI（Playwright 连真实 serve） | CI | 小 | §四 |
| 14 | token 出 query、/health、路径穿越防护（前轮遗留） | serve | 小 | 前轮 |

**不建议抄**：进程内 import agent（并发缺陷根源）、SSE+轮询兜底（WS 心跳已覆盖）、vanilla JS 单体（维护性差）、27k 行 if/elif 路由（反面教材）、Kanban worker 桥（等 task 体系成熟）。

## 六、功能密度对照（为什么"它比 mock 多太多"）

live 实测 + 源码统计，hermes 前端可交互功能点约 **180+**（11 panel × 平均 8-15 子功能 + composer 8 控件 + 消息 6 操作 + 29 命令）。我们 web-app 当前约 **40**。差距不在架构（我们的协议/状态模型更强），在**产品化深度**：每个域都做了 CRUD 全链路 + 边缘态 + 恢复路径。上面的建议清单按「每个功能点半天到两天」估，#1-#4+#9-#11 约两周可把日常高频面拉平。
