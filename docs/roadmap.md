# CornField Roadmap

> 单文件功能路线图：每个功能到了哪、下一步去哪、卡在哪。替代功能盘点视角。
> 状态定义：✅ 已落地（可验收）｜🔄 进行中（有代码或明确的下一步）｜🔜 规划中（想法/待排期）｜📐 设计定稿（文档已定，待开工/待拍板）
> 数据来源：docs/ 62 篇功能文档逐篇精读 + TODO.md + CHANGELOG，生成时点 2026-09-01。
> 维护规则：功能状态变化时更新对应行；新功能先查"规划中"再立项；落地后移入 ✅ 并补链路（单篇文档 + 测试 + 验收证据）。

---

## 一、路线图总览

| 功能域 | ✅ 已落地 | 🔄 进行中 | 🔜 规划中 | 📐 设计定稿 |
|---|---|---|---|---|
| Agent 运行时 | 12 | 0 | 0 | 2（multi-agent 编排、prompt-assembly） |
| 模型与配置 | 5 | 0 | 0 | 0 |
| 客户端与通信 | 3 | 1（统一协议层 P3） | 4（桌面客户端、前端框架、开机首页、编辑器扩展） | 2（agent-hub、editor-extension） |
| 扩展与技能 | 5 | 0 | 0 | 4（telemetry 等 authoring 指南） |
| Gateway 与调度 | 4 | 2（动态注册、钉钉提取待办） | 0 | 1（agent-bridge 布局） |
| MOA 多 Agent | 1 | 0 | 1（组队编程深挖） | 0 |
| 原生能力（Rust） | 8 | 1（任务取消规范落地） | 0 | 0 |
| 工具与 MCP | 6 | 1（web-search 升级） | 1（搜索列表页） | 0 |
| TUI 与界面 | 5 | 0 | 0 | 0 |
| 语音 | 1 | 1（客户端 ASR+TTS 优化） | 0 | 1（Orb UX） |
| 自进化 | 1 | 1（skill 诊断三阶段落地） | 1（WikiSkill 闭环、本体论） | 0 |
| 功能管理 | 0 | 1（功能管理面板） | 0 | 0 |
| **合计** | **51** | **8** | **7** | **8** |

---

## 二、已落地（主线 1.0.0，2026-08-29 品牌迁移完成）

### Agent 运行时（12）
- Session JSONL v3 存储 + 会话树 + 上下文重建（agent/session.md）
- 会话操作：切换 / 导出 / 分享 / fork / resume（agent/session-operations.md）
- 上下文压缩 + 分支摘要（agent/compaction.md）
- 跨会话自主记忆 memory protocol（默认关闭，memories.enabled 开启）
- 规则系统：多源发现 → 归一化 → 优先级 → 三分桶分发（agent/rulebook.md）
- Task agent 定义发现与执行时选择（agent/task-discovery.md）
- /handoff 会话切换上下文注入（agent/handoff.md）
- TTSR 流中断重试生命周期（agent/ttsr.md）
- Blob 内容寻址 + artifact:// 解析（agent/artifacts.md）
- API 错误自动重试策略（agent/retry-policy.md）
- RPC 协议（NDJSON over stdio）+ Host Tool 子协议（agent/rpc.md）
- 进程内 SDK 嵌入（agent/sdk.md）

### 模型与配置（5）
- token/tool 流式归一化（ai/streaming.md）
- 配置发现与解析优先级（config/config-usage.md）
- 环境变量全参考（config/environment-variables.md）
- models.yml 模型注册/选择/等价分组（config/models.md）
- 密钥混淆脱敏（config/secrets.md）

### 客户端与通信（3）
- 桌面客户端 Electron 壳 + web-app 工作台（client/desktop.md）
- 多端接入：TUI/Web/PC/Mobile 快照 + wire 协议 + serve 宿主（client/multidevice.md，P0/P1 ✅）
- 进程间通信 intercom broker（list/send/ask/reply/presence/mailbox/父子边，已接入生产）

### 扩展与技能（5）
- ExtensionAPI 扩展运行时（工具/命令/事件/UI 集成，五路发现）
- Hook 子系统（遗留 API，事件拦截）
- 插件市场 marketplace（四路源 + 双作用域安装）
- gemini-extension.json 清单发现
- Skill 系统（SKILL.md 多提供者管道 + skill:// URL + /skill: 注入）

### Gateway 与调度（4）
- Gateway 消息交换机 + 调度器（2026-06-23）
- Cron 调度引擎 + host-tool 机制（Tier 1 ship）
- IM Agent Prompt 分层（custom-system-prompt.md）
- 一账号一 RPC 进程模型 + AgentBridge（ADR-0001）

### MOA 多 Agent（1）
- MOA 多轮多 Agent：Discovery → Pre-Ask → Loop → Synthesis（moa-extension 34+ 测试）

### 原生能力 Rust（8）
- Loader + N-API 双层架构（AVX2 modern/baseline）
- Loader 运行时（候选探测 / 嵌入式提取 / 故障诊断）
- JS↔Rust 绑定契约
- 构建 / 交叉编译 / 发布 / 调试
- 媒体与系统工具（PhotonImage / SIXEL / HTML→MD / 剪贴板 / Token 计数 / macOS 电源 / Windows ProjFS）
- Shell / PTY / 进程树 / 按键解析（Kitty / modifyOtherKeys）
- 文本搜索管线（regex / grep / fuzzyFind / glob / AST / syntect）
- FS 扫描缓存（四维 key / TTL / 空结果重查）

### 工具与 MCP（6）
- MCP 配置与运行时生命周期
- 自定义工具 + MCP server 集成
- Bash 工具调用管线
- Resolve 工具 Preview/Apply 工作流
- Notebook 工具
- Python REPL 执行栈

### TUI 与界面（5）
- 差分渲染引擎 + 组件契约 + 扩展 UI
- 主题系统（57 token / 热重载 / 色盲模式）
- /tree 会话树导航
- Slash 命令（五源 Provider 去重 + 模板展开）
- Voice 面板（并入语音）

### 语音（1）
- Voice Jarvis 实时对话 P0/P1：四层架构、双工 ≤1.5s、六类意图、分级确认门 fail-closed、task 走主会话全量工具链

### 自进化（1）
- Evolution V4：三层记忆、四种提取、认知管道钩子、Nudge/Escalation、14 Agent 工具、/evolution 15+ 子命令

---

## 三、进行中（带进度与下一步）

| 功能 | 进度 | 下一步 | 阻塞 / 依赖 |
|---|---|---|---|
| 统一协议层 P3（TUI 切 Wire） | P0✅ P1✅ P2✅（含实机验收）；P3 代码完成在 feat/agent-work | 合入 main + 实机验收 | 分支未合 |
| gateway agent 动态 enable/disable | 热生效闭环已提交（640beaf005）；动态注册能力待补 | 动态注册 + 验收 | topics/agent-client-config.md |
| 钉钉群消息/文档自动提取重要待办 | 方案已建 | 落地识别管线 + 待办写入 + 提醒 | topics/dingtalk-extract-important-todos.md |
| session 诊断 → learning/nudge/regression | 诊断六维已归档 | 三阶段落地链路 | topics/session-diagnosis-loop.md |
| 客户端语音优化（ASR + TTS） | 基线 Whisper + 云端 ASR 已通 | 体验优化（端点化/噪声/延迟） | 语音状态机缺口清单 |
| web-search 工具升级 | 现有多 provider 搜索 | 能力升级 + 结果列表页（客户端展示 + 点击查看） | 前后端两个 todo |
| 功能管理面板 | 需求已列 | 进度/状态/完成/验收 结合待办管理 | 待立项 |
| omp 本地定时器 | 需求已列 | 与 gateway cron 对齐或独立 | 待立项 |
| Rust 任务取消规范落地 | 规范已定（docs/natives） | 新可取消导出按 Checklist 落地 | 逐个导出迁移 |

---

## 四、规划中（带优先级）

| 功能 | 优先级 | 依赖 / 备注 |
|---|---|---|
| OMP 桌面客户端（Tauri 主 app + 编辑器 fork Zed） | 高 | topics/omp-client-design.md |
| 独立验证者（执行与验证分离，独立进程验收） | 高 | topics/independent-verifier.md |
| 组队编程深挖（grill + squad-programming 组合） | 中 | 依赖 intercom 成熟 |
| dataAgent 本体论能力 v1.0 | 中 | 未立项 |
| 客户端开机首页默认显示每日日程和待办 | 中 | 依赖日程/待办数据源 |
| omp 前端框架 | 中 | 方向未定（web-app 演进？） |
| 学习使用 herdr-board | 低 | 工具学习类 |
| WikiSkill 集成（Pattern→Proposal→Validation→Outcome 闭环） | 待定 | topics/wikiskill-cornfield-integration.md |

---

## 五、设计定稿待开工 / 待拍板

| 功能 | 状态 | 对应文档 / 分支 |
|---|---|---|
| 数字员工中枢 agent-hub | 设计 16 项拍板 / 3 项待拍板 | client/agent-hub.md |
| 编辑器扩展（OpenSumi 方案） | 设计完成，未开工 | client/editor-extension.md |
| Voice Orb UX 重设计 | 待拍板 | voice/orb-redesign.md（分支 feature/voice-ux） |
| 技能遥测系统 | 设计终稿 2026-08-12 | skills/telemetry.md |
| 多 Agent 编排（Supervisor+Specialists） | 设计讨论中 | agent/multi-agent-orchestration.md |
| Prompt 组装 v1.0 | 设计讨论中 | agent/prompt-assembly.md |
| agent-bridge 布局 MECE | 骨架已实施，细节待定 | gateway/agent-bridge.md |

---

## 六、单篇文档快查（docs/ 索引）

> 需要细节时点链接进入单篇。功能树在这份 roadmap；文档树在 docs/README.md。

### agent
session · session-operations · compaction · memory（默认关） · rulebook · task-discovery · handoff · ttsr · artifacts · retry-policy · rpc · sdk · prompt-assembly（设计） · multi-agent-orchestration（设计）

### ai / config
ai/streaming · config/config-usage · config/environment-variables · config/models · config/secrets

### client / intercom
client/desktop · client/multidevice · client/editor-extension（设计） · client/agent-hub（设计） · intercom/intercom

### extend / skills
extend/extensions · extend/hooks · extend/marketplace · extend/gemini-manifest · skills/skills · skills/authoring-marketplaces · skills/authoring-hooks · skills/authoring-extensions · skills/telemetry（终稿）

### gateway / moa
gateway/gateway · gateway/cron · gateway/agent-bridge（设计） · gateway/im-agent-prompt · moa/moa

### natives
natives-architecture · natives-addon-loader-runtime · natives-binding-contract · natives-build-release-debugging · natives-media-system-utils · natives-rust-task-cancellation（设计） · natives-shell-pty-process · natives-text-search-pipeline · fs-scan-cache

### tools
tools/mcp · tools/tool-authoring · tools/bash-tool-runtime · tools/resolve-tool-runtime · tools/notebook-tool-runtime · tools/python-repl

### tui / voice / adr / 根级
tui/tui · tui/theme · tui/tree · tui/slash-commands · voice/voice · voice/orb-redesign（设计） · adr/0001 · adr/0002 · self-evolution

---

## 附：统计口径

- ✅ 51 已落地｜🔄 8 进行中｜🔜 7 规划中｜📐 8 设计定稿/待拍板（合计 74 项，含跨域重叠）
- 覆盖：docs/ 62 篇功能正文（15 域）+ TODO.md 18 项待办 + 4 条设计定稿
- 时间线：未列具体日期——业务节奏（9 月最小运营 / 港交所冲刺）由你排期，需要时在"规划中"补季度里程碑列
