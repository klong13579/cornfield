---
name: Agent 客户端配置验证——三层配置模型盘点 / 差距分析 / 动态注册启停建议
status: done            # 盘点完成；实施按建议清单排期
objective: 验证 Agent（重点 gateway agent）的配置能力与前端暴露面是否对齐；两个待办合并思考（配置验证 + gateway agent 动态注册/启停）
doneWhen: |-
  - 配置模型按三层拆清（L1 系统功能层 / L2 账号内容层 / L3 运行时态）
  - 差距分析覆盖三层，前端缺失项按「配置面完整度优先」排期
  - 热生效闭环（写 gateway.json → reload → 动态启停账号）落地为 wire 命令 + 前端 UI
lastActivity: 2026-09-01
sessionRefs: []
nextAction: 实施热生效闭环——新增 gateway 写命令（set_gateway_account/reload）+ 前端钉钉 tab 编辑化
artifacts:
  - topics/agent-client-config.md     # 本文档：三层盘点 + 差距 + 建议
decisions:
  - 2026-09-01 — gateway 配置是系统功能（L1），与 agent 配置（L2 每账号 agentDir）分离盘点
  - 2026-09-01 — 合并待办「gateway agent 动态注册 + 动态 enable/disable」：第一性交付 = 配置热生效（复用 Gateway.reload diff 计划）
  - 2026-09-01 — Q3 口径：差距分析 + 新增建议；排序按配置面完整度
openQuestions:
  - 前端补齐批次（影响最大 / 成本最低 / 按依赖）

## 进度记录

- 2026-09-01 — 文档完成，两份待办（Agent 客户端配置验证 / gateway agent 动态注册启停）已链接本 topic 作为验收基线
---

## 0. 三层配置模型（用户纠偏后）

| 层 | 对象 | 内容 | 生效方式 | 属主 |
|---|---|---|---|---|
| **L1 系统功能层** | `~/.cornfield/gateway.json` | 通道/账号凭证/cron/session/agent 参数、deniedTools、dmPolicy、机器人启停 | **动态 reload（现成但无入口）** | 运维控制台 |
| **L2 账号内容层** | 每个 `agentDir/` | mission/user/.cornfield/config.yml/skills/prompts/AGENTS.md/prompt-includes/TODO | 改文件，新会话生效 | Agent 配置 |
| **L3 运行时态** | 账号注册/启停状态 | 动态 enable/disable、热生效、bridge 生命周期 | `Gateway.reload()` diff 计划 | 本次待办核心 |

**L1 ≠ L2**：gateway 账号配置是系统功能（机器人怎么连、权限怎么控），不是 agent 的配置；agent 的配置是账号内容（这个 agent 是什么人格、用什么模型、有哪些技能）。前端动 L1 是运维控制台，动 L2 才是 agent 配置页。

## 1. L1 系统功能层盘点（gateway.json）

### 1.1 网关级

| 分组 | 键 | 取值/现状 |
|---|---|---|
| `agent` | `cornfieldPath` / `maxConcurrentSessions` | 3 |
| `agent` | `maxCrashRetries` / `crashBackoffMs` | 崩溃恢复 |
| `agent` | `longTaskThresholdMs` / `progressPingIntervalMs` | 长任务卡片进度 (默认 50s/60s) |
| `agent` | `timeoutMs` | 实际配置 300000 |
| `session` | `resetPolicy` | none/daily/idle/both（实际 both） |
| `session` | `idleTimeoutMinutes` / `dailyResetHour` | 240 / 2 |
| `cron` | `enabled` / `tickIntervalMs` / `maxConcurrentRuns` | 60s / 3 |
| `cron` | `heartbeat` | enabled/every/prompt/deliver |
| `cron` | `deliveryMode` | card/text（AI 卡片全局开关） |
| `channels.dingtalk` | `enabled` / `dmPolicy` / `groupPolicy` | open/allowlist/closed |
| `channels.dingtalk` | `allowedUsers` / `allowedGroups` | 白名单 |

### 1.2 账号级（6 账号：algorithm/hr/me/dataAgent/sw/mcode）

| 键 | 现状 |
|---|---|
| `appKey` / `appSecret` / `robotCode` / `robotName` | 凭证与展示名 |
| `agentDir` | 每账号独立工作区 |
| `deniedTools` | 工具黑名单（当前全账号统一 11 项） |
| `hideThinkingBlock` / `enabled` / `intercomParent` | 显示/启停/归属 |

## 2. L2 账号内容层盘点（每账号 agentDir）

| 文件 | 内容 |
|---|---|
| `.cornfield/config.yml` | modelRoles(default/smol/slow)、hideThinkingBlock、defaultThinkingLevel、theme、bash.autoBackground、async.enabled、disabledExtensions |
| `mission.md` | agent 使命/人格（prompt 主源） |
| `user.md` | 用户画像声明 |
| `AGENTS.md` / `CONTEXT.md` / `TOOLS.md` | 仓库级指南 / 长期上下文 / 工具清单 |
| `.cornfield/SYSTEM.md` | gateway IM 场景系统提示词 |
| `prompt-includes.json` | 系统提示注入清单 |
| `robot-context.md` | 机器人上下文（gateway 每次启动写） |
| `.cornfield/skills/` | 该 agent 专属技能 |

### 2.1 技能面（100 个用户级 + 每账号专属 + IM picker）

- 用户级 `~/.cornfield/agent/skills/` 100 个（脑库/诊断/研究/ingest/report/dws/skill 治理/review/UI/访谈/浏览器/cron 等系）
- 每账号 `.cornfield/skills/` 专属（如 mcode: lint 系）
- gateway IM side：`/skills` 列表 + `/skill <name>` 选用注入（30min TTL）
- 过滤链：includeSkills / ignoredSkills / disabledExtensions（用户级 + agentDir 级并集去重）
- 内核 settings schema：224+ 键 8 tab（appearance/model/interaction/context/editing/tools/tasks/providers）

## 3. 前端已实现盘点

### 3.1 web-app（React 18 + Vite，pi-wire WS 连 `cornfield serve --port 7891`）

| 路由 | 功能 | 状态 |
|---|---|---|
| `/` Home / `/workspace` 会话工作台 | 首页 + 对话流式 + 注册表 | ✅ |
| `/agents` + `/agents/:id` | 列表 + 详情 7 tab | ✅ |
| `/records` `/voice` `/todo` `/models` `/insights` `/memory` | 记录/语音/Todo/模型市场/用量/记忆 | ✅ |
| `/tasks` 定时任务 | **壳页面**——但 wire 命令面已全（见 3.3），纯前端未接 | ⚠️ |
| `/skills` 技能 | get_skills 只读；启停 toggle 等协议 | ⚠️ 半 |
| `/settings` 设置 | 连接/MCP CRUD/会话行为/通知真功能；主题快捷键静态；**钉钉集成只读占位 disabled** | ⚠️ 部分 |

**AgentDetailView 7 tab**：Skills（真读 .omp/skills，toggle disabled）、钉钉（**只读**展示 robotName/status/appKey/robotCode/hideThinkingBlock/agentDir）、模型（真 set_model/set_thinking_level 三选）、工具开关（get_tool_switches + **set_config 真写该 agent config.yml**）、画像/文件/Prompts（只读，fs_read）。

### 3.2 desktop（Electron）与 editor-extension

desktop：sidecar 生命周期/托盘/工作目录/自动更新——**纯壳，无业务配置面**。editor-extension：`configs/` 空目录**未开工**。

### 3.3 wire 命令面现状（L1/L3 相关）

| 命令 | 现状 |
|---|---|
| `get_cron_tasks` / `get_cron_logs` / `cron_create` / `cron_update` / `cron_remove` / `cron_test_run` | **已实现**（wire-endpoint.ts:82-207）→ TasksView 壳的原因不是无命令，是前端未接 |
| `gateway_status` | 只读状态（网关级 + 账号 bridge 运行态） |
| `set_config` / `get_config` / `set_model` / `get_tool_switches` | **写 L2**（每账号 config.yml）✅ |
| **`set_gateway_account` / `reload` / 写 L1 的任何命令** | ❌ **不存在**——L1 配置唯一的动态入口是 `cornfield-gateway reload` CLI/SIGHUP |

## 4. 差距分析（按三层）

| # | 层 | 配置面 | Agent 侧 | wire 命令 | 前端 | 差距 |
|---|---|---|---|---|---|---|
| G1 | L1 | 账号凭证/启停/机器人名/agentDir | gateway.json accounts.* | ❌ | 钉钉 tab 只读 4 字段 | **无任何编辑/动态路径** |
| G2 | L1 | 工具黑名单 deniedTools（账号级） | 11 项 | ❌ | 无（只有内核 config.yml 开关） | **完全缺失**，两个面混同 |
| G3 | L1 | 会话策略 resetPolicy/idle/dailyReset | session.* | ❌ | 无（只有 autoCompaction/autoRetry） | 完全缺失 |
| G4 | L1 | cron 配置 tick/并发/heartbeat/deliveryMode | cron.* | ✅ 读+CRUD | /tasks 壳 | **前端未接现成命令** |
| G5 | L1 | agent 参数 timeout/longTask/崩溃恢复 | agent.* | ❌ | 无 | 完全缺失 |
| G6 | L2 | skill 启停/忽略 | disabledExtensions 两级并集 | ❌ 写 | toggle disabled | 缺写路径（set_skill_enabled） |
| G7 | L2 | 模型深度（roles/fallback/recommended/temperature） | modelRoles 等 | ✅ set_model 三选 | 只三选 | 缺 90% 模型配置面 |
| G8 | L2 | 内核 settings 其余 6 tab | schema 224+ 键 | ✅ set_config | ~10 项 | 内核 8 tab 覆盖 <15% |
| G9 | L2 | prompt/画像编辑 | 各 md | ✅ 只读 fs_read | 只读 | 缺写路径 |
| G10 | **L3** | **动态注册 / enable-disable / 热生效** | **reload() diff 计划现成** | ❌ | ❌ | **缺 write+trigger 入口——本次待办核心** |

覆盖度：L1 前端覆盖 ~0%（只读展示 4 字段，无写）；L2 ~15-20%；L3 机制在 gateway 侧现成、链路 100% 断在「无写命令 + 无 UI」。

## 5. 动态注册/启停：热生效闭环方案（本次待办核心）

**现状**：`Gateway.reload()` 已有完整 diff 计划（accountsToAdd/Remove/Update，enabled 变化 → remove+add，只重建受影响账号）；cron 有 enable/disable + engine.reload()。缺口 = **没有写 gateway.json 的 wire 命令、没有从进程内触发 reload 的入口、前端没有 UI**。

**最小闭环**（复用 reload，不重启）：
1. **wire 命令**（gateway 侧新增 2 个）：
   - `set_gateway_account { accountId, patch }` — 写 gateway.json 的 accounts.<id>（白名单字段：enabled/robotName/agentDir/deniedTools/hideThinkingBlock；appSecret 支持 `$ENV_VAR` 引用或掩码写回）
   - `reload_gateway` — 进程内调用现有 `Gateway.reload()`（或 set_gateway_account 后自动触发）
2. **CLI 等价**：`cornfield-gateway reload` 已存在；补 `cornfield-gateway account enable/disable <id>` 走同一路径（方便脚本/SSH 运维，无 UI 也能动）
3. **前端**：AgentDetail 钉钉 tab 从只读 → 可编辑（启停 toggle、robotName、deniedTools 多选、agentDir）；新增账号入口；改完一键「保存并生效」= set_gateway_account → reload
4. **status 反馈**：gateway_status 已有账号 bridge 运行态，前端保存后展示「已生效/桥接中/失败回滚」

**注册流程复用**：新账号写入 gateway.json → reload → `#addAccount` → `registerAccountAgent`（注册表）+ spawn bridge + 钉钉 WS 连接——全链路现成，无新机制。

## 6. 新增配置功能建议（配置面完整度优先）

### 6.1 热生效闭环（G10 + G1/G2 的写路径）——第一批

1. **set_gateway_account + reload_gateway wire 命令**（gateway 侧，改动小，复用 reload diff）
2. **钉钉 tab 编辑化**：启停/robotName/agentDir/deniedTools 可编辑，保存即热生效
3. **account enable/disable CLI 命令**：无 UI 场景（脚本/SSH）也能动态启停
4. 保存后状态反馈：gateway_status 账号 bridge 运行态 → 「已生效/桥接中/失败」

### 6.2 cron + skill 补齐（命令已现成，纯前端）——第一批尾/第二批

5. **TasksView 接现成命令**：cron_create/update/remove/test_run/get_cron_logs 全在，做任务增删改 + 执行日志 + test-run 按钮（低风险高价值，wire 面零改动）
6. **skill 启停写路径**：定 set_skill_enabled（复用 set_config disabledExtensions 落盘）→ Skills tab toggle 生效

### 6.3 配置面补全（L1 + L2 余项）——第二批

7. 会话策略设置区：resetPolicy 语义化 + idle/dailyReset 时钟（set_gateway_session）
8. agent 参数区：timeout/longTaskThreshold/progressPing/崩溃恢复（set_gateway_agent）
9. 模型深度：modelRoles 三角色/fallback/recommended/temperature（复用 set_config）
10. 生命周期页：会话策略可视化（gateway_status 已有账号态）

### 6.4 产品级新增能力——第三批

11. **配置可视化与验证**：优先级链（hideThinkingBlock 三级、disabledExtensions 两级）可视化 + 冲突提示 + 配置 diff/回滚/审计
12. **配置导入导出**：账号配置快照（appSecret `$VAR` 引用已支持），一键复制账号模板
13. **gateway doctor 前端化**：校验命令已存在，前端调起展示结果（配置校验/修复建议）

## 7. 验收建议

- 前端改 `enabled=false` → 保存 → 该账号钉钉断连、bridge 停止，**gateway 不重启**；改回 true → 恢复（gateway.status 账号态可观测）
- 新增账号写入 → reload → Agent 列表出现新 agent、钉钉机器人上线，无进程重启
- /tasks 可真实增删改 cron 任务并执行 test-run（wire 命令零改动）
- Skills tab toggle 实际启停 agent 技能并持久化
- 覆盖度指标：L1 从 ~0% → 写路径 ≥70%（G1–G5 落地）

## 8. 依赖关系

- G1/G2/G10：gateway 侧新增 2 个 wire 命令（set_gateway_account/reload_gateway）+ CLI account enable/disable——后端先行，前端依赖命令面
- G4：命令面已存在，**无后端依赖**，纯前端
- G6：需 set_skill_enabled 协议或复用 set_config
- G7–G9：命令面已存在（set_config/fs_read），纯前端