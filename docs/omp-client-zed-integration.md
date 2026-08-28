# CornField 桌面客户端 — Zed 深嵌实施蓝图（B'）

> 状态：方案待拍板（2026-08-21，源码验证闭环后；2026-08-21 UX 修订：顶部 Agent/IDE 模式切换替代左右分栏）
> 关联：`topics/omp-client-design.md`（定稿 B：Tauri 壳 + Zed 窗口级）被本蓝图的 **B'：原生壳 + Zed 视图深嵌** 深化替换
> 源码依据：Zed main @10b2925e7c（243 crates），`gpui_macos/src/window.rs` 源码实证

## 1. 目标形态（单窗口单 app · 顶部模式切换）

```
┌─────────────────────────────────────────────────────┐
│ CornField  ◉ [ Agent | IDE ]        ● worker 在线 · 设置   │ ← 顶部常驻切换栏（⌘1/⌘2）
├─────────────────────────────────────────────────────┤
│  Agent 模式（默认进入）          IDE 模式             │
│  整窗 = WKWebView(webapp)  ⇄   整窗 = GPUIView(Zed)  │
│  数字员工控制台                  文件树/tab/终端/git/  │
│  会话/Agents/技能/MCP/语音       agent 面板（ACP）    │
├─────────────────────────────────────────────────────┤
│ 状态栏：worker 状态 · agent 在线数 · git 分支          │
└─────────────────────────────────────────────────────┘
  · 两 view 常驻，切换 = hide/show swap（状态互不丢失，非销毁重建）
  · 无左右分栏/分隔条/拖拽 —— 壳层布局最简
```

- 默认进入 Agent 模式（现有 webapp 使用习惯零变化）
- 视图切换在原生 NSWindow.contentView 内 swap 两个标准 NSView（WKWebView + GPUIView），无 Chromium 混排风险
- 壳选择：Zomp 原生壳（AppKit 容器）；Electron 壳不适用（GPUIView 嵌 Electron 窗口需 hack）——
  现有 `packages/desktop` 的 worker sidecar 逻辑平搬，webapp 资产经 WKWebView 零重写，更新体系借 Zomp 自带 updater

## 2. Fork 改造：Zomp（Zed + CornField 挂点）

### 2.1 gpui 嵌入式窗口模式（B 的地基，已源码证实可行）
- **证据**：`gpui_macos/src/window.rs:1009-1020` —— `GPUIView`（NSView 子类，带 keyDown/mouseDown/绘制 display link）单独 `alloc + initWithFrame` 后手动装进 `NSWindow.contentView`。view 与 window 解耦 ⇒ 可挂任意宿主视图。
- **改动**：
  - `WindowOptions` 加 `embedded_in: Option<NSView>`（或专用 `WindowBounds::Embedded` 变体）
  - embedded 模式：跳过 `GPUIWindow` 创建（或建隐藏窗口仅作容器），`GPUIView` 挂宿主 view + frame 跟随宿主布局
  - 事件：`window.makeFirstResponder(GPUIView)`（嵌入宿主后焦点移交）
  - 绘制：display link 已是 view 级驱动；「宿主窗口无窗口时是否空转」需验证（macOS CVDisplayLink 与窗口解耦，隐藏窗口积极绘制可能耗电——实测项）

### 2.2 zed 启动层
- `zed/src/main.rs:126` 唯一窗口创建调用点：支持 `--embed` 模式（Zomp 壳启动 Zed 渲染时传宿主 view 标识/由壳直接调用库函数）
- 品牌：bundle id / 图标 / 应用名（CornField）——Zed GPL-3.0 fork 可改名（Apache 部分双 license）

### 2.3 CornField agent 挂点（编辑器体验层）
- 集成面按「由浅入深」：
  1. **Zed 原生 ACP/agent 面板**（已完成验收）：CornField worker 作为 ACP external agent —— agent 对话在 Zed 原生面板
  2. **MCP/context server**：CornField 技能/工具经 MCP 暴露给 Zed Agent
  3. 深挂点（phase 2+，fork 内定制）：CornField 面板作为 Zed 侧栏 view（复用 agent 面板结构）、⌘K inline 集成、审批卡——**这些是 fork 的核心定制区**
- 面板 UI 取舍：**CornField 面板 = WKWebView 跑现有 webapp**（零重写、React 资产全保留）vs gpui 原生化（性能/观感统一，但 F1 账翻倍）——推荐前者起步

## 3. 壳与进程模型

| 层 | 定案 | 备注 |
|---|---|---|
| 壳栈 | **AppKit/SwiftUI 容器**（NSWindow + contentView），左右子 view：WKWebView（CornField 面板）+ GPUIView（编辑器） | AppKit 原生可嵌入任意 NSView；SwiftUI 可桥接 |
| CornField 面板 | WKWebView → 现有 `packages/web-app`（React），wire over WS→worker | webapp 全部资产零重写 |
| 通信 | CornField 面板 ⇄ worker：wire（现状）；worker ⇄ 编辑器：ACP/MCP（现状路径）；壳 ⇄ 两者：本地进程管理 | |
| worker | sidecar 进程（CornField 内核，serve 模式），壳管理生命周期 | |
| 分发 | 单 .app（Zomp.exe/.app），worker 内嵌资源或并存 | |

## 4. 分阶段计划

| 阶段 | 内容 | 周期 | 验收 |
|---|---|---|---|
| **P0 spike** | 最小 embedded 验证：裸 AppKit 窗口 + GPUIView 显示 + zed workspace 打开 + 键盘/绘制正常 + 功耗 | 1-2 周（1 人 Rust） | GPUIView 在宿主窗口渲染 Zed UI，事件可用 |
| **P1 Zomp 壳** | embedded 稳定（first responder/布局/多窗口）、zed 启动集成、品牌（图标/名/dock 单图标）、worker sidecar 拉起 | 2-4 周 | 单 app 启动 = 完整 Zed 编辑器可用 |
| **P2 CornField 面板** | WKWebView 面板 + 布局分栏（可拖拽）+ 数字员工控制台（webapp）+ wire 打通 + ACP agent 注册 | 2-3 周 | 左面板会话/管理，右编辑器，agent 对话走通 |
| **P3 差异化** | fork 内定制：CornField 侧栏（身份/cron/多 agent）、⌘K 挂点、审批卡、学习沉淀注入 | 3-5 周 | 定稿 Phase 2 数字员工能力上线 |
| 合计 | | ~2.5-3.5 月（1-2 专职 Rust + web 侧复用现有） | |

## 5. 风险账本（新）

| 风险 | 等级 | 缓解 |
|---|---|---|
| display link 功耗（嵌入后空转帧） | HIGH | P0 实测；不可接受则加窗口不可见暂停 |
| first responder/键盘焦点冲突（webview vs gpui view） | MED | P0/P2 各验证一次 |
| Linux/Windows embedded 支持 | MED | gpui_linux 有类似模式 [inference]；起步只保 macOS |
| 上游同步（Zed main 日更） | MED | 季度 rebase 窗口 + 自定义区独立 crate/feature |
| GPL-3.0 合规（worker 进程隔离边界，定稿已评估） | LOW | 维持进程边界论证 |
| F1 人力（1-2 专职 Rust） | MED | P0 确认后立项定人 |
| webview ↔ native 混排观感（滚动/圆角/暗色） | LOW | 壳层样式统一 |

## 6. 待拍板决策

1. **壳栈**：AppKit+SwiftUI（推荐，webapp 零重写）？还是 gpui 全原生化（观感统一，Rust 人力翻倍）？
2. **P0 是否开跑**（需要 1 名 Rust 人手，或我先丢一个 spike 分支验证）？
3. **fork 仓库形态**：独立 repo（`zomp`）打包产物层集成（定稿已定）？
4. **上游同步**：季度 rebase vs 冻结？
5. 旧定稿（Tauri + Zed 窗口级）文档/topic 标记状态？