# OMP 多端前端 · 开发计划

> 2026-08-17 · 依据：`requirements.md`（PRD，P1-P5 roadmap）· `mock/*.html`（视觉稿）· `FRAMEWORK-MAPPING.md`（施工图）· `multidevice-host.md`（架构）
> 原则：**命令面先闭环，页面后接入**。页面是视觉稿，命令是落地开关。

---

## 0. 编号消歧（重要）

| 架构文档编号（multidevice-host.md，后端视角） | 需求编号（requirements.md，命令面视角） |
|---|---|
| P0 快照层 + wire 类型 | ✅ 已完成（属 P1） |
| P1 serve WS 宿主 | ✅ 已完成（属 P1） |
| P2 pi-wire + pi-client | 本计划 **阶段 1**（P2 前置） |
| P3 Web 端 | 本计划 **阶段 2-3**（P2 主体） |
| P4 多会话 | 本计划 **阶段 4**（P3 主体） |

> 本计划使用 **阶段 1-6** 编号，避免与两套 P 编号混淆。对应关系见各阶段表头。

---

## 阶段 1 · pi-wire 抽包 + pi-client（地基）

> 对应 roadmap P2 前置 · 架构 P2。**不做这个，前端只能裸连 WS 帧，后面全返工。**

**任务 A：`packages/pi-wire` 独立包（纯类型）**
- 从 `coding-agent/src/server/wire-types.ts` 抽出：帧类型 / MultiplexCommand 命令面 / 协议版本 / ServerFrame
- 命令面仍依赖 `rpc-types` 的 `Extract` 筛选 → pi-wire 定义自己的命令联合类型（消除对 coding-agent 的依赖）
- workspace 注册 + package.json + tsconfig 继承
- 验收：`wire-types.ts` 里的类型改从 pi-wire re-export；`bun run check:ts` 干净

**任务 B：`packages/pi-client`（连接状态机）**
- WS 连接：hello 握手、请求 id 关联（Promise + 超时）、**指数退避重连**（断线重连后自动补快照）
- 快照缓存：`session_snapshot` 缓存为权威源，`progress` 只做事件通知（**不得归约为状态**）
- 订阅语义：`subscribe` 跨重连持续；在途请求断线立即拒绝（`PiDisconnectedError`，fail fast）
- 单测：连接/重连/请求超时/快照缓存/命令发收 5 组
- 验收：替换 serve 手工验证脚本为 pi-client 客户端，真机跑通 hello→快照→prompt 全链路

**产出**：`packages/pi-wire`、`packages/pi-client` 两个新包 + 单测。

---

## 阶段 2 · serve 命令面补全（12 条）+ Web 壳

> 对应 roadmap P2 主体。两条线可并行（后端接线 vs 前端壳）。

**任务 C：serve.ts 命令面补全（12 条）**
| 命令 | 实现位置 | 备注 |
|---|---|---|
| set_model / cycle_model | session.setModel + modelRegistry | 需与 TUI 相同的 selector 解析 |
| compact | session.compact() | — |
| set_todos | session 现有 todo 写路径 | — |
| set_host_tools | session.setHostTools() | toolsets 语义确认 |
| set_auto_compaction / set_auto_retry | session 现有开关 | — |
| abort_retry | session.abortRetry() | — |
| abort_and_prompt | abort + prompt 组合 | — |
| new_session | createAgentSession 复用 | 单会话内重置 |
| set_session_name | session.setSessionName() | — |
| get_last_assistant_text | session getter | — |

- 验收：每条命令真机 e2e（bun WS 客户端 or pi-client），错误路径返回 ok:false 带信息
- 影响面：先 `impact` 分析 session 对应方法 → 改 → 单测

**任务 D：Web 壳脚手架**
- 新建前端包（建议 `packages/web-app`，React + Vite + Tailwind）
- 技术栈（已决策）：assistant-ui（转录/流式/工具卡底座）+ shadcn/ui（面板/表单）+ zustand（UI 状态）+ thinking-orbs（动效，npm 包）
- 目录骨架按 `FRAMEWORK-MAPPING.md` 第 4 节：`layout/ pages/ components/ state/ lib/`
- 验收：`bun dev` 起壳，连接 pi-client 到 serve，Home + 工作台路由可达

**任务 E（在 D 内）**：Home 欢迎页 + 会话工作台最小版
- Home：Greeting + Suggestions + Composer + 最近 Agent（get_snapshot）
- 工作台：Transcript 流式 + 工具卡三态 + Composer（assistant-ui）+ 右栏概览/Todo
- **thinking 折叠区**：mock 缺设计，按 TUI `session-observer-overlay.ts` 的 renderThinkingLines 语义补（progress.assistantMessageEvent.thinking_delta 流式追加）
- 验收：真实 serve + 真实模型跑一轮 prompt，流式文本/thinking/工具卡三态全显示

---

## 阶段 3 · Todo / 设置 / 模型市场真实接入

> 对应 roadmap P2 完成态。命令面已齐（阶段 2），本阶段纯前端。

- Todo 面板：set_todos 读写打通（阶段 2 已实现命令）
- 设置：连接信息（hello/协议版本）、auto_compaction/auto_retry 开关、主题/快捷键（本地）
- 模型市场：get_available_models（**从 stub 升级为真实现**）→ 按 Provider 分组展示 → set_model 切换
- 移动端裁剪先行验证：右栏→浮层、模型/thinking→快捷条（同代码 responsive，不单独建页）
- 验收：三页真实数据驱动，无 mock 假数据

---

## 阶段 4 · 多 Agent 架构（server 侧 POC → 前端）

> 对应 roadmap P3。**架构级，最大风险，独立并行线。**

**任务 F：多会话 POC（server 侧，建议与阶段 2-3 并行）**
- serve 从"单 AgentSession"→"会话注册表"：idle/active 两级，每 Agent 独立 session/agentDir
- `server_snapshot` 升级为多 Agent 列表；新增 `switch_session` 真实现
- 复刻 gateway 已验证的每账号一子进程隔离模型（进程/内存/文件系统/故障域四层）
- 验收：一个 serve 管 ≥2 个 AgentSession（如研发 + HR），switch 后快照/推送正确切换；P1 单会话路径不回归

**任务 G：agent 列表/详情真实读写**
- 列表：get_state/server_snapshot 多 Agent → 卡片网格 + 工作区分节 + CODING/WORKER 徽标
- 详情 5 tab：Skills（来源/版本/搜索，见 `skill-management.md` P3 阶段）、Cron（需新增 cron 数据接口，wire 协议扩展）、模型配置（set_model）、工具开关（set_host_tools）、钉钉绑定（gateway 配置，wire 协议扩展）
- 验收：列表/详情操作真实落盘，重进页面状态保持

**任务 H（连接器配置面——已决策 2026-08-17）**：

> **决策**：连接器（钉钉/飞书/lark）继续归 gateway 管（Channel 接口 + registry 已存在，`packages/omp-gateway/src/channels/base.ts`），serve 不承担连接器职责。前端壳只做「配置读写 + 状态只读展示」，不直连连接器运行时。

- **配置 = 本地文件**：AppKey/Secret/绑定 Agent 落 `gateway.json`（已是本地文件）；Web 壳是本地应用，直接读写本地配置，不需要 serve 或 gateway 提供配置 API
- **状态 = 只读展示**：连接状态走 gateway 健康接口（`ChannelHealth`：connected/connectionFailed/reconnectAttempts/establishedAt），serve 加一条只读代理命令或前端直连 gateway 只读端点
- **用户画像**：gateway 从 IM 会话日志生成，Web 壳只读展示（走上述只读路径），serve 不复制数据
- **接飞书（第 2 个连接器）工作量**：新 `feishu.ts` 实现 Channel + registry 注册 + config schema + formatter/media/card 适配；不动 serve、不动前端协议。formatter/media 复制点出现时再抽公共层（第 3 个连接器前不预测性抽取）

---

## 阶段 5 · 会话记录 / 回放 / 语音

> 对应 roadmap P4。

- serve 命令面：get_messages / get_session_stats / get_branch_messages / branch 真实现（session JSONL 读取）
- 记录列表页：按日期/Agent/状态筛选 + 搜索
- 回放页：播放/暂停/速度/进度球 + 右侧时间线（从真实 JSONL 拉取）
- Voice/Jarvis：录音球 + 唤醒 + 转文字 → prompt → TTS 播报闭环（prompt 命令已可用）
- 验收：回放消息时间线与 TUI 会话一致；语音全链路真机

---

## 阶段 6 · 移动端 + 桌面壳

> 对应 roadmap P5。

- 移动端：responsive 裁剪最终化（浮层面板/折叠工具卡/44px 触控），设备预览联调
- 桌面壳：Electron（成熟优先；Tauri 备选）包 Web 应用 + 本地 serve 自启
- 验收：375px 视口可用；桌面壳双击启动即连 serve

---

## 依赖图（关键路径）

```
阶段1 pi-wire/pi-client ──▶ 阶段2 Web壳 + 命令面 ──▶ 阶段3 Todo/设置/模型市场
        │                        │                            │
        │                        └──▶ 阶段5 记录/回放/语音 ◀───┘
        └──▶ 阶段4 多Agent POC（独立并行）──▶ 阶段4b agent页面 ──▶ 阶段6 移动端+壳
```

- **关键路径**：阶段1 → 阶段2 → 阶段3 → 阶段5 → 阶段6
- **可并行**：阶段4（server 侧）与阶段2-3 无依赖，尽早启动
- **依赖前置**：阶段1 必须在任何前端页面前；钉钉集成命令（任务 H）需 gateway 侧配合

## 并行建议

1. **线 A（web）**：阶段1 → 2 → 3 → 5 → 6
2. **线 B（多 Agent）**：阶段4 全程并行，阶段 4b 等其 POC 稳定
3. 团队 ≥2 人时分两线；1 人则 A 优先，B 穿插

## 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 多 Agent 是架构级改动，单会话路径回归 | 高 | POC 先行 + P1 e2e 6/6 作回归基线 |
| 钉钉集成命令归属不清（serve vs gateway） | 中 | **已决策（2026-08-17）**：连接器归 gateway，前端壳走本地文件配置 + 只读状态，见任务 H |
| thinking 流式 mock 缺设计 | 低 | TUI overlay 已有实现，照语义抄 |
| 快照 messages 全量传输，长会话几十 KB | 低 | P3 后做尾部/分页，先不做 |
| worktree 无 natives 构建产物 | 低 | 新 checkout 需 `bun --cwd=packages/natives run build` |

## 每阶段落地检查

每阶段完成时：`impact` 分析受影响符号 → 改 → 跑对应单测/e2e → 按 release 流程记 CHANGELOG。全程遵守 AGENTS.md 硬约束（tsgo/biome/logger/无 inline prompt 等）。