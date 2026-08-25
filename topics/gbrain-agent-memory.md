---
name: gbrain 接入 agent 共享记忆（dws-persona 决策日志入库）
status: done
objective: 打通 gbrain 作为 omp 多 agent 的共享世界记忆层：dws-persona 提炼的决策记录/关注话题入库 gbrain，agent 可检索引用；retrieval-reflex 教会 agent 何时查脑。
doneWhen: |-
  - 决策记录按月入库 gbrain（decisions/2026-05~08 共 23 条 put 成功，get 读回正常）——✅ 2026-08-25 完成
  - gbrain 语义检索可用（narwal 网关 qwen3.7-text-embedding，query 命中 0.87）——✅ 2026-08-25 完成
  - dws-persona 流水线含同步步骤（sync-to-gbrain.py 一键入库）——✅ 2026-08-25 实跑 5 页
  - retrieval-reflex 官方 v0.1.0 装入 mskills + omp 用户级——✅ 2026-08-25（agent 可用）；doctor 到 ok 需 gbrain serve 常驻（未来项）
lastActivity: 2026-08-25
sessionRefs:
  - -Desktop-Narwal-oh-my-pi/by-date/2026-08-18/235507__183fe295.jsonl
nextAction: （实质工作已完成）剩余可选：gbrain serve 常驻以让 reflex 到 ok（守护进程，未来项）；reranker 切 voyage（ZeroEntropy 9/4 停服）
artifacts:
  - ~/.omp/agent/skills/dws-persona/scripts/sync-to-gbrain.py
  - ~/.omp/agent/skills/retrieval-reflex/SKILL.md（gbrain 官方 v0.1.0，已同步 mskills）
  - gbrain decisions/2026-05~08 + focus/topics-2026-08（5 页）
decisions:
  - 2026-08-25 embedding 定案：narwal 网关 qwen3.7-text-embedding（用户指令「用 narwal-plan 的 embedded 模型试一试」），gbrain 升级 0.46.20→0.46.29，0.46.29 的 openai provider 用标准 OPENAI_API_KEY/OPENAI_BASE_URL env（zshrc 44 行旧无效 key 替换 + 追加 base_url）
  - 2026-08-25 检索性 reflex 接入形态：官方 integration 装到 mskills/skills/ + 同步 omp 用户级；doctor 到 ok 需要 gbrain serve 常驻，记为未来项不阻塞
  - 2026-08-19 mounts 是连接远程团队 gbrain 的机制，本机单脑不需要（修正前期"注册 mount"判断）
  - 2026-08-19 决策记录按月归档 slug（decisions/YYYY-MM），保留演化轨迹而非覆盖同一页
  - 2026-08-19 narwal 网关 87 模型无 embedding 模型（排除该路径）——2026-08-25 已被推翻：网关已加 qwen3.7-text-embedding
openQuestions:
  - reranker：ZeroEntropy 9/4 停服，切 voyage:rerank-2.5 需 VOYAGE_API_KEY（未配置，搁置）
  - gbrain serve 常驻：gateway/omp 侧做守护进程以让 reflex 生效（未来项）
---

## 设计方案

- **分层**（gbrain 官方 brain-vs-memory 约定）：世界知识（决策/人物/公司/会议）→ gbrain；操作偏好 → user.md/write_memory；会话 → 上下文窗口
- **入库路径**：dws-persona 流水线产物 `data/graph/decisions-log.md`（LLM 提炼的决策记录）→ `sync-to-gbrain.py` 按月拆分为 `decisions/YYYY-MM` 页面 → `gbrain put`
- **触发策略**：retrieval-reflex skill（用户级已装）——实体成为话题时先开 brain 页，再回答
- **公司级形态**（后续可选）：多账号 agent 各自独立 session，共享同一脑；Model B（单 source + partners/<slug>/）匹配现 gateway 形态

## 参考文档

- gbrain README/门 docs：RETRIEVAL.md（四层检索 + 图谱）、brain-vs-memory.md（分层原则）、company-brain.md（Model A/B）
- 官方案例：Garry Tan 生产部署（146,646 页 / 24,585 人物 / 5,339 公司 / 66 cron）；中文入门 wlj.me gbrain-intro

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-25 — embedding 打通：narwal 网关 qwen3.7-text-embedding（94 模型里有），gbrain 0.46.20→0.46.29；根因=0.46.29 用标准 OPENAI_API_KEY/BASE_URL env，机器上旧 key 无效；修 zshrc 后 query 语义命中 0.87-0.92
- 2026-08-25 — 决策记录 5 页入库：sync-to-gbrain.py --focus 实跑成功（decisions/2026-05~08 23 条 + focus/topics-2026-08），get 读回 + query 命中验证
- 2026-08-25 — retrieval-reflex 官方 v0.1.0：gbrain integrations install 到 mskills/skills/ + 同步 omp 用户级；doctor: embeddings ok / embedding_provider ok；retrieval_reflex_health 仍 warn（需 serve 常驻）
- 2026-08-19 00:35 — gbrain 升级 0.42.62.0 → 0.46.20.0 完成（gbrain --version），doctor 健康分 70/100，4 项 warn（embedding key 无效 / reranker 供应商停用 / retrieval-reflex 未装 / subagent 非 Anthropic）
- 2026-08-19 00:35 — retrieval-reflex skill 安装到 ~/.omp/agent/skills/，frontmatter 可解析；确认 omp 从该目录扫描加载（builtin.ts:277）
- 2026-08-19 00:35 — sync-to-gbrain.py 写好，dry-run 通过：4 个月决策页（5/6/7/8 月共 23 条）+ 1 个 topics 页
- 2026-08-19 00:35 — 实跑被 embedding 卡住：openai:qwen3.7-text-embedding key 无效，three 端点（openai/dashscope/narwal）均验过，put 拒绝写入
- 2026-08-19 00:40 — dws-persona SKILL.md 补 Phase 4（入库步骤 + --dry-run 预览 + 幂等说明），frontmatter 完整性验证通过
- 2026-08-19 00:40 — 验证入库 blocked：`gbrain doctor` embedding_provider 仍 warn，与 00:35 一致，等待用户拍板 provider

## 批注

- embedding 是当前唯一硬阻塞。dashscope key 有效但账号未开通 embedding 模型；narwal 网关确认无 embedding 模型；OPENAI_API_KEY 是无效 key 配置（config.json 里 provider=openai 但模型是 qwen 系列的错配，且无 base_url）
- 升版过程输出提示"新 skills 待 scaffold"（brain-pdf、voice-note-ingest 等）——未征得用户同意前不装，属后续可选项