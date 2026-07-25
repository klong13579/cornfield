# Cursor vs Claude Code：会话压缩策略对比

## 核心结论

两款工具在会话压缩上的根本分歧是**架构归属**——压缩逻辑放在服务端还是客户端。这一差异决定了触发机制、用户可控性、摘要策略、以及失败模式。

|维度|Claude Code|Cursor|
|---|---|---|
|**压缩归属**|客户端（Agent 自行管理全流程）|服务端（客户端仅发 `SummarizeAction` 空信令）|
|**触发机制**|手动 `/compact` + 自动（token 超阈值）+ overflow 恢复 + idle 空闲，4 条路径|服务端黑盒判定，客户端不可见|
|**压缩策略**|REPLACE 导向：每次生成新摘要**替换**旧摘要，硬上限 6,000-8,000 字符，信息密度不随 session 膨胀|APPEND 导向：每次压缩追加新 `ConversationSummaryArchive` 到数组，形成摘要链|
|**cut-point 精度**|按 token 预算逆向累积计算，支持 split-turn（一个 turn 中间切开），合法 cut-point 排除 `toolResult`|按消息条数 `window_tail`（uint32），粗粒度|
|**原始消息保留**|不保留——`CompactionEntry` 只存摘要，原始消息被丢弃|保留——`ConversationSummaryArchive.summarized_messages` 存原始消息序列化副本|
|**用户可见性**|高：显示 "Compacted" 标签，用户可设阈值/策略/hook 接管|低：对用户黑盒，不知何时压、压了什么、质量如何|
|**扩展性**|`session_before_compact` / `session.compacting` / `session_compact` 三个 hook，可取消/接管/定制|无（客户端无法干预策略、模型、格式）|
|**历史可恢复性**|弱——压缩不可逆，一次丢失即永久|中等——保留了原始消息序列化，服务端理论可还原|
|**失败模式**|静默信息丢失：摘要可能错判细节重要性，产生"幽灵决策污染"|上下文膨胀：APPEND 链式叠加可能导致摘要信息随 session 线性增长|

## 技术架构差异

### Claude Code：客户端REPLACE压缩

压缩 pipeline（`packages/coding-agent/src/session/compaction/compaction.ts`，~1,400 行）：

1. **`prepareCompaction`**：找到上次 `CompactionEntry` 位置作边界起点 → 取最后一次 assistant 消息实际 token 用量 → 计算 `keepRecentTokens`（默认 20K，按 tokenizer 膨胀比缩放）→ 调用 `findCutPoint()` 从最新向旧方向逆向累加 token，在合法 cut-point 处切分
2. **Cut-point 智能回溯**：合法点排除 `toolResult`（工具结果必须紧跟调用）；若切分点前有 `model_change`/`thinking_level_change` 等元数据条目，拉入保留区；检测 split-turn（切分点不是 user 消息时向前找 turn-start），标记并触发双摘要合并
3. **摘要生成**：split-turn → 并行生成 history summary + turn-prefix summary 后合并；正常 → 首次用 `compaction-summary.md`，迭代用 `compaction-update-summary.md`（**REPLACE 导向**：必须输出单一连贯叙述，不得拼接新旧摘要，6,000-8,000 字符硬上限）；附加文件操作标签（`<read-files>` / `<modified-files>`）；远程路径优先走 OpenAI `/responses/compact` 原生端点，失败 fallback 本地 LLM
4. **上下文重建**：找到 active path 上最新 `CompactionEntry` → 摘要转为 `compactionSummary` role 消息 → 从 `firstKeptEntryId` 到压缩点的条目重新纳入 → 后续条目追加 → 通过 `compaction-summary-context.md` 模板注入 LLM

### Cursor：服务端APPEND压缩

协议层（`packages/ai/src/providers/cursor/proto/agent.proto`）：

1. **信令**：`SummarizeAction` 为零字段 protobuf 消息——客户端仅通知服务端"请压缩"，无参数（保留量、摘要长度、策略由服务端全权决定）
2. **存储**：`ConversationSummaryArchive` 含四字段——`summarized_messages`（原始消息序列化）、`summary`（LLM 摘要）、`window_tail`（保留尾部消息数）、`summary_message`（注入对话的格式化摘要）
3. **链式归档**：`ConversationState.summary_archives` 是数组而非单值，每次压缩追加新 archive，形成层叠摘要链——不替换旧摘要

**关键差异**：Cursor 的消息条数切分（`window_tail`）比 Claude Code 的 token 预算切分（`keepRecentTokens` + 逆向累积）更粗粒度但更简单。Cursor 的原始消息保留 vs Claude Code 的丢弃，使得 Cursor 理论可回溯、Claude Code 不可逆。

## 三种失败模式

**Claude Code 的"幽灵决策污染"**：摘要错误地保留了对话早期一个已被后续讨论推翻的决策（如 "assistant proposed approach Y"），后续 agent 将其误认为有效决策依据——用户不知道这是摘要失真，以为有历史支撑。比彻底丢失上下文更难排查。

**Cursor 的"摘要链膨胀"**：APPEND 模式下，随着 session 轮次增加，`summary_archives` 数组持续增长。若无服务端二次压缩（这一点不确定），摘要信息量随 session 线性膨胀，token 效率持续恶化。

**共同的"长时依赖断裂"**：对需要追溯 session 早期决策的任务（如重构中回退到之前的备选方案），压缩可能导致决策依据丢失，模型做出与初衷相悖的选择。

## 对你的场景意味着什么

你的 agent team 管理公司业务，场景是**长周期、多领域、跨 session**——HR agent 跟踪招聘数十轮，架构 agent 在一次 session 内 review 多模块。

Claude Code 的 REPLACE 压缩在这种场景下的优点是信息密度恒定（不随 session 膨胀），缺点是压缩不可逆——一旦摘要丢失了"候选人 A 薪资期望 45K"这个细节，后续多轮基于它的讨论就建立在了错误前提上。

Cursor 的 APPEND + 原始消息保留在理论上更安全（可回溯），但多 archive 链式叠加的 token 效率未知（服务端黑盒）。

**OMP 自身走的是 Claude Code 的客户端 REPLACE 路线**（`compaction.ts` 实现）。如果要对接 Cursor 协议（OMP 已有 `packages/ai/src/providers/cursor/`），三处需要适配：`CompactionEntry` 不保留原始消息（需新增归档逻辑）、`window_tail`（消息条数）⇔ `keepRecentTokens`（token 数）的语义转换、APPEND ⇔ REPLACE 的策略差异需要 `CompactionStrategy` 抽象层统一。

---

## 各 Worker 贡献

**grounded** 作 backbone（有本地源码证据，架构细节最权威）：
- Claude Code 完整 pipeline（`compaction.ts`）：prepareCompaction → findCutPoint → compact → buildSessionContext
- Cursor 协议定义（`agent.proto`）：`SummarizeAction` 空消息、`ConversationSummaryArchive` 四字段、`summary_archives` 链式叠加
- REPLACE vs APPEND 的深层差异
- OMP 自身的 compaction 实现与双协议兼容建议

**divergent** 吸收的：
- "幽灵决策污染"的风险命名和场景化描述
- 压缩时机由谁决策的哲学框架
- 用户场景映射（agent team 管理 vs 精确 bug 复盘的场景差异）
- 决策链连续性 vs 原始日志保真度的取舍权衡

**critical** 吸收的：
- 静默信息丢失的不可逆性及其调试困难
- 上下文膨胀导致注意力稀释的渐进式衰减
- 混合策略（自动摘要 + 用户确认）的缺失及原因推测
- 失败模式的可诊断性差异

## 设计选择

1. **纠正 Claude Code 是"分页"的错误描述**：divergent worker 说 Claude Code 用确定性分页（按 ~200 条消息硬切页），但 grounded worker 的本地源码（`compaction.ts`）证实是智能摘要压缩（REPLACE 模式），不是简单分页截断。两者描述的是不同机制——分页可能是旧版或不同产品线；当前 Claude Code 的 compaction 是语义摘要。以本地源码为准。

2. **纠正 Cursor 是"纯手动 Pin 管理"的过度简化**：critical worker 将 Cursor 描述为纯手动上下文管理（Pin/Add to context），但 grounded worker 的 protobuf 证据显示 Cursor 有完整的自动压缩协议（`SummarizeAction` + `ConversationSummaryArchive`）。Pin 机制可能是单独的前端功能，与后台自动压缩并存。两者不是互斥的——Cursor 可能既有自动压缩也有手动 Pin；**协议层的 `summary_archives` 是自动压缩的铁证**。

3. **纠正 200K token 触发阈值**：critical worker 引用 Claude Code 压缩阈值 200K。Anthropic API 的上下文窗口是 200K，但 Claude Code compaction 的触发阈值是 `contextWindow - max(15% * contextWindow, reserveTokens)`，可配置 `thresholdPercent`/`thresholdTokens`，不是固定的 200K。

4. **以本地源码为事实依据，外部博客为补充**：grounded worker 的所有结论来自本地文件（`compaction.ts`、`agent.proto`、`compaction.md`），可信度最高。外部博客的 claim 标注为 [unverified]，仅作为补充参考。

## 未采纳的内容

- **divergent** 的 token 经济学曲线分析（logarithmic vs stepped linear）：因 Claude Code 实际使用的是 REPLACE 压缩而非分页，token 曲线的假设前提错误。
- **divergent** 的"冷启动差异"（压缩的 LLM 调用成本 ~200-500 tokens）：grounded 提到远程压缩走 OpenAI 原生端点（可能不计入用户 token quota），本地走 LLM 确实有成本，但具体量级无源码支撑。
- **critical** 的"上下文管理占据 10-15% 交互时间"：无数据来源，纯推测。

## 待验证假设

|假设|来源 worker|置信度|
|---|---|---|
|Cursor 服务端是否对 `summary_archives` 链做二次压缩（合并旧 archive）|grounded + divergent|低（协议无此字段，纯推测）|
|Cursor 压缩的实际触发条件（token 阈值？消息数？时间？）|grounded|低（`SummarizeAction` 为空消息）|
|Claude Code REPLACE 6,000-8,000 字符硬上限在 100+ 轮压缩后是否导致关键信息丢失|grounded + critical|中（有上限约束，但无长期测试数据）|
|Cursor 的 Pin/@引用机制是否与自动压缩并存|critical + grounded|低（Pin 是 UI 层功能，compress 是协议层，两者不矛盾但共存关系未证实）|
|混合策略（自动摘要 + 用户确认）两家都未采用的原因|critical|低（推测，无直接证据）|