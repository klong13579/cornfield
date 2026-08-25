# omp 客户端架构设计 v3

> 状态：**待 review**（2026-08-25）
> 前置：`v2-requirements.md`（需求基线 D1–D16）+ `spike-opensumi-verdict.md`（OpenSumi 底座三轮实证：端到端 ACP 对话达成）
> 关系：v1 = 方案草案、v2 = 需求、**v3 = 架构**（本文档）；架构拍板后进实现排期

---

## 1. 目标架构（一张图）

```
┌──────────────────────────────────────────────────────────┐
│ 客户端壳（单壳收敛 D14 —— OpenSumi 3.9.1-next）             │
│   宿主：Electron（桌面）/ Browser（web 同源）               │
│  ┌────────────────────────┬─────────────────────────────┐ │
│  │ Agent 视图（自定义视图）  │ IDE 视图（Agentic Layout）  │ │
│  │  我的 agent 轻视图        │  文件树/编辑器/Git/终端      │ │
│  │  分域管理（角色注入）      │  Agent Task List + ACP 对话 │ │
│  │  CEO 工作台（跨域事项）    │  diff 审阅/审批卡内嵌        │ │
│  └──────┬─────────────────┴──────────┬─────────────────┘ │
│         │  PiClientAdapter（wire）    │  ACP(stdio)+wire    │
└─────────┼─────────────────────────────┼───────────────────┘
          │ wire (WS/本地)              │ stdio（omp acp）
┌─────────┴─────────────────────────────┴───────────────────┐
│ omp core（内核唯一）                                        │
│  serve 端点（项目会话）  ·  gateway 端点（账号/IM/cron）     │
│  agent/session/技能/记忆/审批/配置 全部归 omp                │
└───────────────────────────────────────────────────────────┘
  钉钉（L0/L1 员工与域 agent 的日常入口，gateway 常驻，独立于壳）
```

核心原则：
- **一个壳**（D14）：所有客户端 UI 收敛到 OpenSumi 工作台；web-app 资产组件化迁入，壳内退役
- **一套风格**（D15）：web-app 设计体系（含动效）覆盖整个壳
- **一份配置**（D16）：omp 配置系统唯一真源，壳不建独立偏好存储
- **内核唯一**：CLI/TUI/壳/钉钉 四前端共享 omp core，改内核四端受益

## 2. 包结构与归属

| 包 | 职责 | 状态 |
|---|---|---|
| **新建 `packages/editor-extension`** | 客户端壳集成层：renderApp 组装（OpenSumi）、自定义视图（Agent 视图）、web-app 风格主题（D15）、配置读写代理（D16）、omp agent 注册 | 新建（命名可调：职责是"客户端壳"不是"编辑器"） |
| `packages/desktop`（改） | Electron 主进程：窗口/托盘/更新/sidecar 拉起（现有机制保留）；renderer 从 web-app 换成 editor-extension | 扩展 |
| `packages/web-app`（迁） | 资产源：组件（ApprovalCard/ClarifyCard/会话/文件浏览）与页面按优先级搬入壳；迁完退役 | 迁移 |
| `packages/pi-wire` / `pi-client`（扩） | 新增 wire 命令（fs_write/fs_edit/fs_diff/git 最小集/配置读写），不破协议 | 扩展 |
| `packages/coding-agent`（小扩） | `omp acp` 已就位；AcpAgent 补 requestPermission 发射（审批）；fs_* 命令服务端实现 + LSP writethrough | 扩展 |
| `packages/omp-gateway` | 钉钉多账号（L0/L1 载体）现状不动 | 不动 |

## 3. 三条数据通路

| 通路 | 形态 | 说明 |
|---|---|---|
| **会话/agent 对话** | IDE 内 = **ACP**（OpenSumi 强制，spawn `omp acp`）；Agent 视图内 = **wire**（PiClientAdapter prompt） | 两类会话都落 omp sessions（追溯台统一）；对话跟场景走（防双面板重复） |
| **文件** | wire `fs_*`：OpenSumi `IFileService` 注册自定义 `FileSystemProvider` 代理到 wire；agent workspace 预览 = `omp-agent://` scheme（只读，授权后写，D5） | 阶段 0 先补 fs_write/fs_edit/fs_diff |
| **配置** | omp 配置（config.yml/models.yml/agentDir）唯一；IDE 设置面板经 wire 配置命令读写代理；OpenSumi 偏好持久化关闭（D16） | 集成期核对现有配置命令面，缺则新增 |

## 4. 壳内视图清单（Agent 视图）

按 D14 用 OpenSumi 官方机制（`LayoutService.collectTabbarComponent` 动态注册 + `TabbarHandler` 控制），角色化注入：

| 视图 | 角色 | 注册方式 |
|---|---|---|
| 我的 agent 轻视图（状态/知识库/画像/任务/对话） | 员工 | 侧栏容器，默认激活 |
| 分域管理（域 agent + 域内员工明细） | 域负责人 | 按账号角色动态注入 |
| CEO 工作台（域级战报 + 跨域事项 → 下钻） | CEO | 按账号角色动态注入 |
| 会话/审批卡（复用 web-app ApprovalCard 等） | 全角色 | 组件直接 import 进视图 |

机制依据（官方文档已读）：`custom-view` / `custom-config` / `layout.zh.md`——插槽 + ComponentContribution + LayoutService 动态注册 + TabbarHandler 全套现成。

## 5. 主题与 UI（D15）

- 自定义 OpenSumi 主题对齐 web-app 设计 token（色彩/字体/间距/圆角）
- web-app 组件（Tailwind 样式）随 import 带入，动效随组件继承
- OpenSumi 自带 chrome（菜单栏/活动栏/面板）用主题覆盖为 web-app 风格
- **机制已验证**（packages/theme 源码）：主题 = `IThemeContribution`（label/path/extensionId）注册的 color-token JSON 文件（含 textMateRules 语法色）——把 web-app 设计 token 映射成 theme JSON 即可；token 系统完备（base/chat/scrollbar 等分域 color-token 已存在）

## 6. 配置统一（D16）

- omp 配置为唯一真源：`~/.omp/agent/config.yml`、`models.yml`、agentDir（mission.md/AGENTS.md/TOOLS.md/prompt-includes.json）
- OpenSumi 偏好：仅作 IDE 侧视图状态（布局/面板开关等瞬时态）；持久化可用 `preferenceDirName` / `userPreferenceDirName` 系列重定向（官方配置项，custom-config 文档已证），平台设置不落 OpenSumi 偏好
- 设置 UI：IDE 设置面板读写 omp 配置（经 wire 配置命令），不产生第二份平台配置
- **wire 命令面已验证**：现有仅分散写命令（`set_skill_enabled` / `set_model_disabled` 直写 config.yml），**无通用配置读写命令** → 阶段 0 新增 `get_config` / `set_config`（settings 域命令），供设置面板与将来所有前端复用

## 7. 集成点清单（spike 实证 + 决策）

| # | 集成点 | 来源 | 状态 |
|---|---|---|---|
| 1 | 版本锁定 `3.9.1-next-1787303337.0`（ACP 只在 next 通道） | spike | 已锁 |
| 2 | omp agent 注册：`ai.native.agent.defaultType` + `ai-native.acp.agents` 正规配置（不用 spike 的 provider patch） | spike 绕弯 1 | 实现期 |
| 3 | workspace 传递：`?workspaceDir=` / WORKSPACE_DIR 对齐（无工作区则 ACP 不预热） | spike 绕弯 2 | 实现期 |
| 4 | 短 TMPDIR（watcher unix socket 路径上限）+ 换默认 agent 需重启 node server（线程池 agent 绑定） | spike 绕弯 3 | 实现期 |
| 5 | monaco editor worker 本地化（next 版本 CDN 404） | spike | 实现期 |
| 6 | `fs_write` / `fs_edit` / `fs_diff` wire 命令 + LSP writethrough | 需求/阶段 0 | 未做 |
| 7 | OMP AcpAgent 补 `requestPermission` 发射（审批卡内嵌前置） | 需求 | 未做 |
| 8 | 自定义主题（D15） | 决策 | **已验证**：IThemeContribution + color-token JSON |
| 9 | 偏好持久化改道（D16） | 决策 | **已验证**：preferenceDirName 系列重定向 + wire 需补通用配置命令 |
| 10 | Electron 原生模块重建流程（node-pty/spdlog/keytar/watcher + electron 二进制，yarn install 后必跑） | spike 环境清单 | 文档化 |
| 11 | Node16 polyfill（streams/undici）已入探针，正式壳若升级 Electron（≥28）则不需要 | spike | 视 Electron 版本 |

## 8. 阶段计划（含验收）

| 阶段 | 范围 | 验收 |
|---|---|---|
| **阶段 0：wire 地基（~2-3 周）** | fs_write/fs_edit/fs_diff + LSP writethrough；git 最小集（status/diff/log/show/branches）；**新增 get_config/set_config 通用配置命令** | `bun test` 相关用例绿；PiClientAdapter 可调新命令；fs_write 后 LSP 状态不丢；配置命令读写 config.yml 往返一致 |
| **阶段 1：壳搭建（~3-4 周）** | editor-extension 包（OpenSumi 组装 + 主题 + 视图骨架）；omp agent 正规注册；文件服务接 wire（agent workspace 预览）；集成点 1-5 落地 | 壳能起；打开项目；IDE 里与 omp agent 真实对话（spike 已验证路径）；agent workspace 只读预览出文件树 |
| **阶段 2：Agent 视图差异化（~3-4 周）** | 我的 agent 轻视图 / 分域管理 / CEO 工作台（角色注入）；web-app 组件迁入（审批卡/会话/技能/记忆） | 三角色登录各自视图正确；审批卡在壳内可渲染 |
| **阶段 3：审批 + Git（~2-3 周）** | AcpAgent 补 requestPermission；IDE diff 审阅接受/拒绝；git 面板 UI | 审批决策两端一致；diff 审阅闭环 |
| **阶段 4：收尾（~2-3 周）** | Electron 打包（环境清单）；web-app 退役判定（剩余页面归档）；性能/首屏 | 桌面安装包可跑；web 同源可访问 |

总账：约 12-17 周（与 v1 估算 9-12 周同量级，含单壳迁移增量）。

## 9. 风险与开放项

| 项 | 风险 | 处置 |
|---|---|---|
| OpenSumi 版本跟随 | ai-native 迭代快（ACP 还在演进），next 通道不稳定 | 锁快照 + 升级走单独评审；stable 出 ACP 后评估切换 |
| 单壳迁移工程量 | web-app 存量页面（voice/insights/records 等） | 按价值排序，可归档的归档；迁移期间 web-app 只读保留 |
| D15 主题机制 | 未验证 ThemeContribution | ✅ 已验证：IThemeContribution + color-token JSON 文件注册 |
| D16 偏好改道 | 未验证偏好持久化关闭路径 | ✅ 已验证：preferenceDirName 重定向；平台设置走 wire 配置命令（需新增 get_config/set_config） |
| 研发 IDE 与 Agent 视图对话双协议 | ACP（IDE）vs wire（Agent 视图）并存 | 对话跟场景走原则 + 会话数据统一落 omp sessions |
| Electron 版本 | 探针基于 Electron 22（老），正式壳建议 ≥28（免 polyfill） | 架构期定 Electron 版本 |

## 10. 文件

| 文档 | 状态 |
|---|---|
| `v1-synthesis.md` | 方案草案（历史，借鉴来源） |
| `v2-requirements.md` | 需求基线（D1–D16，拍板） |
| `spike-opensumi-verdict.md` | 底座实证（三轮，含集成点清单） |
| **`v3-architecture.md`（本文件）** | 架构设计（待拍板） |
