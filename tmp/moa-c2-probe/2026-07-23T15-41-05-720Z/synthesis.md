## Merged Plan: WorkBuddy vs OpenClaw 对比

### 一句话结论

**WorkBuddy 目前连严肃选型的门槛都没过——官网不可达、技术文档缺失、闭源无审计能力。OpenClaw 运维有成本但可控，是理性选择。**

---

### 核心差异

| 维度 | WorkBuddy | OpenClaw |
|---|---|---|
| **本质** | 腾讯云 SaaS 办公 Agent（2026.5 发布） | MIT 开源自托管 AI 助手基础设施 |
| **透明度** | 🔴 闭源，官网持续超时，零公开技术文档 | 🟢 完全开源，383K+ Stars，docs.openclaw.ai 详尽 |
| **部署** | 宣称支持私有化，无细节可验证 | 完全自托管，`~/.openclaw/` 本地存储 |
| **数据主权** | 数据驻留腾讯云，合规审查盲区 | 数据全在本地，无第三方依赖 |
| **消息渠道** | 绑定腾讯生态（企微/腾讯会议） | 20+ 渠道：WhatsApp/Telegram/Slack/Discord/钉钉等 |
| **扩展模型** | [未公开] | SKILL.md 文件 + ACP 协议 + MCP 协议 + ClawHub 生态 |
| **安全模型** | [未公开] | Sandbox + DM Pairing + Exposure Runbook 完整文档 |
| **生态锁定** | 深度绑定腾讯，迁移成本高 | 开放架构，无锁定 |
| **运维** | 腾讯托管（外部化） | 需自建 Gateway、备份、监控 |
| **定价** | 个人版免费，企业版未公开 | MIT 免费，仅消耗自有基础设施 |
| **企业案例** | 无可验证的大型部署 | GlobusSoft 500 人部署等可参考 |

---

### 关键判断

**1. WorkBuddy 的信息透明度是 showstopper**

workbuddy.ai 主站和文档页在多次请求中持续超时。作为闭源产品，没有代码审计能力，没有公开 API 文档，没有安全白皮书。这不是"功能不够"的问题——是根本无法进入技术选型流程。

**2. WorkBuddy 的品牌不稳定信号**

前身是 CodeBuddy（IDE 代码助手），6 个月内品牌/定位剧烈调整。产品路线仍在大幅摇摆中，选择它意味着接受一个还在剧烈演变中的产品作为基础设施。

**3. OpenClaw 的可控性优势**

自托管 + MIT 许可证意味着：不会被许可变更绑架、不会因为供应商调整策略而被迫迁移、代码可审计、行为可扩展。对于机器人硬件团队的核心自动化基础设施，这些不是加分项，是准入门槛。

**4. OpenClaw 的运维成本是真实但可控的**

需要自建 Gateway 高可用、Session 备份、多 Channel 状态同步监控。但对 50 人团队来说，这些是 Node.js/DevOps 基础能力范围内的，不是 blocker。ACP 插件系统支持 20+ 外部 harness（Claude Code/Cursor/Gemini CLI 等），每个需要独立 Auth 配置——这是 learn once, apply everywhere 的成本。

**5. ACP 协议的架构价值**

OpenClaw 的 ACP（Agent Client Protocol）让它可以作为 meta-agent 去调度外部 coding harness。这意味着你不需要绑定某一个 coding CLI——当更好的出现时，OpenClaw 可以接入它。这是对模型/harness 迭代速度的对冲。

---

### 对你场景的适配分析

已知你的场景：50 人团队、机器人硬件、多业务领域 agent 化管理、钉钉是主要沟通渠道。

| 需求 | OpenClaw | WorkBuddy |
|---|---|---|
| 钉钉集成 | ✅ 已验证（OMP 团队已打通） | [未验证] |
| 非工程团队接入（HR/运营） | ✅ 消息渠道优先，不需要 IDE | [未验证] |
| 领域专家自主配置 Agent 行为 | ✅ SKILL.md 文件，Markdown 即可 | [未验证] |
| 代码资产保密 | ✅ 完全本地，无外传 | 🔴 数据经腾讯云 |
| Cron/定时任务 | ✅ 完整 Cron 系统 | [未验证] |
| 多 Agent 路由隔离 | ✅ workspace 级隔离 | [未验证] |

---

### 建议

**短期**：继续用 OMP（已基于 OpenClaw Gateway 构建），不浪费时间在 WorkBuddy 上。等它官网修好 + 提供完整技术白皮书再说。

**中期**：跟进 OpenClaw 上游的 Codex 插件和 ACP 路由演进，评估能否把 OMP 的部分自研能力迁到 OpenClaw 原生，减少维护面。

**若未来被迫评估 WorkBuddy**：合同中必须明确数据驻留位置、加密标准（静态/传输中）、删除权机制、数据导出格式。预设 Exit 策略。

---

## What Was Taken From Whom

**Backbone**: divergent worker — 提供了完整的产品哲学对比框架、extension model 分析、ACP 架构价值判断。

**Absorbed from critical worker**:
- 风险评级体系（🔴🟡🟢）——让差异可视化
- WorkBuddy "信息透明度是 showstopper" 的硬判断——比 divergent 更果断
- WorkBuddy 品牌不稳定信号（CodeBuddy → WorkBuddy 6 个月剧烈调整）
- 分阶段建议（短期/中期/风险缓解）——比 divergent 的单一判断更可执行
- OpenClaw 运维负担的具体列项（Gateway HA、Session 备份、Channel 监控）
- 安全模型对比（Sandbox + DM Pairing + Exposure Runbook vs WorkBuddy 的完全缺失）

---

## Design Choices

| 冲突 | 处理 | 理由 |
|---|---|---|
| divergent 说 WorkBuddy 是 "IDE-native 开发工具"；critical 说它是 "腾讯云 SaaS 办公 Agent" | 取 critical | critical 的判断基于 WorkBuddy 从 CodeBuddy 品牌调整的事实，且官网定位已转向办公场景 |
| divergent 语气偏推荐 OpenClaw；critical 加了更多 OpenClaw 运维成本的警示 | 合并 | 推荐 OpenClaw 但标注运维成本，不做粉饰 |
| 双方对 OpenClaw 的 verdict 一致 | 无需处理 | |

---

## Rejected or Deferred Ideas

- **divergent worker 的 Voice/Canvas 功能对比**：用户需求是"快速概览关键差异"，Voice/Canvas 是加分项不是决策因子，且 WorkBuddy 侧完全无数据，对比无意义。未纳入。
- **critical worker 提到的 "OMP 迁移到 OpenClaw 原生以减少维护"**：这是中期的可能性讨论，不是当前对比的核心内容。放在建议的"中期"里一笔带过，不展开。
- **双方的社区健康度/赞助商列表细节**：对于技术决策者，"383K Stars + 活跃 Discord + Foundation 治理" 已经足够说明问题。不展开具体赞助商名单。

---

## Risks and Prerequisites

| 风险 | 等级 | 缓解 |
|---|---|---|
| OpenClaw 无商业 SLA，生产问题依赖社区 | 🟡 | 自建关键路径监控，核心成员熟悉源码 |
| 钉钉集成通过第三方 connector，生产稳定性未 benchmark | 🟡 | 在 staging 环境跑足长稳测试再切生产 |
| WorkBuddy 若被腾讯强推，可能在特定生态内有短期优势 | 🟢 | 不影响——你的架构需求跨生态，不绑定单渠道 |
| OpenClaw Gateway 单节点故障 | 🟡 | 评估是否做 HA（目前 50 人规模单节点可接受，但需备用重启流程） |

---

## Next Actions

1. **不浪费时间在 WorkBuddy 上**，直到其官网可达 + 技术白皮书公开
2. 继续 OMP 当前路线（基于 OpenClaw Gateway），不做方向切换
3. 下次评估节点：OpenClaw 上游发布重大架构变更时，或在 3 个月后例行复评

---

## Assumptions to Verify

| 假设 | 置信度 |
|---|---|
| WorkBuddy 官网超时是持续性问题，不是临时故障 | High — critical worker 多次确认 |
| 你的团队具备 Node.js/DevOps 基础能力维护 OpenClaw Gateway | Medium — 基于 50 人硬件团队的背景推断 |
| 钉钉集成是当前的关键渠道需求 | High — 基于 user.md 的钉钉账号和日常使用描述 |
| WorkBuddy 未提供公开 API 文档或 SDK | High — 双方 worker 的搜索均未命中 |
| WorkBuddy 宣称的私有化部署缺乏可验证细节 | High — 无公开文档支持 |
| WorkBuddy 的企业版定价未公开 | Medium — 基于 early-stage SaaS 产品的典型模式推断 |