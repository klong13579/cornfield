# OMP 桌面客户端 · Zed 深嵌集成 — 需求 Spec（本地）

> to-spec 产物（本地发布，非 issue tracker）· 2026-08-21
> 输入：`docs/omp-client-zed-integration.md`（实施蓝图）+ 全部源码验证（Zed main@10b2925e7c、gpui_macos 源码实证）
> 状态：**待用户确认 seams 与拍板项后转 ready-for-agent**

---

## Problem Statement

OMP 的 webapp（数字员工控制台 + agent 工作台）需要一个**程序员编辑器**作为原生体验的一等公民：程序员在代码里干活时，数字员工（agent）应该就在编辑器旁边，而不是切到浏览器。此前两条路径均被验证不适合直接投产：

1. **webapp 内嵌浏览器 IDE**（OpenSumi/Monaco + iframe，spike 已跑通）——形态验证过半，但完整 IDE 能力靠自建壳或 OpenSumi contribution 体系，编辑器体验远不如本地原生（终端/git/性能/快捷键），且浏览器沙箱与本地文件系统隔了一层。
2. **现有 Electron 壳**（`packages/desktop`，已投产：更新流/签名/dmg 打包/worker sidecar 全闭环）——Electron 窗口是 Chromium 独占，**无法单窗口内嵌原生编辑器视图**（GPUIView 嵌入需 hack，Electron 升级脆弱）。

用户决策：**直接做桌面客户端，把开源 Zed 深嵌进 OMP 客户端**（单窗口单 app，不是两个客户端），复用 OMP 现有全部资产（webapp / worker / agent 内核）。

## Solution

**Zomp**：fork Zed（GPL-3.0 接受，改动仅限 agent 挂点与窗口嵌入层，编辑核心零改动），作为 OMP 桌面的编辑器组件；OMP 用**原生壳**（AppKit 容器）承载两个常驻视图，顶部 `[Agent | IDE]` 切换：

- **Agent 模式（默认）**：整窗 = WKWebView 跑现有 `packages/web-app`（数字员工控制台，零重写）
- **IDE 模式**：整窗 = GPUIView（Zed fork 编辑器，NSView 嵌入原生壳 contentView）
- 两 view 常驻，切换 = hide/show swap（会话/编辑状态互不丢失）
- **worker sidecar**：`packages/desktop/src/sidecar.ts` 逻辑平搬到原生壳（spawn `omp serve` :7891）
- **更新链**：借用 Zed fork 自带 auto-update（改 endpoint），不重做 electron-builder 打包
- **agent 集成面**（由浅入深）：ACP external agent（已验收）→ MCP/context server → fork 内深挂点（⌘K/审批卡/侧栏）

**已证实的可行性依据**：
- `gpui_macos/src/window.rs:1009-1020`：GPUIView 是标准 NSView 子类，创建路径与 NSWindow 解耦 ⇒ 可挂宿主 view（B 的地基）
- 改动面集中：gpui embedded 模式（~200 行）+ `zed/src/main.rs:126` 启动触点（一处）+ 壳层

## User Stories

1. 作为程序员，我打开 OMP.app 即进入数字员工控制台（与现有 webapp 完全一致），零学习成本。
2. 作为程序员，我点击顶栏 `IDE`（或 ⌘2）即切换到完整 Zed 编辑器（文件树/tab/终端/git/调试），编辑器体验与原生 Zed 无差别。
3. 作为程序员，我在 IDE 里选中代码并唤起 agent（ACP 面板），agent 的对话、工具执行、diff 审阅在同一窗口内完成，不用切 App。
4. 作为程序员，切换 Agent/IDE 后两边状态保持（webapp 会话不丢、编辑器缓冲区/未提交改动不丢）。
5. 作为数字员工管理者，我在 Agent 模式里管理 agent/会话/技能/MCP/语音（现有 webapp 全部能力不因桌面包装而损失）。
6. 作为用户，OMP.app 是唯一的 dock 条目（单 app），Zed 不产生独立窗口/图标。
7. 作为用户，我看到一个统一状态栏：worker 在线、agent 在线数、git 分支（右侧依赖 IDE 模式打开项目）。
8. 作为用户，OMP.app 更新走实例化更新（下载进度/手动重启安装），与现有 desktop 更新体验一致。
9. 作为用户，深色/浅色主题在 Agent 与 IDE 模式间保持一致（webapp CSS 变量 ↔ Zed 主题映射）。
10. 作为程序员，IDE 模式无项目打开时显示欢迎视图（最近项目 + 打开文件夹），与 Cursor/Zed 行为一致。
11. 作为开发者，Zomp 的 fork 定制区（gpui embedded/启动触点/品牌）与上游保持可同步（季度 rebase 兼容）。
12. 作为 OMP 维护者，webapp 与 worker 的 CI/测试/发布链路不因桌面壳变化而破坏（壳改动隔离在 `packages/desktop` 替代产物内）。

## Seams（测试接缝，按优先级）

1. **P0 embedded spike（最高 seam，最先验证）**：裸 AppKit NSWindow + GPUIView 渲染 Zed workspace + 键盘事件 + **display link 功耗实测**（隐藏窗口空转帧）。验证失败项决定形态降级（A 窗口级）。
2. **view swap 生命周期**：Agent ⇄ IDE 切换 N 次后两边状态完整（webapp 会话、Zed 缓冲区）；切换耗时 < 300ms。
3. **sidecar 平搬连通**：原生壳 spawn `omp serve` → webapp pi-wire 连通（复用 SPIKE-4 的 ws 验证法）。
4. **ACP 挂点注册**：Zomp 内置 OMP ACP agent（agent_servers 配置）→ Zed agent 面板对话走通。
5. **更新链**：Zomp updater 改 endpoint 后，dmg/zip 产物可安装、可自动更新、adhoc 签名验证通过。

## Open Questions（待拍板，spec 固化为 TBD 不阻塞 P0）

- [ ] P0 spike 是否开跑（1-2 周，可先于专职 Rust 立项）
- [ ] fork 仓库形态：独立 repo `zomp`（推荐，打包产物层集成）vs monorepo 子目录
- [ ] 上游同步：季度 rebase vs 冻结（推荐季度 rebase + 定制区独立 feature）
- [ ] 旧定稿文档状态（Tauri 窗口级）标记 superseded
- [ ] 专职 Rust 人选（F1 账：P0 先探，确认后立项）

## 验收草案（doneWhen）

- P0：GPUIView 在宿主 NSWindow 渲染 Zed 工作区，键盘/鼠标可用，功耗可接受（空转 ≤ 显式停止策略成立）
- P1：OMP.app 单图标启动 = 完整 Zed 编辑器可用（embedded 稳定 + sidecar 拉起 + 更新链通）
- P2：顶部 Agent/IDE 切换 + webapp 面板 + ACP agent 对话走通
- P3：fork 深挂点（⌘K inline / 审批卡 / 数字员工侧栏）上线