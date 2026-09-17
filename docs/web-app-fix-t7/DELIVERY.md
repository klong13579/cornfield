# T7 窄屏主导航可达 — 交付说明

分支 `squad/webapp-fix-t7`。改动范围（仅 scope 内）：

- `packages/web-app/src/layout/MobileNav.tsx`（新增：窄屏主导航入口 + 抽屉）
- `packages/web-app/src/layout/AppShell.tsx`（挂载 `MobileNav`）
- `packages/web-app/src/layout/AppSidebar.tsx`（`SidebarNav` 增加可选 `onNavigate` 收尾回调）
- `packages/web-app/test/diag-narrow-nav.test.ts`（新增）

## 实现思路

桌面侧栏（`AppSidebar` 的 `<nav aria-label="主导航">`）在 `<md`（768px）断点下 `display:none`，
窄屏因此没有任何一级导航入口。新增 `MobileNav`：右上角一个 `md:hidden` 的固定汉堡钮，点开从左
侧滑出的抽屉；抽屉里画的是**同一份**注册表导航（`SidebarAgentContext` + `SidebarNav` +
`getPanelGroups()`），不是另抄一张面板表——加面板仍只改 `router.tsx` 一处。

与工作台会话抽屉（`SessionSidebar`）刻意分开，不互相遮蔽：

- **入口位不同**：主导航入口在右上角（`[342,0 48x48]`），会话抽屉入口在工作台顶栏左上角
  （`[18,10 34x28]`）——见 `390-workspace/nav-390-workspace.steps.txt`。
- **状态独立**：`MobileNav` 自持 `useState`，不复用 `ui.mobileNavOpen`（那是会话抽屉的开关）。
- **层级独立**：入口钮 `z-modal`，会话抽屉展开时工作台右栏（`z-drawer`）滑入也不盖住入口钮
  （见 `390-workspace/nav-390-workspace.steps.txt` 的 `step 7 click @button=打开主导航 → ok`，
  此时会话抽屉仍是展开态）。

## 逐条判据与证据

| 判据 | 实现 | 证据 |
|---|---|---|
| 390 宽从任意一级面板打开主导航并跳转 | 汉堡钮 + 抽屉；`SidebarNav` 的 `onNavigate` 点链接即关抽屉 | `390/nav-390.steps.txt`（12 个面板逐条 `click @button=打开主导航 → ok`，点链接后 `location.hash` 变为目标面板）；12 张 `<panel>-drawer-open.png` |
| 1440 宽导航外观与行为不变 | 入口钮 `md:hidden`（≥768px 即 `display:none`），桌面侧栏不动 | `1440-before` vs `1440-after`：桌面 `nav[aria-label="主导航"]` 计算样式均为 `flex`；before 无入口钮，after 入口钮计算样式 `none`（0x0 不可见） |
| 工作台会话抽屉入口仍可用且两入口不遮蔽 | 入口对角放置 + z-modal 层级 | `390-workspace/nav-390-workspace.steps.txt`：`step 4 click @button=切换会话栏 → ok`（会话抽屉开），`step 7 click @button=打开主导航 → ok`（主导航开，未被右栏盖住）；`workspace-both-entries.png` |
| 键盘可达（Tab 到入口、Enter 打开并使用） | 入口是原生 `<button>`（Enter/Space 原生触发），抽屉内是原生 `<a>`，Escape 关闭 | 单测 `diag-narrow-nav.test.ts`：入口钮是 `<button>`、`aria-expanded`/`aria-controls` 齐全、`onClick` 触发 `onToggle`；`SidebarNav` 每条 `NavLink` 挂 `onClick` |
| 未连接态入口仍可用 | 入口钮无 `disabled`；抽屉「当前 Agent」如实说「未连接」 | 单测：入口钮 `disabled` 为 undefined，`SidebarAgentContext` 渲染「未连接」而非「先选择 Agent」 |

## 面板逐条走查（390 × 844，`390/nav-390.steps.txt`）

每个面板：`goto #/<面板>` → `click @button=打开主导航` → 截 `drawer-open` 图 → `click @link=首页/设置` →
`eval location.hash` 确认落到目标面板。全部 12 个面板 `打开主导航` 均 `ok`，跳转后 hash 正确：

首页、会话工作台、会话记录、Agent 总览、Skills、Memory、Todo、模型、语音、定时任务、用量、设置。

## 复跑命令

```bash
# 门禁
bun run --cwd=packages/web-app check
bun test packages/web-app/test/diag-narrow-nav.test.ts

# 页面证据（dev server 4187 + 采集器）
bun run --cwd=packages/web-app dev --port 4187 --host 127.0.0.1
bun /Users/sz-0203015357/Desktop/Narwal/cornfield/.worktrees/_diag-harness/collect.ts \
  --page '#/' --out <证据目录> --name nav-390 \
  --base http://127.0.0.1:4187 --ws ws://127.0.0.1:7891/ws --view 390x844 \
  --steps docs/web-app-fix-t7/390-steps.json
```
