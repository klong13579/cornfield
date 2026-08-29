---
name: 去 omp 化：oh-my-pi → CornField 改名（standalone 仓库迁移 + v1.0.0 发布）
status: done
objective: 把项目从 omp/oh-my-pi 品牌换为 CornField，standalone 仓库独立，数据目录/命令/环境变量/包名全部对齐，发布正式 v1.0.0
doneWhen: |-
  - standalone 仓库创建并迁移（origin = klong13579/cornfield）✓
  - 代码/包 scope/env/命令名/数据目录全部对齐 cornfield（@cornfield/*、CORNFIELD_*、~/.cornfield）✓
  - check:ts 全绿 + 发布链路可构建（v1.0.0 CI 全绿 + GitHub Release）✓
  - 首个正式版本 v1.0.0 发布（2026-08-29）✓
lastActivity: 2026-08-29 16:45
sessionRefs:
  - by-date/2026-08-29/（v1.0.0 发布会话）
  - by-date/2026-08-25/154042__819aff63
nextAction: ''
artifacts:
  - https://github.com/klong13579/cornfield/releases/tag/v1.0.0（GitHub Release，29 assets）
  - topics/de-omp-mika-rename.md
  - commits: 3f426c75..39853249（29 commits）
decisions:
  - 2026-08-25 — 新项目名 CornField（原方案 mika 已弃）
  - 2026-08-25 — ~/.omp 跟随改名 ~/.cornfield
  - 2026-08-25 — repo 改 klong13579/cornfield standalone
  - 2026-08-25 — 不做 npm 发布，GitHub 全托管（NPM_TOKEN 不配置→publish 步骤自动跳过）
  - 2026-08-29 — 版本号定为 1.0.0（全部公开 API 重新定型，正式发布）
openQuestions:
  - （无）
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
| 2026-08-29 | `bun run check`（tsgo 全 workspace + cargo） | 全绿 |
| 2026-08-29 | `bun scripts/release.ts 1.0.0` | CI 全绿 success |
| 2026-08-29 | `gh release view v1.0.0` | 29 assets（5 平台二进制 + gateway + natives + 桌面 DMG） |
| 2026-08-29 | `gh run view`（native/test/install/release_binary/release） | 全部 success |

## 进度记录

- 2026-08-25 16:00 — topic 创建（mika 方案，drafting）
- 2026-08-29 — TODO 行更新为 CornField 版（P0✓ standalone 已迁）
- 2026-08-29 — 残留清理提交 da4960829a（AGENTS.md/env/DAP/commit prompt/release 正则）+ CI 修复 3985324909（gateway 构建入口指向 packages/gateway）
- 2026-08-29 16:45 — v1.0.0 发布完成：版本全量 1.0.0、CHANGELOG 10 包 finalize、GitHub Release 29 assets、npm 按决策跳过（无 NPM_TOKEN）→ status: done

## 批注

- 发布链路遗留修复：gatewayEntrypoint 死路径 `packages/cornfield-gateway`（目录已 C 档改名 `packages/gateway`）导致 release_binary 5 平台全挂，已修。v0.19.2 是本仓首个 tag，发布构建首次暴露。
- release.ts root catalog 正则旧为 @oh-my-pi（不匹配 @cornfield 键）已修，否则发布不联动 root 版本引用。