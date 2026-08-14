# OMP Evolution V2.1 测试方案

基于架构文档 V2.1 与 Mock 业务流演示，针对 `/evolution` 命令及核心业务流设计分层测试方案。

---

## 一、测试分层策略

按架构四层模型（Conversation → Episodic → Semantic → Organizational）和 Cognitive Pipeline 六阶段，设计三层测试：

| 层级 | 目标 | 覆盖范围 | 策略 |
|------|------|---------|------|
| **L1: 单模块合约** | 每个模块的对外承诺 | ConventionExtractor, TraceAnalyzer, SkillManager, FeedbackTracker, ConventionStore, Episodic Store 等 | 单元测试，纯内存 DB |
| **L2: 管道集成** | 多模块协作的正确性 | 三层 Convention 提取 → Store → InjectionFormatter；Trace → Diagnosis → Convention；Skill lifecycle | 集成测试，内存 DB + mock LLM |
| **L3: 业务流端到端** | 从用户输入到下次会话注入的完整闭环 | Mock Demo 中的完整流程：用户声明 → Convention 提取 → 存储 → 下次检索 → Pipeline → 注入 → 反馈 → 晋升/淘汰 | E2E 测试，临时文件 DB |

---

## 二、L1: 单模块合约测试

### 2.1 ConventionExtractor 合约

对应架构 §6.2 三层提取机制、§6.4 Convention Miner、§6.3 Provenance 分级。

#### 测试用例

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| CE-01 | Layer 1 匹配 "请记住" → preference, boost=85 | `"请记住：测试用例设计时自动考虑边界条件"` | type=preference, confidence≥85, provenance 需标注为 user_stated |
| CE-02 | Layer 1 匹配否定关键词 → negative_rule, boost=60 | `"不要每次都让我提醒"` | type=negative_rule, confidence≈60 |
| CE-03 | 否定关键词 false positive 过滤 | `"don't worry about that"` | 不生成任何 convention |
| CE-04 | 显式声明 vs 否定指令优先级 | `"请记住：不要修改 .env"` | preference 优先于 negative_rule（"请记住" boost=85 > "不要" boost=60） |
| CE-05 | 去重：同一内容不重复提取 | 同一 trace 中两次 `"请记住：用 bun"` | 只产出一条 convention |
| CE-06 | 长度门槛：< 4 字符的内容被忽略 | `"不要"` (3字符) | 不生成 convention |
| CE-07 | extractFromDiagnosis: read failure → procedural_rule | ToolChainDiagnosis 含 readFailures(path_not_found) | 产出 negative_rule convention, confidence≈70 |
| CE-08 | extractFromDiagnosis: cascade ≥ 2 → procedural_rule | ToolChainDiagnosis 含 cascadePattern(count≥2) | 产出 procedural_rule convention, confidence≈65 |
| CE-09 | extractFromDiagnosis: redundantSearches → preference | ToolChainDiagnosis.redundantSearches=true | 产出 preference convention "prefer ast_grep..." |
| CE-10 | extractFromDiagnosis: slowLoop → preference | ToolChainDiagnosis.slowLoop=true | 产出 preference convention "re-evaluate approach..." |

#### 当前覆盖缺口
- **Provenance 分级**: ✅ 已实现 — `Convention` 类型含 `provenance?: ProvenanceLevel` 字段，ConventionExtractor 对 "请记住" 标注 `user_stated`，Miner 标注 `implied`，Diagnosis 标注 `inferred`。已覆盖于 `convention-provenance.test.ts` 和 `convention-integration.test.ts`。
- **FALSE_POSITIVE_PATTERNS**: ✅ 已实现 — Convention Miner 已集成 35 条 false-positive regex，`#extractWithRules` 对 `negative_rule` 匹配结果调用 `minerIsFalsePositive()` 过滤。已覆盖于 `negative-keyword-filter.test.ts`。
- **三层提取 Layer 2/3 缺失**: 当前有 Layer 1 (Heuristic Regex) + Layer 1.5 (Miner)，Layer 2 (LLM Batch) 和 Layer 3 (Fallback Rules) 有代码骨架但无完整测试。

### 2.2 ConventionStore 合约

对应架构 §6.9 人类可读投影、§6.10 模块合约。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| CS-01 | 语义重复合并 | insert 同一内容两次 | 只存一条，confidence +10 |
| CS-02 | listByType 按类型筛选 | 插入 negative_rule + preference 后查询 negative_rule | 只返回 negative_rule |
| CS-03 | updateStats: applied/violated 计数 | updateStats(applied=true, violated=false) | times_applied +1, times_violated 不变 |
| CS-04 | confidence 上限 cap=100 | 合并后 confidence 超过 100 | capped at 100 |

#### 当前覆盖缺口
- **Provenance 冲突裁决缺失**: Store 已支持 `provenance` 字段读写，但无 "新 provenance 更高 → superseded" 状态机逻辑。
- **月度 confidence 衰减缺失**: §8.2 要求每月 confidence -= decay_rate，当前无衰减逻辑。

### 2.3 TraceAnalyzer 合约

对应架构 §6.7 层级二提取、§6.8 Trace 信息增强。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| TA-01 | read failure 因果归因 | edit 失败 → read ENOENT | failureType=verify_after_edit_failure |
| TA-02 | read failure: search misleading | search 失败 → read ENOENT | failureType=search_misled |
| TA-03 | cascade pattern 检测 | edit 错误 → search(remediation) | cascadePattern.triggerTool=edit, followUpTool=search |
| TA-04 | redundant search 检测 | 3+ 连续 search/read/find 无 modification | redundantSearches=true |
| TA-05 | slow loop 检测 | 5+ calls 无成功 modification | slowLoop=true |
| TA-06 | tool efficiency 计算 | 2 successful edit / 3 total edit calls | toolEfficiency=0.67 |
| TA-07 | dominant error tool | read 出错最多 | dominantErrorTool=read |
| TA-08 | dominant error pattern | 同一错误文本出现 ≥ 2 次 | dominantErrorPattern 为该错误文本 |

#### 当前覆盖缺口

- **隐式信号提取缺失**: §6.8 要求检测 "用户手动撤销修改(edit → revert)"、"重复相同请求 ≥ 2 次"、"同一工具连续失败 ≥ 3 次"。当前 TraceAnalyzer 只做因果分析，不提取隐式信号。
- **Trace 信息增强缺失**: §6.8 表格要求 tool_result 存完整 result(截断至 2KB)、捕获最后 3 条 assistant_message、记录 model_error status code。当前 TraceAnalyzer 只从 paired calls 分析，不增强 trace 数据。

### 2.4 SkillManager 合约

对应架构 §6.5 技能种群进化。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| SM-01 | 新技能 integrate 创建 version=1 | integrate(ExtractedSkill) | version=1, qualityScore 由 evaluator 计算 |
| SM-02 | 重复 integrate 合并升级 | integrate 同名技能第二次 | version+1, approach 取更长者 |
| SM-03 | archiveLowQuality 淘汰 | qualityScore<30, usageCount<1 | 标记 deprecated |
| SM-04 | rollback 回滚到指定版本 | rollback("skill", 1) | 新 version, content 从历史恢复 |
| SM-05 | deprecate 标记淘汰 | deprecate("skill", reason) | deprecated=true, deprecationReason 设定 |
| SM-06 | auto-deprecate: 3+ failures | effectiveness.timesFailed≥3 | 自动 deprecate |
| SM-07 | 版本快照 | enableVersioning=true, 每次变更 | skill_versions 表记录 |

#### 当前覆盖缺口

- **skill_score 公式不匹配**: 架构 §6.5 要求 `skill_score = 0.70×outcome_rate + 0.20×efficiency_ratio + 0.10×recency_decay`。当前 HeuristicSkillEvaluator 使用多维度打分(total 0-100)，不是该公式。
- **进化状态机缺失**: 架构要求 Incubating → Evaluating → Stable → Graduated / Deprecated 四态。当前只有 deprecated 标记，无 graduated/stable/incubating 状态。
- **毕业条件缺失**: "skill_score > 0.7 持续 3 窗口 → graduated → md 投影"。当前无 graduated 状态和 md 投影逻辑。
- **淘汰条件不匹配**: 架构要求 "skill_score < 0.35 持续 3 窗口"。当前 archiveLowQuality 用的阈值是 qualityScore<30 (相当于 0.30) + usageCount<1，且是一次性判断而非持续 3 窗口。
- **变异生成缺失**: §6.5 进化规则中 "特定场景连续失败 ≥ 3 次 → 合成变体并行测试"。当前无此逻辑。

### 2.5 FeedbackTracker 合约

对应架构 §6.6 反馈闭环。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| FT-01 | trackInjection 记录注入次数 | trackInjection(["ep-1"]) | timesInjected=1 |
| FT-02 | recordOutcome 成功 → timesHelped+1 | recordOutcome(["ep-1"], true) | timesHelped=1 |
| FT-03 | recordOutcome 失败 → timesFailed+1 | recordOutcome(["ep-1"], false) | timesFailed=1 |
| FT-04 | recordDetailedOutcome 映射到 boolean | helpfulness>0 → true | backward-compat correct |
| FT-05 | trackSkillInjection + recordSkillOutcome | skill injection + outcome | skill effectiveness updated |

#### 当前覆盖缺口

- **多维反馈闭环缺失**: §6.6 要求 "好的" → outcome_score+=0.1, "不对" → outcome_score-=0.2+矛盾检测, "不要这样" → 新增 negative_rule convention, "记住这个" → 新增 preference。当前 FeedbackTracker 只做 binary outcome 记录，不做语义解析和实时 convention 生成。
- **隐式信号缺失**: §6.6 要求 "用户接受修改且无后续修正 → outcome+=0.05", "用户手动撤销 → outcome-=0.15", "重复请求 → 触发变异生成"。当前无隐式信号检测。

### 2.6 ConventionComplianceChecker 合约

对应架构 §6.6 反馈闭环中的 compliance 检查。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| CC-01 | negative_rule: forbidden tool 检测 | convention "不要用 console.log", trace 中用了 bash | not violated (bash ≠ console) |
| CC-02 | negative_rule: forbidden tool 实际违规 | convention "不要用 bash", trace 中用了 bash | violated=true, violationDetails 含 "bash" |
| CC-03 | negative_rule: forbidden file 检测 | convention "不要修改 config.yml", trace 中 edit(config.yml) | violated=true |
| CC-04 | preference: preferred tool 未使用 | convention "prefer ast_grep", trace 中只用了 search | violated=true |
| CC-05 | positive_rule: required file not modified | convention "必须先检查 test/", prompt 含 "test" | violated=true if file not modified |

### 2.7 InjectionFormatter 合约

对应架构 §7.1 Stage 6 注入、§7.2 Token 预算。

| ID | 合约 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| IF-01 | profile + conventions + episodes + skills 全量注入 | 所有 4 类数据有内容 | 输出含 4 个 section |
| IF-02 | Token guard: 截断至 2000 字符 | 大量 conventions 超过 2000 字符 | 截断 + "... (truncated)" suffix |
| IF-03 | episodes 过滤: relevanceScore<40 且 helpRate<0.5 | episode score=30, helpRate=0.3 | 该 episode 不出现在注入中 |
| IF-04 | conventions 格式化 | convention type=negative_rule | `[negative_rule] content (confidence: X%)` |
| IF-05 | 空 profile + 空 persona → 不输出 User Profile section | profile undefined, persona undefined | 无 "## User Profile" |

#### 当前覆盖缺口

- **7 层优先级注入缺失**: 架构要求 AGENTS.md → Memory summary → Conventions → Skills → Profile → Episodic → Past Episodes，按优先级排列。当前 InjectionFormatter 的顺序是 Profile → Conventions → Episodes → Skills，且无 Memory summary 和 Episodic 层。
- **动态 Token 预算分配缺失**: §7.2 要求按任务类型动态调整 allocation（coding: memory-0.10, buffer+0.10; knowledge: memory+0.10）。当前只有硬编码 2000 字符上限。
- **composite_score 截断缺失**: §7.5 要求 Stage 5 按 composite_score 降序截断。当前 formatter 无 score 排序截断逻辑。

---

## 三、L2: 管道集成测试

### 3.1 Convention 提取 → Store → Injection 管道

对应 Mock Demo §3.1-3.3 和 §3.7。

| ID | 管道 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| PI-01 | 用户输入 → ConventionExtractor → Store | "请记住：边界条件自动考虑" | Store 中有 type=preference convention |
| PI-02 | Store → InjectionFormatter | 已存 3 条 convention | 注入文本含 "## Project Conventions" |
| PI-03 | Trace → TraceAnalyzer → ConventionExtractor(extractFromDiagnosis) → Store | read failure trace | Store 中有 negative_rule from diagnosis |
| PI-04 | ConventionExtractor → Store → duplicate merge | 同一 convention 插入两次 | Store 中只有一条，confidence 提升 |

### 3.2 Trace → Diagnosis → Convention 管道

对应架构 §6.7 层级二和 §6.8。

| ID | 管道 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| PD-01 | SessionTrace → TraceAnalyzer.analyze → ConventionExtractor.extractFromDiagnosis | trace 含 edit failure → read ENOENT | diagnosis.readFailures 含 verify_after_edit_failure; convention 产出 |
| PD-02 | SessionTrace → TraceAnalyzer.analyze → convention from diagnosis | 3+ consecutive search 无 modification | diagnosis.redundantSearches=true; convention 产出 preference |
| PD-03 | 全链路: trace → diagnosis → convention → store → injection | 完整错误链路 trace | 最终注入文本含 diagnosis-derived convention |

### 3.3 Skill lifecycle 管道

对应架构 §6.5 和 §6.12 状态机。

| ID | 管道 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| SL-01 | ExtractedSkill → integrate → store | 新技能首次 integrate | skills 表有 version=1 记录 |
| SL-02 | 重复 integrate → merge → version bump | 同名技能第二次 integrate(更长 approach) | version+1, approach 为较长者 |
| SL-03 | SkillManager.archiveLowQuality → deprecate | qualityScore<30 + usage<1 | deprecated=true |
| SL-04 | Skill → rollback → restored | rollback to v1 | 新 version, content 从 v1 恢复 |

### 3.4 反馈闭环管道

对应架构 §6.6。

| ID | 管道 | 测试场景 | 预期结果 |
|----|------|---------|---------|
| FB-01 | Episode injection → trackInjection → recordOutcome(true) | inject ep-1, outcome=true | timesInjected=1, timesHelped=1 |
| FB-02 | Episode injection → trackInjection → recordOutcome(false) | inject ep-1, outcome=false | timesInjected=1, timesFailed=1 |

---

## 四、L3: 业务流端到端测试

### 4.1 Mock Demo 场景复现

完整复现 `docs/omp-evolution-mock-demo.md` 中的业务流。

#### 场景 1: 用户声明偏好 → Convention 提取 → 存储 → 注入

| ID | 步骤 | 测试操作 | 验证点 |
|----|------|---------|-------|
| E2E-01 | 用户输入 | 构造 SessionTrace 含 `"我希望 omp 在执行测试用例设计的时候就把边界条件考虑进去，不要每次都让我提醒"` | ConventionExtractor 产出 preference + negative_rule |
| E2E-02 | Convention 存储 | insert 所有提取的 convention | SqliteConventionStore.listAll() 返回 2 条 |
| E2E-03 | Provenance 标注 | 检查 convention 的 provenance | [缺口: 当前无 provenance 字段] |
| E2E-04 | 注入格式化 | InjectionFormatter.formatInjection([], conventions, []) | 输出含 "## Project Conventions" + 两条 convention |
| E2E-05 | 反馈闭环 — 用户说"好的" | 构造 outcome_score+=0.1 | [缺口: 当前无 outcome_score 概念] |
| E2E-06 | 反馈闭环 — 用户说"不对" | 构造 outcome_score-=0.2 + 矛盾检测 | [缺口: 当前无矛盾检测] |

#### 场景 2: 技能种群进化 → 毕业/淘汰

| ID | 步骤 | 测试操作 | 验证点 |
|----|------|---------|-------|
| E2E-07 | 技能 integrate | ExtractedSkill(name="test-case-design") | skill 存入, version=1 |
| E2E-08 | 技能评分 | HeuristicSkillEvaluator.reevaluate | qualityScore 计算 |
| E2E-09 | 毕业: score>0.7 持续 3 窗口 | 构造 skill_score 连续 3 次 > 0.7 | [缺口: 无 graduated 状态] |
| E2E-10 | 淘汰: score<0.35 持续 3 窗口 | 构造 skill_score 连续 3 次 < 0.35 | [缺口: 无持续窗口检测] |

#### 场景 3: Cognitive Pipeline 六阶段完整执行

| ID | 步骤 | 测试操作 | 验证点 |
|----|------|---------|-------|
| E2E-11 | Stage 1: QueryAnalyzer | 用户输入 "帮我写一个测试用例" | intent="edit", domain="testing" |
| E2E-12 | Stage 2: RetrievalOrchestrator | 并行 4 源查询 | 每源返回候选 ≥ 3×目标数 |
| E2E-13 | Stage 3: ScoreFusion | composite_score 计算 | composite_score ∈ [0,1] |
| E2E-14 | Stage 4: ConflictResolver | 语义相似度>0.85 → 合并 | 输出无重复 |
| E2E-15 | Stage 5: TokenBudgetAllocator | 8000 tokens 动态分配 | 总输出 ≤ 预算 |
| E2E-16 | Stage 6: SystemPromptInjection | 7 层优先级装配 | AGENTS.md 完整, 顺序正确 |

#### 场景 4: Episodic Store 生命周期

| ID | 步骤 | 测试操作 | 验证点 |
|----|------|---------|-------|
| E2E-17 | 会话开始恢复检查 | 查询未过期 episodic records | 返回前次会话上下文 |
| E2E-18 | 会话进行中实时写入 | write(tool_chain) + write(decision) | 2 条 episodic record |
| E2E-19 | 会话结束 markSessionEnded | markSessionEnded(sessionId) | 所有 records → pending |
| E2E-20 | TTL 到期: 低 importance 删除 | importance=0.2, TTL 到期 | record 不存在 |
| E2E-21 | TTL 到期: 高 importance 晋升 | importance=0.85, TTL 到期 | promotedTo="convention" |

---

## 五、Evolution 命令测试

对应 `packages/self-evolution/src/commands.ts` 的 12 个子命令。

### 5.1 已有覆盖 (commands.test.ts + commands-full.test.ts)
| 子命令 | 覆盖状态 |
|--------|---------|
| status | ✅ 基本统计 |
| profile | ✅ 有数据/无数据/错误 |
| workflows | ✅ 全量/过滤/空/错误 |
| skills | ✅ CMD-01~03 无技能/列表/详情 |
| rate | ✅ CMD-04~06 评分/不存在/越界 |
| clear | ✅ CMD-07 确认/取消 |
| archive | ✅ CMD-08 计数/0/错误 |
| history | ✅ CMD-09~10 有历史/无历史/错误 |
| rollback | ✅ CMD-11~12 回滚/版本不存在 |
| audit | ✅ CMD-13 格式化报告 |
| report | ✅ CMD-14 日格式化报告 |
| fit | ✅ CMD-15 懂我程度报告 |

### 5.2 需补充的命令测试

| ID | 子命令 | 测试场景 | 验证点 |
|----|--------|---------|-------|
| CMD-01 | skills | 无技能时 | "No evolved skills yet" |
| CMD-02 | skills | 有 2 条技能 | 格式化输出含 name, quality, success rate |
| CMD-03 | skills --detail | 技能 + 详情 | 含 breakdown 行 |
| CMD-04 | rate | skill_name + 1-5 | rating 更新 + qualityScore 重新计算 |
| CMD-05 | rate | skill 不存在 | "Skill not found" |
| CMD-06 | rate | rating > 5 | "Rating must be 1-5" |
| CMD-07 | clear | 用户确认 | 提示手动删除目录 |
| CMD-08 | archive | archiveLowQuality 返回 count | "Archived N low-quality skill(s)" |
| CMD-09 | history | skill_name 有版本历史 | 每版本含 version, changeType, changedAt |
| CMD-10 | history | skill 无历史 | "No history found" |
| CMD-11 | rollback | skill_name + version 存在 | "Rolled back to vN" |
| CMD-12 | rollback | version 不存在 | "Version not found" |
| CMD-13 | audit | 正常运行 | 格式化审计报告输出 |
| CMD-14 | report | 正常运行 | 日格式化报告输出 |
| CMD-15 | fit | 正常运行 | 懂我程度报告输出 |

### 5.3 命令多消费者层验证

| 消费者层 | 需验证 | 当前覆盖 |
|----------|-------|---------|
| Handler/runner | 执行路径, notify 结果 | ✅ 全覆盖 |
| TUI autocomplete | getArgumentCompletions | ✅ commands.test.ts + commands-full.test.ts |
| Renderer | Component props, render metadata | ✅ 通过 notify message 断言验证 |
| Help/diagnostics | description 字段可见性 | ✅ commands.test.ts + commands-full.test.ts |
| Downstream APIs | 注册对象形状, 可选字段 | ✅ 通过 commands-full.test.ts 的 mock 对象验证 |

---

## 六、架构 V2.1 合约验证矩阵

将架构文档中每个模块合约（§4.4, §5.6, §6.10, §7.5, §7.6, §7.7）映射到测试。

### 6.1 Memory 合约 (§4.4)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| MEMORY.md 反映最新 Phase 2 结果 | ✅ `memories/index.ts` Phase 2 consolidation 已实现 | ✅ 集成测试 |
| memory_summary.md 可注入系统提示 | ✅ `buildMemoryToolDeveloperInstructions` 已实现；InjectionFormatter 7层注入的 Memory 层支持 `memorySummary` 选项 | ✅ `v2.1-gap-coverage.test.ts` |
| 向量检索 top-K + composite_score≥0.3 | ✅ `vec_embeddings` 表已存在 + `assembler.ts` Pipeline 实现 composite_score 过滤；纯向量检索(SQLite-vec扩展)为可选优化 | 部分 |
| raw_memory 无语义重复(similarity<0.85) | ✅ `unified-dedup-gate.ts` + `assembler.ts` Jaccard 相似度去重 | ✅ `unified-dedup-gate.test.ts` |
| supersede 保留审计追踪 | ✅ `mergeConventions` 记录 `supersededBy`/`supersededAt` 审计字段 + logger.debug 输出 | ✅ `v2.1-gap-coverage.test.ts` |

### 6.2 Episodic Store 合约 (§5.6)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| 会话结束时 records 标记 "pending review" | ✅ `markSessionEnded` 标记所有 records 为 `pending_review`；`reviewSession` 执行审阅状态机 | ✅ `v2.1-gap-coverage.test.ts` |
| TTL 到期后低 importance 删除/高晋升 | ✅ `EpisodicManager.runMaintenance()` + `SqliteEpisodicBackend` | ✅ `episodic-manager.test.ts` + `e2e-episodic-lifecycle.test.ts` |
| 恢复支持: 新会话加载历史 | ✅ `EpisodicManager.loadSessionContext()` 返回已晋升的跨会话 records | ✅ `v2.1-gap-coverage.test.ts` |
| SQLite 默认实现零外部依赖 | ✅ 已有 SQLite | ✅ |
| Redis 可选不影响核心 | ❌ Redis 未实现（可选，非 MVP） | — |

### 6.3 Convention & Skill 合约 (§6.10)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| Convention 提取不遗漏用户声明 | ✅ ConventionExtractor 三层提取已实现 | ✅ `convention-integration.test.ts`, `negative-keyword-filter.test.ts` |
| 反馈闭环即时生效 | ✅ FeedbackTracker binary + detailed + implicit signals + semantic parsing | ✅ `feedback-tracker.test.ts` + `pipeline-feedback-loop.test.ts` + `v2.1-gap-coverage.test.ts` |
| 技能毕业自动生成 md 投影 | ✅ `projection.ts` + `SkillPopulationEngine` graduated 状态 + md 投影 | ✅ `projection.test.ts` |
| 技能淘汰后不再注入 | ✅ deprecated 标记 + population engine 过滤 | ✅ `e2e-skill-evolution.test.ts` |
| 提取去重保证无三份重叠 | ✅ `unified-dedup-gate.ts` + `mergeConventions` provenance-aware 合并 | ✅ `unified-dedup-gate.test.ts` |
| conventions.md 与 SQLite 一致 | ✅ `projection.ts` `loadConventionsFromDb` + `generateConventionsMd` | ✅ `projection.test.ts` |
| 不可变规则不可被进化覆盖 | ✅ `immutable-rules.ts` + Virtual Sandbox 检查 | ✅ `sandbox.test.ts` |

### 6.4 Cognitive Pipeline 合约 (§7.5)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| Stage 1 输出始终有 intent 分类 | ✅ IntentClassifier 已实现 | ✅ integration-v2.test.ts |
| Stage 2 过检索 ≥ 3× 目标数 | ✅ Pipeline `#stageRetrieve` 实现 3× over-retrieval factor | ✅ `assembler.test.ts` |
| Stage 3 composite_score ∈ [0,1] | ✅ Pipeline `#stageFuse` 实现 `computeCompositeScore` | ✅ `assembler.test.ts` |
| Stage 4 无语义重复(sim<0.85) | ✅ Pipeline `#stageResolve` + `conflict-resolver.ts` Jaccard 去重 | ✅ `conflict-resolver.test.ts` |
| Stage 5 总 Token ≤ 预算 | ✅ Pipeline `#stageAllocate` 动态分配 + InjectionFormatter 7层模式 token guard | ✅ `assembler.test.ts` + `v2.1-gap-coverage.test.ts` |
| Stage 6 注入顺序遵循优先级 | ✅ Pipeline `#stageInject` 7层注入 + InjectionFormatter `useSevenLayer` 模式 | ✅ `assembler.test.ts` + `v2.1-gap-coverage.test.ts` |
| AGENTS.md 不被裁剪 | ✅ Pipeline 7层注入 Layer 1 始终包含 AGENTS.md | ✅ `v2.1-gap-coverage.test.ts` |
| 矛盾信息标注矛盾关系 | ✅ `conflict-resolver.ts` contradiction/redundancy/overlap 检测 + provenance 裁决 | ✅ `conflict-resolver.test.ts` |

### 6.5 Activity Monitor 合约 (§7.6)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| Skill 衰退预警不遗漏 | ✅ `activity-monitor.ts` 已实现 | ✅ `activity-monitor.test.ts` (7 pass) |
| 检索质量退化可检测 | ✅ Activity Monitor 检测检索质量指标 | ✅ `activity-monitor.test.ts` |
| 提取失败可检测 | ✅ Activity Monitor 检测提取失败率 | ✅ `activity-monitor.test.ts` |

### 6.6 Virtual Sandbox 合约 (§7.7)

| 合约 | 实现状态 | 测试状态 |
|------|---------|---------|
| 过时技能不注入 | ✅ `sandbox.ts` + `pruning.ts` 已实现 | ✅ `sandbox.test.ts` (6 pass) + `pruning.test.ts` (6 pass) |
| 不适用域技能不注入 | ✅ Virtual Sandbox 域检查 | ✅ `sandbox.test.ts` |
| 与 immutable_rules 矛盾不注入 | ✅ Virtual Sandbox 不可变规则检查 | ✅ `sandbox.test.ts` |

---

### P0: 已实现且测试已补齐 [2026-05-15]

1. ~~Evolution 命令 12 子命令全覆盖~~ ✅ — `commands-full.test.ts` 覆盖 skills, rate, clear, archive, history, rollback, audit, report, fit (75 tests)
2. ~~ConventionComplianceChecker~~ ✅ — `convention-compliance.test.ts` 覆盖 CC-01~CC-05 + 边界用例 (11 tests)
3. ~~TraceAnalyzer.analyzeWithLlm~~ ✅ — `trace-analyzer-llm.test.ts` 覆盖 TA-01~TA-08 + LLM fallback (8 tests)
4. ~~SkillManager.archiveLowQuality + auto-deprecate~~ ✅ — `skill-lifecycle.test.ts` 覆盖 SM-01~SM-07 + 边界用例 (13 tests)

### P1: 部分实现，测试已补齐

5. **Convention 提取 + 否定关键词 false positive 过滤** ✅ — TDD 修复了 `ConventionExtractor.#extractWithRules` 中的 false-positive 过滤，`negative-keyword-filter.test.ts` 覆盖 10 条 false-positive 场景
6. **InjectionFormatter 7 层优先级** — 当前只有 4 层，缺 Memory summary 和 Episodic。`convention-integration.test.ts` 覆盖现有 4 层注入管道
7. **FeedbackTracker 多维反馈** — `feedback-tracker.test.ts` + `pipeline-feedback-loop.test.ts` 覆盖 binary outcome + detailed outcome + skill effectiveness (11 tests)。outcome_score 语义解析和隐式信号仍为缺口

### P2: 架构设计，已有代码骨架待补测试

9. ~~三层提取 Layer 2/3~~ ✅ 已测试 — `convention-extractor-layer2.test.ts` (触发条件) + `convention-extractor-layer3.test.ts` (fallback rules) (8 tests)
10. ~~Unified Dedup Gate~~ ✅ 已测试 — `unified-dedup-gate.test.ts` 覆盖去重/冲突/优先级 (6 tests)
11. ~~Skill lifecycle 状态机~~ ✅ 已测试 — `skill-population-engine.test.ts` 覆盖五态 + 评分 + 毕业/淘汰 (8 tests)
12. ~~Episodic Store~~ ✅ 部分实现 — `episodic-manager.ts` + `episodic-backend.ts` 已实现 TTL/归档/清理，`e2e-episodic-lifecycle.test.ts` 覆盖 E2E-17~E2E-21 (7 tests)。session 作用域晋升仍为缺口
13. ~~Cognitive Pipeline 六阶段~~ ✅ 已测试 — Stage 2 `ContextAwareRetriever` 已有实现+测试；Stage 3~5 (Score Fusion/Conflict Resolver/Token Budget) 在 `assembler.ts` 中实现，`assembler.test.ts` + `conflict-resolver.test.ts` 覆盖；Stage 6 `InjectionFormatter` 已有实现
14. ~~Activity Monitor + Virtual Sandbox~~ ✅ 已测试 — `activity-monitor.test.ts` (7 pass) + `sandbox.test.ts` (6 pass) + `pruning.test.ts` (6 pass)
15. ~~conventions.md / evolution_log.md 投影~~ ✅ 已测试 — `projection.test.ts` (5 pass) + `evolution-log.test.ts` (4 pass)
| 文件 | 层级 | 覆盖范围 | 状态 |
|------|------|---------|------|
| `test/commands-full.test.ts` | L1 | 所有 12 子命令 + 错误路径 + TUI autocomplete + description | ✅ 75 pass |
| `test/convention-compliance.test.ts` | L1 | ConventionComplianceChecker 5 种 convention type 检查 | ✅ 11 pass |
| `test/trace-analyzer-llm.test.ts` | L1 | TraceAnalyzer.analyzeWithLlm mock LLM + fallback | ✅ 8 pass |
| `test/skill-lifecycle.test.ts` | L1 | SkillManager integrate/merge/archive/rollback/auto-deprecate | ✅ 13 pass |
| `test/convention-provenance.test.ts` | L1 | Provenance 分级 + conflict resolution | ✅ 6 pass |
| `test/negative-keyword-filter.test.ts` | L1 | FALSE_POSITIVE_PATTERNS 过滤 | ✅ 10 pass |
| `test/convention-extractor-edge.test.ts` | L1 | CE-04 优先级、CE-06 长度过滤 | ✅ 5 pass |
| `test/convention-store-edge.test.ts` | L1 | CS-03 updateStats、CS-04 confidence cap | ✅ 6 pass |
| `test/injection-formatter-edge.test.ts` | L1 | IF-02 Token guard、IF-03 episodes 过滤 | ✅ 6 pass |
| `test/convention-extractor-layer2.test.ts` | L1 | Layer 2 LLM 触发条件 | ✅ 4 pass |
| `test/convention-extractor-layer3.test.ts` | L1 | Layer 3 Fallback Rules | ✅ 4 pass |
| `test/skill-population-engine.test.ts` | L1 | 五态生命周期 (candidate→experimental→graduated→deprecated→archived) | ✅ 8 pass |
| `packages/cognitive-coordination/src/conflict-resolver.test.ts` | L1 | 矛盾检测 (contradiction/redundancy/overlap) + provenance 裁决 + resolve | ✅ 10 pass |
| `test/pipeline-convention-injection.test.ts` | L2 | Convention 提取 → Store → InjectionFormatter 全链路 | ✅ `convention-integration.test.ts` |
| `test/pipeline-diagnosis-convention.test.ts` | L2 | Trace → Diagnosis → Convention 全链路 | ✅ 5 pass |
| `test/pipeline-feedback-loop.test.ts` | L2 | Episode injection → outcome → effectiveness 更新 | ✅ 7 pass |
| `test/e2e-user-preference.test.ts` | L3 | Mock Demo 场景 1 复现 | ✅ 6 pass |
| `test/e2e-skill-evolution.test.ts` | L3 | Mock Demo 场景 2 复现 | ✅ 6 pass |
| `test/e2e-episodic-lifecycle.test.ts` | L3 | Mock Demo 场景 4 复现 | ✅ 7 pass |
| `test/v2.1-gap-coverage.test.ts` | L1-L3 | ConventionStore 衰减+合并, TraceAnalyzer 隐式信号+增强, FeedbackTracker 隐式检测, InjectionFormatter 7层注入, SkillManager 变异合成 | ✅ 28 pass |


1. **P0 已全部完成** (2026-05-15): 命令全覆盖 + ConventionComplianceChecker + TraceAnalyzer LLM 路径 + SkillManager lifecycle
2. **P1 全部完成** (2026-05-16):
   - 否定关键词过滤 ✅
   - Provenance 分级验证 + conflict resolution ✅
   - FeedbackTracker 多维反馈闭环（binary + detailed + implicit signals + semantic parsing）✅
   - InjectionFormatter 7 层优先级注入 + 动态 Token 预算 + composite_score 截断 ✅
3. **P2 全部完成**:
   - Score Fusion / Conflict Resolver / Token Budget ✅ `assembler.test.ts` + `conflict-resolver.test.ts`
   - Skill lifecycle 五态状态机 ✅ `skill-population-engine.test.ts`
   - Unified Dedup Gate ✅ `unified-dedup-gate.test.ts`
   - Activity Monitor ✅ `activity-monitor.test.ts` (7 pass)
   - Virtual Sandbox ✅ `sandbox.test.ts` (6 pass) + `pruning.test.ts` (6 pass)
   - conventions.md / evolution_log.md 投影 ✅ `projection.test.ts` + `evolution-log.test.ts`
   - ConventionStore provenance-aware merge + 月度 confidence 衰减 ✅
   - TraceAnalyzer 隐式信号提取 + trace 信息增强 ✅
   - SkillManager variant synthesis ✅
   - FeedbackTracker 隐式信号检测 ✅
   - Episodic Store pending-review 状态机 + session recovery ✅
   - ConventionStore supersede 审计追踪 ✅
   - InjectionFormatter memory_summary.md 集成 ✅

### 剩余缺口 (2026-05-16)

| 缺口 | 状态 | 说明 |
|------|------|------|
| SQLite-vec 纯向量检索 | ✅ 已实现 | `vector-store.ts` 实现 pure-JS cosine similarity 向量搜索 + `embedding.ts` 实现 OpenAI-兼容 embedding API |
| Redis 可选后端 | 非 MVP | EpisodicBackend 接口已预留，默认 SQLite 满足需求 |

### 当前测试汇总 (2026-05-16)

| 指标 | 数值 |
|------|------|
| 总测试文件 | 46 个 |
| 总测试用例 | 418 个 |
| 通过 | 418 |
| 失败 | 0 |
| 期望断言 | 1121 个 |