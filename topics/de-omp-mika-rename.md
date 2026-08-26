---
name: 去 omp 化：oh-my-pi → mika 改名（P0→P4 分阶段执行）
status: drafting
objective: 把项目从 omp/oh-my-pi 品牌换为 mika，发布链路全走 GitHub，数据目录迁移，与官方 repo 彻底断联
doneWhen: |-
  - Repo 改名 klong13579/mika + 远端/tag 清理（P0）
  - 代码：@oh-my-pi → @mika，omp→mika，env PI_*/OMP_* → MIKA_*（P1）
  - check:ts 全绿 + build 出 dist/mika（P1）
  - ~/.omp → ~/.mika 迁移完成，gateway 新名启动，health + inject 回归（P2）
  - 自己 repo 首个 GitHub Release 发布（P3）
  - 全链路验收通过（P4）
lastActivity: 2026-08-25 16:00
sessionRefs:
  - by-date/2026-08-25/154042__819aff63
nextAction: 等用户拍板「做」，从 P0 开始执行
artifacts:
  - local://PLAN.md（完整实施方案 v3）
  - topics/de-omp-mika-rename.md
decisions:
  - 2026-08-25 — 新项目名 mika（米克原子同名）
  - 2026-08-25 — ~/.omp 跟随改名 ~/.mika，写迁移
  - 2026-08-25 — repo 改名 klong13579/mika（做）
  - 2026-08-25 — 不做 npm 发布，GitHub 全托管
  - 2026-08-25 — 包短名保留 pi- 前缀，仅 scope 替换
  - 2026-08-25 — 包名去掉 pi- 前缀（推荐），但先出方案不动手
openQuestions:
  - （无，方案已定稿待拍板）
---

## 设计方案

见 `local://PLAN.md`。核心思路：

1. Phase 0: 远端清理（origin→klong13579、删官方 remote、tag 清理）
2. Phase 1: 代码改名（scope 替换、bin 名、env 名、dir name、docs、npm→GitHub 改造）
3. Phase 2: 数据目录迁移（~/.omp→~/.mika + 绝对路径重写 + 新服务名重启）
4. Phase 3: 发布链路 GitHub-only（fork Actions → 首个 GitHub Release）
5. Phase 4: 验收（binary + gateway + inject + check）

## 参考文档

- `local://PLAN.md` — 完整实施方案 v3
- 本会话讨论记录：版本发布脚本问题排查 → 去 omp 化决策 → 方案定稿

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-25 16:00 — topic 创建

## 批注