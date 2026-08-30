# Skill Telemetry（技能观测与管理）v1 设计

> 状态：设计终稿（2026-08-12，经 grilling 逐项拍板）
> 定位：观测与管理系统，**不是进化系统**。只读 skill 文件，永不自动修改。
> 目标读者：产品/技术评审、后续实现者。

---

## 1. 背景与问题

当前 cornfield 的 skill 管理存在三个实际困扰：

1. **可见性缺失**：gateway agent 启动即加载 ~80 个 skill（69 用户级 + 20 项目级 − 9 同名去重），无裁剪、无按 agent 视角的清单，无人知晓这些 skill 的用途与归属。
2. **无执行记录**：skill 写完后没有"跑得怎么样"的记录——是否被用、成功与否、耗时多少、失败原因、是否需要改进，全部无从知晓。
3. **跨 agent 无借鉴**：每个 agent 有各自 skill，多个 agent 可能在做相同的事，效果无对照、做法不互通，只能手动借鉴。

现状系统（skill 加载/`skill://` 协议/热更新/`/evolution` 进化插件）中，进化链路（自动提取/优化/mutate/废弃）已被用户禁用；本次设计独立于进化插件，不依赖其 enable 状态。

## 2. 定位与边界

**一句话**：回答三件事——谁用了什么 skill、用得好不好、哪里有浪费/失败/值得借鉴。**永不自动修改 skill 文件、永不自动进化。**

### 非目标（G）
- G1 不做 skill 自动提取 / 自动优化 / 自动 mutate / 自动废弃。
- G2 不整合、不读取、不迁移 `evolution.db`（旧数据原样留存，自然淘汰）。
- G3 不做注入曝光统计（只统计真实使用，不统计 context 注入）。

---

## 3. 功能定义

### A. 目录与清单
| ID | 功能 | 说明 |
|---|---|---|
| A1 | 发现枚举 | 全量列出 skill（用户级 + 项目级）：路径、来源、版本、状态 |
| A2 | 分组查看 | 按组查看清单与聚合统计；分组由独立映射表定义，不碰 skill 文件 |
| A3 | 跨域区分 | 同名 skill 按 `(scope, name)` 区分，杜绝统计串味 |
| A4 | per-agent 清单 | 按 agent 视角列出其实际加载的 skill 集合 + 来源归属（用户库 / agentDir / 项目 / 插件）+ 申明用途 |

### B. 使用追踪（trace）
| ID | 功能 | 说明 |
|---|---|---|
| B1 | 谁/何时/什么任务/哪个 skill | 含 session 关联，可回放 |
| B2 | 真实使用计数 | trigger 分 `user_command` / `llm_read` / `llm_bash`；**不含注入曝光** |
| B3 | 执行成败 + 失败原因 | outcome + failure_reason 枚举（见 4.5），纯日志推导，不引 LLM 分类 |
| B4 | 耗时统计 | 起止按触发顺序切分；p50/p90/p95；可按 agent/trigger/group 分桶 |
| B5 | 明细回放 | 单 skill 最近 N 次执行（agent/trigger/起止/耗时/outcome/失败原因） |

### C. 健康与借鉴
| ID | 功能 | 说明 |
|---|---|---|
| C1 | 健康清单 | 低成功率 / 失败率突升 / 耗时异常 / 长期无人用 / 版本过旧（**纯输出建议**） |
| C2 | 版本历史与回滚 | 版本快照由文件变更 watcher 落库；回滚支持（不依赖 frontmatter 版本字段） |
| C3 | 分组维护 | 名字模式自动播种 + `group set/unset` 人工调整 |
| C4 | 无用识别建议 | 某 agent 长期未用的 skill → 建议从该 agent 配置裁剪（`--ignore` glob），纯建议 |
| C5 | 跨 agent 对照 | 按任务意图/tool_sequence 相似度聚类跨 agent 的 skill 使用 → 效果对照（谁在做同类任务、用什么 skill、成功率如何） |
| C6 | 借鉴建议 | C5 结果 + 版本对比 → 建议参考表现更好的 skill（纯建议，复制/对齐由人工决定） |

### D. 查询面
| ID | 功能 | 说明 |
|---|---|---|
| D1 | 命令族 | `cornfield skill list / groups / group / stats / trace / health / ingest` |
| D2 | 过滤维度 | 窗口（d/w/m）、agent、trigger、group，正交可组合 |
| D3 | 双模输出 | 人读表格 + `--json`（供 agent/脚本消费） |

### E. 摄取管道
| ID | 功能 | 说明 |
|---|---|---|
| E1 | JSONL 解析 | 复用/抽取现有 session JSONL 解析管道（非 evolution 插件依赖） |
| E2 | 双触发 | session 结束增量 + `ingest` 全量回填（历史日志可回溯） |
| E3 | 版本快照 | SkillWatcher 文件变更 → skill_versions 落库（含时间戳） |
| E4 | 扫描范围 | 交互式 `~/.cornfield/agent/sessions/**/by-date/*.jsonl` + 各 gateway `<agentDir>/sessions/*.jsonl`（从 gateway.json 枚举） |
| E5 | 已知盲区（明示） | subagent（task 派生子 agent）的内部工具调用不进父 session JSONL，其 skill 使用 v1 不可见；接受此缺口 |

### F. 非功能约束
- F1 零埋点：不侵入 agent 运行路径（agent 侧无新增事件/协议）。
- F2 只读 skill 文件：观测与版本快照不写 SKILL.md 正文。
- F3 独立于 evolution 插件，不依赖其 enable 状态。

---

## 4. 技术设计

### 4.1 数据层（新全局库 `~/.cornfield/skill-telemetry.db`）

**skills** — 薄维度表（文件系统 `.cornfield/skills` / `~/.cornfield/agent/skills` 是目录真相，此表仅做 JOIN）
```
scope TEXT         -- 'user' | 'project' | 'agent:<id>'（gateway agentDir 内 skill）
name TEXT          -- skill 名（与 scope 联合主键，⚠️ 9 个跨域同名）
source_path TEXT   -- 绝对路径
description TEXT
current_version INTEGER
created_at INTEGER
```

**skill_groups** — 分组映射（独立于 skill 文件，gbrain 更新无影响）
```
scope, name        -- 联合主键
group TEXT         -- 单分组归属
```

**skill_versions** — 文件变更快照（watcher 写入）
```
id, scope, name, version, content_hash, snapshot_at, change_type, change_reason
```
> ⚠️ 经验证：大量 skill 的 frontmatter **没有 `version` 字段**（89 个中约半数缺失，格式不统一 v0.1.0/v1.0.0/vv1.0 混杂）——**版本钉死只能靠 watcher 文件快照，不能靠 frontmatter 解析**。

**skill_executions** — 主表
```
id, scope, skill_name, skill_version,
agent_id,               -- gateway=accountId（agentDir 推导）；交互式='interactive'
trigger,               -- 'user_command' | 'llm_read' | 'llm_bash'
session_ref,           -- 编码 agentDir+convId 或 cwd+session 文件，可回放
task_prompt,           -- 截断 ~200 字
started_at, ended_at, duration_ms,
outcome,               -- 'success' | 'failed' | 'unknown'（启发式：无错误工具 + ≥1 工具调用 = success，沿用 SessionTrace 判定）
failure_reason,        -- 枚举见 4.5
failure_detail,        -- 首行错误摘要（≤300 字符）
tool_sequence JSON     -- 该次使用前后工具调用、isError、时间戳
```

聚合（effectiveness）**不落盘**：按需 `GROUP BY` 查询计算，避免双写/对账。

### 4.2 摄取

- JSONL 解析器从 self-evolution 的 `parse-cornfield-json-events.ts` / `cornfield-session-to-trace.ts` 抽取为独立模块（不依赖插件加载）。
- 增量：agent session 结束时钩子解析刚写入的 JSONL（复用现有 session 生命周期钩子，无新事件）。
- 回填：`cornfield skill ingest --full` 扫全量历史日志一次性建数——**部署当天即获得历史统计**。
- 版本归因：执行时间戳 JOIN skill_versions（watcher 已打时间戳）回填 `skill_version`，解决"日志里无版本"缺口。
- 扫描规则对齐加载器：过滤下划线前缀引导文件（`_AGENT_README.md` 等）、无 description 的非 skill 文件、helper md（`grilling-template.md` 等）。

### 4.3 消费面

命令族（挂 coding-agent `commands/`，独立于 `/evolution`）：
```
cornfield skill list [--agent X]              # A1/A4
cornfield skill groups                        # A2 分组总览（组/数量/次数/成功率/耗时）
cornfield skill group set|unset <name> <组>   # C3
cornfield skill stats [--skill X] [--agent Y] [--group G] [--trigger T] [--window d|w|m] [--json]   # B2-B4/D2/D3
cornfield skill trace <name> [--last N]       # B5
cornfield skill health [--agent X] [--group G] # C1/C4
cornfield skill ingest [--full]               # E2
```

消费对象仅两类：**用户本人**（人读表格）与 **agent 代为查询**（`--json`）；不做统计自动注入 prompt。

### 4.4 分组播种规则（初始自动归类，残余归"未分组"）
```
session-*                    → 会话诊断
gitnexus-*                   → gitnexus
skill-* / skillify / to-spec / to-tickets / writing-great-skills / soul-audit → 元技能
brain-* / idea-* / ingest / query / enrich / maintain / reports / briefing /
media-* / meeting-* / book-* / academic-verify / archive-* / article-* / citation-* /
concept-* / para-* / voice-* / strategic-reading / data-research / webhook-* / dws → 知识库
其余由 `group set` 人工归类
```

### 4.5 口径明细

**failure_reason 枚举**（SkillAudit PACE 四维 + 故障类）：
`process_adherence`（未按步骤）/ `artifact_evidence`（产物不达标）/ `consistency`（skill 与任务/数据冲突）/ `effectiveness_delta`（用了无增益）/ `tool_error` / `model_error` / `aborted`。判定全部从日志推导（工具 isError + 产物缺失 + 步骤偏差对齐），不引 LLM 分类。

**duration 切分（方案 A）**：一个 turn 内多个 skill 触发时，前一个触发点 → 下一个触发点归前者；最后一个触发点 → turn 结束（agent_end）。时间不重叠、可加总。

**聚合口径**：p50/p90/p95；默认按 `skill × agent` 出表，trigger 为可选拆分层；窗口 d/w/m。

**skill 身份归一化**：扁平 SKILL.md / 带脚本（`repro-inject.ts`、`validate-agent.sh`、`diagnosing-bugs/scripts/`）/ 多级嵌套（gitnexus）统一按 baseDir 归属；bash `skill://` 展开天然带回 skill 名。

---

## 5. 已锁定决策记录（grilling 拍板清单）

| # | 决策 |
|---|---|
| 1 | 只统计 engaged（真实使用），不做注入曝光计数 |
| 2 | 零埋点：全部从 session JSONL 日志解析（可使用历史回填） |
| 3 | 执行粒度 = 工具级（skill 内部 step 成败 v1 不可得，需 LLM 自报/对齐推断，不做） |
| 4 | 新全局库 `~/.cornfield/skill-telemetry.db`，从零设计 schema，不迁移 evolution.db |
| 5 | duration 方案 A（触发顺序切分）；聚合支持按 agent/trigger 拆分（默认 skill×agent，trigger 可选） |
| 6 | failure_reason 枚举（PACE 四维 + 故障类），纯日志推导，单层 |
| 7 | 版本归因 = watcher 文件快照（frontmatter 版本字段不可靠，已验证） |
| 8 | skills 表主键 = `(scope, name)`（9 个跨域同名真实存在） |
| 9 | 消费面独立于 `/evolution`（该插件已被禁用），仅 `cornfield skill` 命令族 + 双模输出 |
| 10 | 反馈仅建议层（health/对照/借鉴），永不自动 mutate |
| 11 | 分组 = 独立映射表（不碰 skill 文件），名字模式播种 + 人工调整，单分组 |
| 12 | subagent 使用盲区（E5）v1 明示接受 |

## 6. 已知缺口与 v2

- v1 明示接受：subagent skill 使用不可见（E5）。
- v1 不做：skill 内部 step 级成败、精确 per-skill 计时（日志近似）、TUI 面板。
- v2 候选：`cornfield stats` 仪表盘 skill trace 面板；subagent 会话侧单独落日志后接入；分组标签化（多组）。

## 7. 行业参考（调研结论，2026-08）

- **SkillAudit**（arXiv 2606.14239，ICT-CAS+阿里通义）：无 ground-truth 的 skill 进化框架——成对轨迹审计 + PACE 12 评估器（4 维度）+ Anchor Verifier + Refine/Repair 双管线。本设计取其 **PACE 四维作为 failure_reason taxonomy 骨架**、"可观察性决定可进化性"结论作为健康建议设计依据；**不取其成对执行**（每轮 token 翻倍，生产不可行）、不取其自动编辑。
- **Dynamic Agent Skills 生命周期综述**（arXiv 2607.10113）：8 阶段生命周期（证据采集→提案→验证/准入→存储→检索/组合→维护→蒸馏→治理）与 usage–utility gap 报告——印证本设计"观测优先、准入与验证是薄弱环节"的方向。
- 生产侧（anthropics/skills、openai/skills、smolagents、Voyager）均只提供静态 skill 格式或游戏域自验证；**"使用轨迹驱动的跨 agent skill 观测"在行业仍为空白**，本设计为差异化点。