---
name: gbrain 接入 agent 共享记忆（dws-persona 决策日志入库）
status: waiting
objective: 打通 gbrain 作为 omp 多 agent 的共享世界记忆层：dws-persona 提炼的决策记录/关注话题入库 gbrain，agent 可检索引用；retrieval-reflex 教会 agent 何时查脑。
doneWhen: |-
  - 决策记录按月入库 gbrain（`gbrain put decisions/YYYY-MM` 成功，`gbrain get decisions/2026-05` 可读回）
  - `gbrain doctor` 中 `retrieval_reflex_health` 变 ok（policy skill 已装 + embedding provider 可用）
  - dws-persona 流水线含同步步骤：`sync-to-gbrain.py` 可一键入库，SKILL.md 记录该步骤
lastActivity: 2026-08-19 00:40
sessionRefs:
  - -Desktop-Narwal-oh-my-pi/by-date/2026-08-18/235507__183fe295.jsonl
nextAction: 用户拍板 embedding provider（三条路见 openQuestions）→ 实跑 sync-to-gbrain.py 入库 → 验证 gbrain get/search 可读回
artifacts:
  - ~/.omp/agent/skills/dws-persona/scripts/sync-to-gbrain.py
  - ~/.omp/agent/skills/retrieval-reflex/SKILL.md
decisions:
  - 2026-08-19 mounts 是连接远程团队 gbrain 的机制，本机单脑不需要（修正前期"注册 mount"判断）
  - 2026-08-19 决策记录按月归档 slug（decisions/YYYY-MM），保留演化轨迹而非覆盖同一页
  - 2026-08-19 narwal 网关 87 模型无 embedding 模型（排除该路径）
openQuestions:
  - embedding provider 选哪条：本地 ollama 拉 bge-m3（免费/离线/约 1.2GB）｜阿里云百炼开通 text-embedding-v3｜禁用 embedding 仅关键词
  - dws-persona SKILL.md 何时补 Phase 4 入库说明（脚本已就绪，等 embedding 通后一并写）
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

- 2026-08-19 00:35 — gbrain 升级 0.42.62.0 → 0.46.20.0 完成（gbrain --version），doctor 健康分 70/100，4 项 warn（embedding key 无效 / reranker 供应商停用 / retrieval-reflex 未装 / subagent 非 Anthropic）
- 2026-08-19 00:35 — retrieval-reflex skill 安装到 ~/.omp/agent/skills/，frontmatter 可解析；确认 omp 从该目录扫描加载（builtin.ts:277）
- 2026-08-19 00:35 — sync-to-gbrain.py 写好，dry-run 通过：4 个月决策页（5/6/7/8 月共 23 条）+ 1 个 topics 页
- 2026-08-19 00:35 — 实跑被 embedding 卡住：openai:qwen3.7-text-embedding key 无效，three 端点（openai/dashscope/narwal）均验过，put 拒绝写入
- 2026-08-19 00:40 — dws-persona SKILL.md 补 Phase 4（入库步骤 + --dry-run 预览 + 幂等说明），frontmatter 完整性验证通过
- 2026-08-19 00:40 — 验证入库 blocked：`gbrain doctor` embedding_provider 仍 warn，与 00:35 一致，等待用户拍板 provider

## 批注

- embedding 是当前唯一硬阻塞。dashscope key 有效但账号未开通 embedding 模型；narwal 网关确认无 embedding 模型；OPENAI_API_KEY 是无效 key 配置（config.json 里 provider=openai 但模型是 qwen 系列的错配，且无 base_url）
- 升版过程输出提示"新 skills 待 scaffold"（brain-pdf、voice-note-ingest 等）——未征得用户同意前不装，属后续可选项