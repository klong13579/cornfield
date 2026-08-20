---
name: OMP 桌面客户端：主 app（Tauri）+ 编辑器（fork Zed）
status: waiting           # 设计定稿未开工，等待开工指令与遗留决策闭合
objective: 把 OMP 做成桌面客户端套件——OMP 主 app（数字员工控制台，Tauri 壳 + web-app 主体）+ OMP 编辑器（fork Zed，agent 挂点），worker 内核共享，先内部后对外
doneWhen: |-
  - 待补充（开工时补验收契约：主 app 可分发 + 编辑器 Phase 1 挂点可用）
lastActivity: 2026-08-20 19:00
sessionRefs: []
nextAction: 开工前闭合 5 个遗留决策（产品名/Linux 包格式/上游同步策略/专职 Rust 人选/对外 GPL 法务确认）
artifacts:
  - docs/omp-client-design.md   # 设计文档（定稿）
  - tmp/omp-ide-mock.html       # UX mock（可交互）
decisions:
  - 2026-08-20 — 主从结构 B：OMP 为主 app（Tauri），Zed fork 为编辑器子项目/独立窗口（推翻早期"Zed 当宿主塞 webview"方案）
  - 2026-08-20 — fork Zed（GPL-3.0 接受），改动仅限 agent 挂点，编辑核心不动；VS Code(MIT) 为换路预案
  - 2026-08-20 — worker 独立本机服务，所有 UI 走统一 pi-wire 管道（浏览器/钉钉/桌面共享 worker）
  - 2026-08-20 — 平台 macOS + Linux 起步；分发 GUI→DMG/.deb，CLI/worker→npm+二进制不动
  - 2026-08-20 — Zed fork 独立 repo，与 OMP monorepo 在打包产物层集成
openQuestions:
  - 产品名/品牌（Zed 商标规避）
  - Linux 包格式（.deb/.AppImage，看团队发行版分布）
  - fork 上游同步策略（季度 rebase vs 冻结）
  - 专职 Rust 维护者人选（50 人团队无编辑器工程师）
  - 对外时点 GPL 法务确认（worker 进程隔离的衍生作品边界）
---

## 设计方案

完整设计见 `docs/omp-client-design.md`（定稿，未开工）。要点：

- **定位**：先内部（数字员工控制台 + coding IDE），后对外（架构预留）
- **结构**：OMP 主 app（Tauri 壳，web-app 为主体，worker sidecar）+ OMP 编辑器（fork Zed，GPUI，只加 agent 挂点：Chat 面板/⌘K inline edit/审批卡/终端 agent）
- **功能分期**：Phase 0 主 app → Phase 1 Cursor 基线（chat/agent mode/inline diff/审批）→ Phase 2 数字员工差异化（多 agent/身份绑定/cron 侧栏/学习沉淀）
- **身份域**：公司域（gateway 钉钉员工）与项目域（IDE workspace 内 agents）分离，共享 worker 内核
- **红线**：统一 pi-wire 管道；worker 不感知 UI；Zed fork 编辑核心零改动

## 参考文档

- `docs/omp-client-design.md` — 设计文档（11 条决策记录 + 功能规格 + 风险账本 + 开工顺序）
- `tmp/omp-ide-mock.html` — UX mock（IDE/Agent 双模式示意；主从结构调整前的版本，交互形态以设计文档为准）
- grilling 会话（2026-08-20）+ cross-modal review（GLM-5.3，F1–F5 发现项已吸收）

## 验收情况

| 时间 | 验证命令 | 结果 |
|---|---|---|
| - | - | - |

## 进度记录

- 2026-08-20 19:00 — topic 创建；设计文档定稿落 `docs/omp-client-design.md`，明确不开工（用户指令"落成设计文档，但是不开工"）
- 2026-08-20 18:50 — grilling 会话完成 11 项决策（含 3 次方向反转：单 app→套件 B、Tauri 废→复活、Zed 宿主→编辑器子项目）
- 2026-08-20 18:30 — UX mock 产出 `tmp/omp-ide-mock.html`（可交互，双模式截图已验证渲染）

## 批注

- 设计过程中用户两次关键纠偏：(1) IDE 与 gateway agent 无关，应按代码项目组织；(2) OMP 才是主，web-app 和 Zed 是子项目。第二次纠偏直接推翻"Zed 当宿主"方案，砍掉最大技术风险（webview 嵌入）。
- F1（fork Zed 组织账：需 1–2 专职 Rust 工程师）是开工前必须回答的第一问。
