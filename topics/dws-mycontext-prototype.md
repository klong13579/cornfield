---
name: 我的 context engineer：数据驱动用户画像供 agent 了解我（me-context skill）
status: done
objective: 用 dws 采集 + forge 测量把彭梦龙的画像（决策记录/风格/人物圈层/关注话题/决策边界）做成 agent 可查的 context，供 agent 干活时更了解他。不以代答分身形式。
doneWhen: |-
  - 真实数据画像产物完成：90 天窗口，决策 28 条 + 风格测量 + 60 人圈层 + 7 个关注 topic——已完成
  - 迁移到统一用户级目录 ~/.omp/agent/skills/me-context/（含 demo 数据）——✅ 2026-08-25 完成
  - 不依赖 gbrain（独立 skill，图形化 dashboard 两级话题分组）——✅ 2026-08-25 完成
  - 用户验收（待用户拍板）
lastActivity: 2026-08-25
lastActivity: 2026-08-18 18:20
sessionRefs: []
nextAction: 等用户验收；若继续：群@数字ID 识别 / 档3 知识结构（轻量图谱）
artifacts:
  - ~/.omp/dws-persona-demo/bridge.py（dws→forge 采集转换，含 agent/bot 排除/信封解包/群@识别）
  - ~/.omp/dws-persona-demo/real/corpus.jsonl（90 天净化语料 14249 条；excludes 1321 条 bot/媒体）
  - ~/.omp/dws-persona-demo/data/persona-config.json + database（forge 语料库，asks 698）
  - ~/.omp/dws-persona-demo/skills/（persona 画像包：SKILL.md + 7 references + rules.json + persona.py）
  - ~/.omp/dws-persona-demo/graph/（档3：graph.json + graph-summary.md 统计层 + facts.md LLM 事实层）
decisions:
  - 2026-08-18 档位定为 2（决策策略）+ L3 判定 demo；窗口 90 天；落盘 ~/.omp/dws-persona-demo/
  - 2026-08-18 群聊统计：仅 @owner 的群消息计入 ask（forge 同款规则）；M- 前缀 agent 账号与 AI小钉 排除；JSON 信封解包
  - 2026-08-18 档3 图谱落地：零 LLM 统计层（人物/话题/时间）+ LLM 事实层（抽样 50 条高信号消息提炼）
  - 2026-08-18 bot/系统账号清单最终化：龙哥bot/hermeskk/云鲸管家/日历助手/云鲸范儿/看板类 全排除（asks 801→698）；@数字ID 纳入 owner 正则（实测零漂移）
openQuestions: []  # 全部完成：档3 图谱（统计层+事实层）✅，群@数字ID（防御性，实测零漂移）✅
---

## 设计方案

**参考对象**：openTrinity/mycontext（已 clone 到 `~/Desktop/Narwal/mycontext`，与 oh-my-pi 平级）

**业务流对照**（MyContext → 我们的 dws 实现）：

| MyContext 层 | 我们用什么实现 | 备注 |
|---|---|---|
| ingest（采集） | dws CLI 拉 chat/calendar/todo/oa，SQLite 落库 + 水位 | 复用 user-distill fetch 思路升级成增量 |
| forge（零 LLM 测量） | Python/Bun 统计：句长/短回复/活跃时段/答复率按 askKind/核心协作者/tone band | 产出 style.md / decisions.md / people.md |
| distill（LLM 抽取） | 模型网关抽取 role/workflow/knowhow | 产出 work.md |
| kl-graph 图谱 | **跳过**（Qdrant/社区检测是重资产，与看效果目标不符） | |
| persona（分身） | 简化判定 demo：风险类→草稿、答复率低→草稿、纯客套→静默 + 起草 | 照抄 12 条降级核心几条，不做 opencode 沙箱 |

**产物模板**：照抄 forge 结构——SKILL.md（六步命令流）+ references/{style,decisions,people,work,limits,fidelity}.md + rules.json（机器可读判据）。模板定义在 `~/Desktop/Narwal/mycontext/vendor/forge/forge/compose.py` 的 render_* 函数和 `vendor/forge/templates/persona/SKILL.md`。

**已验证的环境事实**：node 22.21.0 + pnpm 10.13.1 可用；MyContext 仓库 clone 完整、4900 单测全绿、可打包可启动。dws v1.0.57 二进制在 MyContext 的 resources/bin/ 和 OMP 的 dws skill 依赖里都有。

## 参考文档

- MyContext 源码: `~/Desktop/Narwal/mycontext/`
- forge 产物模板: `~/Desktop/Narwal/mycontext/vendor/forge/forge/compose.py`, `vendor/forge/templates/persona/SKILL.md`
- 采集水位设计: `~/Desktop/Narwal/mycontext/packages/ingest/src/scheduler.ts`
- 数据源字段映射: `~/.omp/agent/skills/user-distill/references/data-sources.md`
- OMP 侧既有技能: `~/.omp/agent/skills/user-distill/`（fetch.py/distill.py 可复用）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| 2026-08-18 17:20 | `python3 bridge.py --days 30` | 30 天基线：5542 条语料，owner 1424 条 |
| 2026-08-18 17:47 | `forge build`（30 天版首次） | asks 272；locale auto 未命中（Han 51.3%）→ 强制 zh-CN |
| 2026-08-18 17:50 | `forge build`（30 天 zh-CN 版） | asks 272→分类生效；11/11 层全测量 |
| 2026-08-18 18:00 | `python3 bridge.py --days 90` | 19843 条原始 → 15570 条，owner 3330 条，285 会话 |
| 2026-08-18 18:06 | forge pull/build（90 天版） | asks 801；风险 8 类全部有实测样本 |
| 2026-08-18 18:12 | `persona.py brief` × 3 真实消息 | status_chase→draft（可答但 autonomy 锁）、other_ask→draft、ack→silent |
| 2026-08-18 18:35 | graph.py（统计图谱） | 476 人网络 / 698 条真实 ask / 话题结构 / 活跃时间 |
| 2026-08-18 18:40 | LLM 事实抽取（抽样 50 条） | facts.md：组织/人事/业务/研发/工作方式 5 组 20 条事实 + 待验证项 |
| 2026-08-18 18:42 | bot 净化重建 | asks 801→698（挤出去 103 条 bot/看板假 ask）；corpus 14249 |

## 进度记录

- 2026-08-25 — 方向修正（用户拍板）：不要分身，构建 context engineer——agent 更充分了解「我」；迁移到统一目录 ~/.omp/agent/skills/me-context/（含 demo），平铺结构、全部路径引用修正、引擎 status 验证通过；dashboard 两级话题分组完成（8 类词表 + 高频具体词 + 会话投入榜，bot/URL 参数噪声过滤）；SKILL.md 定位改为 context 入口（frontmatter name 同步改 me-context）；暂不依赖 gbrain
- 2026-08-18 18:45 — 全部延伸完成：群@数字ID（防御性修正，mention 集零漂移）、档3 知识图谱（统计层 graph.json/summary + LLM 事实层 facts.md）、bot/系统账号净化（asks 698）；待验收
- 2026-08-18 18:20 — L1+L2+L3 全部实测完成：90 天采集、画像产物（风格/决策/关系/图谱 fidelity 11/11 层）、分身判定+起草+自审闭环；待用户验收
- 2026-08-18 18:00 — 扩 90 天 + 群聊统计修复（@owner 精确识别、361 条群 ask 计入）+ JSON 信封解包（1331 条）
- 2026-08-18 17:40 — 真实数据链路开工：dws 登录态确认、bridge 转换器、forge 全链 init/pull/build/publish，30 天基线产物
- 2026-08-18 05:35 — objective 重定义：复刻看效果 → 完整了解使用者 context（用户澄清）；新增「做到什么程度」四档选项待选
- 2026-08-18 05:20 — topic 创建；已完成 MyContext 深度研究（业务流九步 + 潜在问题 + 产物模板分析），方案待用户拍板

## 批注

- 2026-08-25 方向修正（用户原话）：「我并不需要分身的功能，而是需要能让 agent 更充分了解我的功能。构建我的 context engineer」——产物定位从代答分身变为 agent 的上下文供给；两条落地指令：(1) skill 放统一用户级目录含 demo 一起；(2) 暂不依赖 gbrain。dashboard 需求：高频具体话题 + 话题类别分组（已实现两级结构）。
- 用户原话：参考 mycontext 的业务流，使用 dws cli 工具实现它的功能，看下效果。
- 拍板点（方案第 2 步）：范围 L1/L2/L3、数据窗口、落盘位置。用户确认后进入执行。