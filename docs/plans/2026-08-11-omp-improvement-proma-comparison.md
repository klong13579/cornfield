# omp 改进计划（源自 Proma 对比）

> 状态：草案 · 创建：2026-08-11 · 依据：`docs/` 外部分析（Proma 深度调研，2026-08）
> 原则：**抄设计，不抄代码**。Proma 是 AGPL-3.0，omp 是 MIT——任何实现都按 omp 现有架构自研，不搬 Proma 源码。
> 优先级说明：P0 = 直接影响"数字员工"无人值守可用性；P1 = 治理/体验补齐；P2 = 探索性/战略层。

---

## 总览

| # | 改进项 | 优先级 | 涉及模块 | 一句话 |
|---|---|---|---|---|
| 1 | 权限模型（四模式 + 白名单） | P0 | coding-agent / pi-agent-core | 让 agent 在"无人值守"和"用户在场"之间可切换 |
| 2 | 自动化自迭代（notes.md + 任务改自己） | P0 | omp-gateway scheduler | 定时任务从"定时启动的简短上下文"升级为"能自我优化的数字员工" |
| 3 | 六层知识边界 | P1 | memories / self-evolution / prompts | 项目地图/工作区规则/协作记忆/Skills/工作台/Context 分开管 |
| 4 | 记忆治理（邀请制 + 复查节奏） | P1 | self-evolution / memories | 记忆只沉淀已验证知识，不自动扫描、不模糊累积 |
| 5 | 受管浏览器 | P2 | coding-agent tools | 内置 CDP 受管浏览器 + 用户/Agent tab 隔离 |
| 6 | 协作真子会话（对抗式审查） | P2 | task/dag + cognitive-coordination | 落地"对抗式审查"编排模式（swarm-extension 已退役，DAG 原语保留在 task/dag.ts） |
| 7 | 产品化/商业形态 | P2 | 战略层（非代码） | 评估开源 + 商业双轨 |

---

## 1. 权限模型（P0）

**现状**：omp 有 approval 开关（`--approve`/`--no-approve`）与计划模式，粒度粗；gateway 无人值守场景要么全放行要么处处卡人。config 中 `ask.enabled` 默认关闭。

**差距（Proma 做法）**：四模式（auto / plan / bypassPermissions，运行时动态切换）+ 会话级白名单（"始终允许"）+ 只读工具/只读 Bash 命令本地 classifier 自动放行 + worker（子 Agent）调用自动批准 + **bypass 模式下破坏性操作仍保留单次用户确认**（allowAlways:false）。

**目标行为**：
- auto 模式：只读操作不打扰用户；写操作走确认；确认时可选"始终允许"（进会话白名单）
- bypass 模式：全自动，但 Bash 危险命令结构（管道/重定向/rm -rf 模式）仍触发单次确认
- 计划模式：只调研不执行，计划确认后退出
- gateway 侧：每个 agent 可配默认权限模式，DingTalk 卡片承载确认请求

**方案**（自研，参考设计）：
1. `pi-agent-core` 工具执行前插入 `canUseTool` 钩子（现有 tool 执行链上扩展）
2. 新增 `PermissionService`：pending 请求 Promise+Map、会话白名单、只读 classifier（`SAFE_TOOLS` + Bash 命令白/黑名单）
3. 权限模式成为 session 级状态，`/permission` 命令运行中切换
4. gateway：权限请求 → DingTalk 交互卡片（确认/拒绝/始终允许）

**涉及模块**：`pi-agent-core`（钩子）、`coding-agent`（命令/UI）、`omp-gateway`（卡片交互）
**风险/工作量**：中。核心是 hook 位置与 gateway 回调通道；只读 classifier 的词表要反复校准避免误伤。
**验收**：无人值守 cron 任务在 auto 模式下不被只读操作打断；bypass 下 `rm -rf` 必须弹确认。

---

## 2. 自动化自迭代（P0）

**现状**：gateway scheduler 支持 cron/interval/one-shot + 测试注入 + 执行日志（`scheduler/logs/by-task/<slug>/`）。但每个任务只是"到点跑一段 prompt"，跑完即散，无跨运行记忆、无自我优化。

**差距（Proma 做法）**：
- 跨运行记忆：约定 `automation/<task-slug>/notes.md` 滚动维护——每次运行先读、结束后顶部追加新发现、**顺手清理过时条目**（防止累积成上下文负担）
- 自迭代：连续失败/价值低 → 读笔记和运行记录 → 修改自身任务（prompt/频率/暂停）
- 会话模式：`daily`（同日复用子会话、跨日新建，防 token 累积）vs `reuse`（长期跨日记忆，明示成本）

**目标行为**：
- 任务运行前自动加载该任务的 notes 文件，结束后回写
- 连续失败 N 次（建议 2）后暂停并通知 owner，附失败原因
- 任务可修改自身（prompt/频率），修改需记录审计

**方案**：
1. scheduler 任务模型加 `sessionMode`（daily/reuse）与 `notesPath` 字段
2. 运行注入：prompt 前读 notes，结束后写 notes（走现有 session 持久化）
3. 失败监控升级：现有 cron 失败记录 → 连续失败计数 → 自动暂停 + 通知
4. 运行记录暴露给 agent（`cron status` 工具已有雏形，补"读取历史运行"）

**涉及模块**：`omp-gateway/src/scheduler`
**风险/工作量**：低-中。不动调度核心，加字段与注入。
**验收**：同一 cron 任务连续两轮运行能读到上一轮笔记；连续 2 次失败自动暂停并通知。

---

## 3. 六层知识边界（P1）

**现状**：omp 有 AGENTS.md 项目指令、memories（memory 协议）、skills、self-evolution（evolution.db）。但层次未显式声明，边界靠 prompt 约定，agent 易越界（如把会话笔记写进长期记忆）。

**差距（Proma 做法）**：system prompt 内显式六层表，每层有路径、维护方式、内容边界：
项目地图（项目根 AGENTS.md）/ 工作区规则（Proma 工作区 AGENTS.md）/ 协作记忆（memory/，MEDIA.md 只作索引）/ Skills（skills/）/ 会话工作台（会话目录，可读写不升级）/ 项目 Context（跨会话资料）。

**目标行为**：
- 每类知识有明确归属路径与写入规则
- 会话工作台产出**不自动升级**为长期知识；升级需用户确认或 self-evolution 审核
- 禁止 agent 读写非归属目录（如 `.claude/memory/`）

**方案**：
1. prompt 模板加"知识边界"章节（静态 .md 模板 + Handlebars 动态路径注入，遵守 prompts 规范）
2. `memories/` 与 self-evolution 落库路径对齐该分层
3. self-evolution 的 nudge/注入逻辑按层过滤，防止跨层污染

**涉及模块**：`prompts/`、`memories/`、`self-evolution`
**风险/工作量**：低。主要是 prompt 与写入策略的约束，不重构存储。
**验收**：长期记忆文件里不出现会话级临时笔记；AGENTS.md 不被 agent 擅自整体重写。

---

## 4. 记忆治理（P1）

**现状**：self-evolution 会自动抽取会话 learnings 入库（有 admission 审核），但节奏与用户参与度弱；记忆更新无用户可见的"复查邀请"。

**差距（Proma 做法）**：3 天内部节奏懒检查 + **只邀请用户复查，绝不自动扫描历史**；用户可选"本周期跳过"；基于明确证据的增量可写，删除/覆盖/冲突/敏感必须先确认。

**目标行为**：
- 记忆写入分级：已验证最小增量直接写；删除/大段覆盖/冲突/敏感信息先确认
- 定期（如每周）向用户提示"会话中是否有值得沉淀的协作知识"，不自动扫描
- 时间敏感记忆标注时间戳，不以文件 mtime 替代

**方案**：
1. self-evolution admission 升级为两级：自动入库（已验证）+ 待确认（冲突/敏感）
2. 新增"记忆复查邀请"触发（可挂在会话结束或 gateway 周报）
3. 记忆条目 schema 加 `timestamp` 语义字段

**涉及模块**：`self-evolution`、`memories/`
**风险/工作量**：中。涉及 evolution.db schema 与 admission 逻辑。
**验收**：敏感信息（密钥/token）永不自动入库；冲突记忆在不打扰用户的前提下不静默覆盖。

---

## 5. 受管浏览器（P2）

**现状**：无内置浏览器。有 chrome-devtools MCP 与 puppeteer 工具可用，但无会话级受管浏览器、无用户/Agent tab 隔离、无操作轨迹账本。

**差距（Proma 做法）**：CDP 驱动受管浏览器——ref+generation 失效模型、用户 tab 与 Agent 工作 tab 分离（用户切页不影响 Agent 目标）、用户浏览上下文只注入标题+URL 不进正文、风险告知首启、本地预览只允许授权目录、页面内容视为不可信输入。

**目标行为**（探索性）：Agent 需要网页操作时，用内置受管浏览器而非裸 puppeteer；操作轨迹可回放。

**方案**：评估在现有 puppeteer 工具上叠加"受管会话"层（tab 管理、ref 失效、用户上下文注入），或接入现有 chrome-devtools MCP 做会话隔离。
**涉及模块**：`coding-agent/src/tools/`
**风险/工作量**：高。浏览器自动化是重投入，先做 POC。
**验收**：POC 里 Agent 能完成"打开页面→Observe→Click→填表"全流程且 ref 失效处理正确。

---

## 6. 协作真子会话（P2）

**现状**：多 agent 编排原语在 `coding-agent/src/task/`（runSubprocess + dag.ts DAG 波浪，原 swarm-extension 已退役）、cognitive-coordination（L4 Synapse，WIP）、moa-extension（多轮 MOA）。无"对抗式审查"这种落地模式。

**差距（Proma 做法）**：collaboration 真子会话——`delegate_agent`/批量、`wait_for_delegations`（all/any+minCompleted 部分收敛）、**对抗式**（子 Agent 独立审查不修改，父 Agent 逐条评估）、**多样性探索**（多方向并行调研），上限 50、**子会话禁递归**。

**目标行为**：在 swarm-extension 上落地"对抗式审查"模式（父实现 → 独立子会话审查 → 父逐条采纳）。

**方案**：在 task 体系加 delegation 原语（wait 模式、结果收敛、递归禁令），复用 cognitive-coordination 的上下文隔离。
**涉及模块**：`task/`、`cognitive-coordination`
**风险/工作量**：中-高。已有基建，缺的是"对抗式"编排协议。
**验收**：一个实现任务跑通"实现→审查→修订"闭环，审查子会话不写文件。

---

## 7. 产品化/商业形态（P2，战略层）

**现状**：omp MIT 开源，无商业形态；gateway 是内部基建。

**参考（Proma 模式）**：开源核心（AGPL）+ 商业云（内置渠道、团队额度、组织级 Skills 分发）+ 企业授权。omp 是 MIT，自由度更高——可做"开源引擎 + 托管服务 + 企业版"。

**目标行为**：不急于变现；先让改进 1-4 落地、gateway 跑稳，再评估对内输出（米克原子内部 50 人团队规模化）vs 对外产品化。
**风险**：商业化是战略决策，不在本期代码范围。

---

## 明确不做（避免过度对标）

- **Chat GUI 形态**：omp 是 CLI/TUI/gateway 定位，Proma 的 Electron Chat UI 不搬
- **商业云渠道**：不仿 Proma 自建模型中转
- **协作上限 50 个**：omp 的 swarm 场景按实际需求收敛
- **AGPL 代码**：任何实现自研，不引用 Proma 源码

---

## 执行顺序建议

1. **Phase 1（先做）**：#2 自动化自迭代（低风险、gateway 直接受益）→ #1 权限模型（无人值守刚需）
2. **Phase 2**：#3 六层知识边界 + #4 记忆治理（prompt/存储层，互相关联，一起做）
3. **Phase 3（探索）**：#5 受管浏览器 POC → #6 对抗式协作
4. **Phase 4（战略）**：#7 产品化评估（CEO 决策，不进代码排期）

每项落地时：先跑 `impact` 分析受影响符号 → 改 → 跑对应单测 → 按 release 流程记 CHANGELOG。