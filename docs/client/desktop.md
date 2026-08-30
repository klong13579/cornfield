# CornField 桌面客户端功能说明

> 状态：持续更新 · 盘点基准：2026-08-29 代码快照（commit ae79d26）· 范围：`packages/desktop` + `packages/web-app` + `packages/editor-extension` + 协议层 `packages/pi-wire` / `packages/pi-client`
> 本文件回答「现在客户端能干什么」；历史形态设计（Tauri+Zed 方案）已归档废弃，以本文件 + 代码为准。

## 1. 客户端构成

|包|形态|成熟度证据|
|---|---|---|
|`packages/desktop`|Electron 壳（托盘常驻 + sidecar 拉起 `cornfield serve` + 自动更新）|已产出 `CornField-1.0.0-arm64.dmg`|
|`packages/web-app`|React + Vite 工作台，12 个页面，约 13k 行|9 个测试文件（含 3 个 e2e）|
|`packages/editor-extension`|编辑器扩展|仅空 `configs/` 目录，未实现|
|`packages/pi-wire` / `packages/pi-client`|WebSocket 协议层（hello 握手 / 心跳 / 重连 / 权威快照缓存）|命令面 70+ 条，里程碑注释 P0–P4 / W3|

## 2. 判定口径

- **稳定** = 页面 + 服务端命令 + 测试/验证齐备
- **待实现** = 协议或 UI 单方就绪、有占位/TODO、或只读未写
- **未实现** = 无界面无协议

## 3. 功能清单（按行业 8 层结构）

### 1. 会话与项目层

|功能|状态|依据 / 缺口|
|---|---|---|
|会话侧栏 / 新建 / 切换 / 续聊|稳定|WorkspaceView + SessionSidebar；`new_session` / `switch_session` 全链路|
|历史会话索引 + 回放|稳定|/records 双页（RecordsView + PlaybackView）；`list_sessions` / `get_session_messages`，分支回放有测试|
|项目 TODO.md 看板|稳定（只读）|/todo 解析渲染勾选项；勾选写回缺失|
|主题 / 项目分组|未实现|仅 TODO 归组，无会话 project 分组概念|

### 2. 记忆与个性化层

|功能|状态|依据 / 缺口|
|---|---|---|
|记忆投影（memory / user / project 三分区）|稳定（只读）|/memory，`get_memory`|
|画像 / 配置读写|稳定|HomeView 读 user.md 渲染问候；`get_config` / `set_config` / `get_tool_switches`|
|设置页（自动压缩 / 自动重试 / 主题 / 快捷键）|稳定|SettingsView；`set_auto_compaction` / `set_auto_retry`|
|知识库挂载（绑定文档 / RAG 源）|未实现|客户端无 UI，协议无对应命令|

### 3. 能力层（工具 / 扩展）

|功能|状态|依据 / 缺口|
|---|---|---|
|MCP 服务器 CRUD + 连通测试|稳定|SettingsView 四命令（`get/set/remove/test_mcp_server`），有 gateway-wire 测试|
|技能启停（热重载）|稳定|SkillsView toggle；`set_skill_enabled`|
|技能市场（远程列表 / 安装）|待实现|`list_remote_skills` / `install_remote_skill` 已通，契约收口中|
|三方渠道集成配置（钉钉）|待实现|SettingsView 钉钉区为读占位；通知缺口 B7 disabled|

### 4. 任务执行层

|功能|状态|依据 / 缺口|
|---|---|---|
|对话 / 自主执行（steer / 跟进 / 中断 / 排队）|稳定|ComposerBar + QueueCard + SteerIndicator，语义完整|
|cron 任务表 / 执行日志 / 到期通知|稳定（只读）|TasksView + CronWatcher + 前端 cron 表达式构建器|
|cron 新建 / 编辑 / 启停（写）|待实现|协议无 `set_cron` 类命令|
|多 agent 注册表 / 详情 / 工作区浏览|稳定|/agents（lazy attach），AgentDetailView；P3 多 agent 升级|
|审批 / 澄清 UI|待实现|PermissionHost / ApprovalCard / ClarifyCard 齐备，服务端有 permission-gate；但 `inject_permission` 为壳内 mock，**未接 agent-core 真实管线**|
|多 agent 流水线编排|未实现|仅切换，无编排概念|
|后台 / 并行任务视图|待实现|协议有 `get_async_job_snapshot`，前端无对应 UI|

### 5. 交付物层

|功能|状态|依据 / 缺口|
|---|---|---|
|工作区文件浏览 + 图片预览|稳定|FileExplorer；`fs_list` / `fs_read` / `fs_read_image`（含 2MB 图片管道）|
|产物面板 + 静态预览|稳定|ArtifactsPanel + `/preview` 路由，有测试|
|文件编辑 + diff|待实现|`fs_write` / `fs_edit` / `fs_diff`（票 01）+ LSP writethrough 已通；前端编辑 UX 未接|
|Git 集成|未实现（协议就绪）|票 02 五条 `git_*` 命令已定义；`pi-client-api.ts` 无对应方法|
|引用溯源 / citation|未实现|—|

### 6. 协作层

|功能|状态|依据 / 缺口|
|---|---|---|
|审批流（见 4）|待实现|同上|
|共享链接 / 团队空间 / 评论|未实现|—|

### 7. 可观测与治理层

|功能|状态|依据 / 缺口|
|---|---|---|
|用量 / 成本 / 错误率统计|稳定|/insights；`get_stats` + priceCatalog 单价 + period 切换（1d/7d/30d/90d）|
|会话回放 / 分支审计|稳定|/records PlaybackView 分支回放（`get_branch_messages`）|
|请求审计 / 安全日志视图|未实现|内核有 request-audit，客户端无视图|
|eval / 评估工作台|未实现|—|

### 8. 入口层

|功能|状态|依据 / 缺口|
|---|---|---|
|Web 工作台|稳定|12 页面全通，e2e 测试|
|桌面壳（托盘 / 自动更新）|稳定|1.0.0 dmg 已产出；preload 最小面锁死（contextIsolation + sandbox）|
|终端 TUI|稳定|内核自带（本文件范围外，见 tui/tui.md）|
|Slash 命令面板|稳定|SlashPalette；`list_commands` 真源|
|语音转写听记|稳定|/voice + /listen 双页；audio-encode + listen-e2e 测试|
|语音对话 / 唤醒|未实现|Jarvis 唤醒词为偏好存储占位（见 voice/voice.md）|
|编辑器扩展（项目选择 / 文件编辑预览 / Git / Agent assistant）|未实现|`editor-extension` 仅空 configs；fs 写 + git 协议正是为它预留（票 01 / 票 02）|

## 4. 总体结论

- 稳定面已是一套完整工作台：会话 + 回放 + 用量 + 技能 + MCP + 产物 + 模型 + 多 agent + 听记 + 桌面壳。
- 待实现部分共性是「写」操作：cron 新建、知识库挂载、审批真实打通、文件编辑 UX、Git UI——当前客户端偏观察台，执行类写操作仍集中在 TUI / 对话。
- 未实现里优先级最高的是编辑器扩展：协议层票 01（fs 写 / diff）票 02（git）已备好，缺实现本体。

## 5. 右面板扩展规划（2026-08-30 评审归档）

> 仅归档功能点，不做开发。定位：右栏（`RightPanel.tsx`，300px，现 Files/Artifacts 双 tab）= 会话的「工作台视图」——主区是时间线（消息流），右栏承载时间线承载不了的结构化聚合：改了什么、留下什么、等什么批准。参照系为以对话为主界面的产品（OpenAI Codex 网页版 / Claude.ai 任务模式），**非 IDE 侧栏**（IDE 右栏装对话，本产品主区已是对话，实时活动流类功能不重复做）。

已有基础：`PermissionGate` 已广播 `permission_request`（3.4 审批 UI 组件齐备、待接真实管线）；ArtifactsPanel + `/preview` 稳定；`fs_diff` / `git_*` 协议就绪；`get_memory` 三分区已有。

|功能|目标|状态 / 依赖|
|---|---|---|
|**审批队列** ★|常驻审批 dock：谁在等什么、批准/拒绝，多 agent 跨会话|待实现；`inject_permission` 需接 agent-core 真实管线（见 3.4）|
|**文件改动清单 Changes** ★|会话内文件改动聚合视图（fs_diff/git），逐条 diff + 回滚|待实现；`fs_diff` / `git_*` 协议已就绪|
|**产物 gallery** ★|对话产物自动收集为卡片墙，点开即预览|待实现；ArtifactsPanel + `/preview` 已有，扩展收集逻辑|
|多 agent 状态板|当前会话外其他数字员工的阻塞 / 结果聚合|待实现；registry 多 agent 语义已有|
|上下文注入清单 ★|会话引用的文件 / 技能 / 记忆条目，预览 + 摘除|待实现；`get_memory` / `get_skills` 已有|
|上下文占用条|compaction 预警（token 用量条）|待实现|
|检查点时间线|serve 侧每步快照 + 回滚|待实现；需内核快照机制，本批成本最高|
|工具健康清单|MCP 工具加载失败红点列表（现仅日志可见）|待实现；失败信息现只写日志|
|成本燃烧速率|会话级 token / 费用实时|待实现；`get_stats` + priceCatalog 已有|

★ = 2026-08-30 评审明确要求纳入（文件改动清单、产物、上下文注入清单）。其余为同轮探讨保留项，优先级顺序：P0 = 审批队列 + Changes + 产物 gallery；P1 = 多 agent 状态板 + 上下文注入清单 + 上下文占用条；P2 = 检查点时间线 + 工具健康 + 成本燃烧速率。

## 6. 会话诊断（2026-08-30 评审归档）

> 定位：会话质量 / 失败归因的诊断功能，两种粒度——**单会话诊断** 与 **按 agent 聚合诊断**。入口拟为新增左栏面板「诊断」，会话选择复用 /records、agent 选择复用 /agents。关联 TODO：`session 诊断优化：诊断结果 → learning/nudge/regression 三阶段落地`（topics/session-diagnosis-loop.md，本功能的闭环出口）。

|模式|描述|
|---|---|
|单会话诊断|选一个历史会话 → 输出诊断报告（6 维度 + 根因 + 建议）|
|按 agent 诊断|选一个 agent → 聚合其全部会话的诊断摘要（失败率、平均耗时/token、compaction 频率、工具失败 TOP、高频模式），可下钻到单会话|

**六维诊断框架**（对齐 agent 侧既有诊断维度，客户端不重复发明）：

|维度|内容|
|---|---|
|meta|会话元信息：模型、时长、消息数、compaction 次数、中断/abort|
|performance|耗时分布、token 消耗、吞吐、卡顿段|
|turns|轮次质量：答非所问、重复、截断、意图漂移|
|reasoning|推理链：死循环、幻觉、计划缺失|
|tools|工具链：调用失败、超时、无效参数、重复调用|
|output|输出规范性：格式违规、截断、空回复|

**架构选择**：推荐服务端诊断（serve 新增 `diagnose_session` / `diagnose_agent` 命令，内核直读会话 JSONL + 事件流返回结构化报告，前端只渲染）——对比前端拉消息自分析的方案（还得再调 LLM/写规则，不准且费 token）。服务端方案可被 gateway / TUI / 回放复用，诊断结果落 self-evolution `evolution.db` 供三阶段闭环消费。

**依赖**：
- serve：新增诊断命令（协议层 + 内核分析器）；数据源为现有 `list_sessions` / `get_session_messages` / `get_branch_messages`（回放管线已验证）
- 前端：诊断面板 + 报告渲染（雷达/列表）+ agent 聚合视图 + 下钻
- evolution.db：诊断结果持久化，接通 learning / nudge / regression

**入口**：/records（单会话）+ /agents（按 agent）；诊断报告支持标记 → 进三阶段闭环（pending）。