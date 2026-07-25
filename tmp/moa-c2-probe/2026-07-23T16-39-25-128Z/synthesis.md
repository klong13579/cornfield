# WorkBuddy vs OpenClaw — 合并分析

---

## 合并方案

### 产品定位

| | WorkBuddy | OpenClaw |
|---|---|---|
| **品类** | 腾讯云商业 AI 办公代理（SaaS） | MIT 开源个人 AI 助手（自托管） |
| **发布时间** | 2026.5 全球发布，前身 CodeBuddy | 成熟开源项目，383K+ GitHub Stars |
| **目标场景** | 办公自动化：写周报、查代码、回消息、工作流编排 | 多渠道 AI 助手：钉钉/飞书/企微/WhatsApp 等 20+ 渠道的统一 agent 入口 |
| **部署模式** | SaaS + 企业私有化部署（细节未验证） | 自托管 Gateway + Agent Runtime，跑在自有服务器 |
| **数据主权** | 声称"数据驻留"，技术实现无 SLA | 数据物理在自有基础设施，天然满足境内驻留 |
| **商业模式** | 个人版免费，企业版定价不透明 | MIT 免费，模型调用直付 Provider |

### 对米克原子的关键维度

| 维度 | WorkBuddy | OpenClaw | 判断 |
|---|---|---|---|
| **钉钉接入** | ❓ 未确认（文档站点不可达） | ✅ OMP 已验证（`@dingtalk-real-ai/dingtalk-connector@0.8.23`） | 钉钉是主渠道，WorkBuddy 不支持则直接出局 |
| **数据境内驻留** | ❓ 营销声明，无 SLA/技术文档支撑 | ✅ 自托管天然满足 | 硬约束，WorkBuddy 需书面确认 |
| **多 Agent 隔离** | Agent Teams + Dynamic Workflows（细节未知） | per-agent 独立 agentDir/SQLite/auth，按 channel/account 路由 | 对应"每个业务领域构建专属 agent" |
| **LLM 自由度** | 推测绑定腾讯混元生态 | 35+ Provider（Anthropic/OpenAI/Google/Ollama/vLLM） | 模型选择自主权 |
| **运维门槛** | 若 SaaS 则低；私有化未验证 | 需自建运维能力（Gateway 管理、版本升级） | OMP 已在跑，运维路径已知 |
| **成本可预测** | 企业版定价不透明，API 调用可能加价 | 免费 + Provider 直接计费，TCO 透明 | |
| **中文/本土化** | 腾讯产品，原生中文，企业背书 | 英文社区为主，钉钉 connector 为社区实现 | |
| **生态锁定** | 深度绑定腾讯云，迁移成本高 | 技术栈开放，Provider 可替换 | |

### OMP 与两者的关系

- **OMP 是 OpenClaw 的技术超集**：dingtalk-connector、Gateway 设计、Card v3 schema 均源自 OpenClaw，OMP 在此基础上增加了 self-evolution、Handlebars prompt assembly、TUI、MECE 6 层 agent 设计。切回纯 OpenClaw 是倒退。
- **WorkBuddy 与 OMP 代码零引用**，无技术关联。

---

## 建议

**结论：不迁移。OMP 继续保持，WorkBuddy 信息不足无法评估，OpenClaw 作为上游技术参考持续跟踪。**

**短期（当前）**：
1. OMP 已是 OpenClaw 的超集，不需要降级
2. 补 OMP 运维短板——指定运维 owner，负责 Gateway crash、session 恢复、dingtalk-connector 升级兼容

**中期（1-3 月）**：
1. 厘清硬件研发工具缺口——四组 leader 各提 3 项"最想让 agent 做的事"
2. 异步确认 WorkBuddy 三个致命未知：钉钉支持、数据驻留 SLA（书面）、企业版 50 人定价
3. 评估 dingtalk-connector 稳定性（消息丢失率、card 渲染错误率），决定是否 fork 自维护

**长期**：
- OpenClaw 持续跟踪安全模型（DM pairing、Docker sandbox），评估 backport 到 OMP
- WorkBuddy 在三个未知解了之后重新评估——不支持钉钉则直接排除

---

## 各 Worker 贡献

**`grounded`（骨干）**：完整的对比框架、OMP 与 OpenClaw 的技术渊源证据链（bun.lock 依赖、Gateway 设计文档）、WorkBuddy 三个致命未知的识别、数据主权/钉钉支持/多 Agent 隔离的关键维度分析。这是唯一有硬证据支撑的 worker。

**`divergent`**：正确指出"两者不在同一赛道"的基本判断，但将 OpenClaw 误判为机器人手臂控制平台（混淆了 RobotBase/robotclaw 仓库），导致对比失去实际意义。

**`critical`**：同样将 OpenClaw 误判为机器人操作框架，基于此的"暂不相关"结论不正确。其风险分析框架（供应商锁定、成本不透明）仍可吸收。

---

## 设计决策

### 解决的核心冲突：OpenClaw 到底是什么？

`divergent` 和 `critical` 将 OpenClaw 描述为机器人手臂控制平台（具身智能），`grounded` 将其描述为个人 AI 助手。两者不可调和。

**裁定：`grounded` 正确。**

证据链：
1. **硬证据**：`bun.lock` 中 `@dingtalk-real-ai/dingtalk-connector@0.8.23` 的 `peerDependencies: openclaw>=2026.4.9`——钉钉连接器作为 OpenClaw 的 peer dependency，证明 OpenClaw 是 AI 助手平台而非机器人控制器
2. **架构一致性**：OMP Gateway 设计文档明确记载参考 OpenClaw 的 accounts map、conversationId 隔离、per-agent 目录隔离——这些是消息渠道 agent 的架构模式
3. **文档内容**：docs.openclaw.ai 描述的是 Multi-Agent Routing、35+ Provider、20+ 消息渠道——与机器人控制无关
4. **GitHub 规模**：383K Stars 对应通用 AI 助手平台，不可能是小众机器人控制框架

`divergent`/`critical` 的混淆来源：`RobotBase/robotclaw`（另一个项目）和 openclawembodiment.com（可能是 OpenClaw 的具身智能扩展方向，但非核心功能）。

### WorkBuddy 评估标准

`grounded` worker 提出的三个致命未知（钉钉支持、数据驻留 SLA、企业版定价）作为评估 WorkBuddy 的前置条件——这三个不确认，WorkBuddy 不进入选型。这个标准合理，直接采用。

---

## 拒绝或推迟的想法

- **"两者不在同一赛道，直接对比无意义"**（divergent）：在错误的产品理解下得出，拒绝。正确定位下（AI 办公助手 vs AI 办公助手），对比维度丰富且有决策价值。
- **"OMP 迁移到 WorkBuddy"**：信息不足，推迟。WorkBuddy 三个致命未知解决前不做迁移评估。
- **"OMP 迁移到纯 OpenClaw"**：拒绝。OMP 已是 OpenClaw 超集，降级无意义。
- **"短期引入 OpenClaw 具身智能能力"**（critical）：基于错误产品判断，且与当前扫地机器人产品不匹配，拒绝。

---

## 风险与前置条件

| 风险 | 等级 | 缓解 |
|---|---|---|
| OMP 无明确运维 owner，Gateway 故障无人兜底 | 高 | 软件系统组指定一人负责 |
| dingtalk-connector 为社区实现，中文场景稳定性未知 | 中 | 压测后决定是否 fork 自维护 |
| WorkBuddy 三个未知长期无解，评估搁置 | 中 | 异步推进，不阻塞 OMP 迭代 |
| 硬件研发工具链（ROS/BOM/CAD）OMP 当前未覆盖 | 低（当前阶段不急迫） | 四组 leader 提需求后再评估 |

---

## 下一步

1. 确认 OMP 运维 owner（软件系统组指定一人）
2. 对 `@dingtalk-real-ai/dingtalk-connector@0.8.23` 做稳定性压测
3. 异步联系腾讯云确认 WorkBuddy 钉钉支持 + 数据驻留 SLA + 企业版定价
4. 四组 leader 提 agent 需求清单，识别硬件工具链缺口

---

## 待验证假设

| 假设 | 置信度 | 说明 |
|---|---|---|
| OMP 将继续作为 agent 基础设施，不计划废弃 | **高** | 已投入定制开发，用户未提废弃意图 |
| 软件系统组 12-13 人中至少一人能处理 Gateway 运维 | **中** | 未指定 OMP owner，需确认 |
| 硬件研发工具链当前阶段不急迫 | **中** | 基于研发阶段推断，未与用户确认 |
| WorkBuddy 三个致命未知短期内无法获得明确答案 | **中** | workbuddy.ai 持续超时 + 腾讯云销售响应速度未知 |
| 本次对比意图为评估 OMP 迁移/替换可行性 | **中** | 已知输入标注为 user 但采集阶段可能为 LLM 推断 |