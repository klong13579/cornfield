# OMP 桌面客户端设计文档

> 状态：**已废弃（2026-08-21）** · Tauri 双窗口方案被**单窗口 Zomp 方案**取代：
> 单 app 单窗口，顶部 [Agent | IDE] 模式切换，AppKit 原生壳内嵌 Zed（GPUIView），
> 不再用 Tauri 壳 + 独立编辑器窗口。当前方案见 `docs/omp-client-zed-integration.md`。
> 本文档留档，勿按此开工。
> 原始状态：**设计定稿，未开工** · 日期：2026-08-20 · 来源：grilling 会话（cross-modal review：GLM-5.3）
> 产品代号：MyOMP（内部叫法，未定名）

---

## 0. 一句话

把 OMP 从"终端 + 浏览器 + 钉钉"做成**桌面客户端套件**：OMP 主 app（数字员工控制台）+ OMP 编辑器（fork Zed），worker 内核共享，为对外商业化预留架构。

## 1. 产品定位

- **先内部**：米克原子 50 人团队的数字员工控制台 + coding IDE
- **后对外**：架构按商业产品预留（授权、更新、分发、多平台），不提前投入发布工程
- **竞争判断**：编辑层（光标/buffer/LSP）不是差异化——红海且无胜算；差异化全打在 agent 层（多数字员工/审批/cron/记忆/学习沉淀），这是 OMP 已验证资产的独有位面

## 2. 顶层架构（决策 B：OMP 为主，Zed 为工具）

```
┌─────────────────────────────────────────────────────────┐
│                    OMP 客户端套件（同一 dock 图标）          │
│                                                         │
│  ┌──────────────────┐        ┌──────────────────────┐  │
│  │  OMP 主 app       │        │  OMP 编辑器窗口        │  │
│  │  （Tauri 壳）      │ 打开项目 │  （fork Zed，GPUI）    │  │
│  │                  │ ──────→ │                      │  │
│  │  · web-app 主体    │        │  · Zed 编辑底盘（白拿）  │  │
│  │  · Agent/管理界面   │        │  · Chat 面板（GPUI）    │  │
│  │  · worker 管理     │        │  · ⌘K / inline diff   │  │
│  │  · 托盘/自更新      │        │  · 审批卡 / 终端 agent  │  │
│  └────────┬─────────┘        └──────────┬───────────┘  │
│           │       pi-wire（WS，统一管道）  │              │
│           └──────────────┬──────────────┘              │
│                          ▼                             │
│              ┌───────────────────────┐                  │
│              │  worker（本机服务）      │                  │
│              │  = OMP agent 运行时     │                  │
│              │  25+ 工具 / 会话 / 记忆   │                  │
│              │  / 技能 / self-evolution │                  │
│              └───────────────────────┘                  │
│     浏览器（现状保留）· 钉钉（gateway，现状保留）             │
└─────────────────────────────────────────────────────────┘
```

**主从关系（关键纠偏）**：OMP 是主体（worker + web-app + 品牌 + 协议主干），Zed fork 是"代码编辑能力"子项目，是 worker 的又一个客户端（与浏览器、钉钉并列）。**不是**"Zed 里嵌 OMP"。

**两个身份域，共享 worker 内核**：
- **公司域**（gateway 管的）：hr / finance / ops 等钉钉数字员工，全局身份
- **项目域**（IDE 管的）：测试工/前端工/文档工等，按代码项目（workspace）组织，会话随项目
- IDE 直连 worker（serve），与 gateway 互不相干

## 3. 决策记录（grilling 全链路）

| # | 决策点 | 结论 | 关键理由 / 被否方案 |
|---|---|---|---|
| 1 | 产品定位 | 先内后外（C） | 内部痛点真实（数字员工日常）；对外预留架构不提前投入 |
| 2 | 主从结构 | **B：OMP 主 app + Zed 编辑器独立窗口** | OMP 是主，Zed 是工具；"Zed 塞 web-app"主从颠倒且背最大技术风险 |
| 3 | 进程模型 | 分离进程（B） | worker 复用现有 gateway/serve；崩溃隔离；浏览器/钉钉/桌面共享同一 worker |
| 4 | 主 app 壳 | Tauri 2 | Rust 与 Zed fork 同栈；~10MB vs Electron 100MB+；sidecar 官方支持托管 worker 二进制。Electron 唯一优势（VS Code 生态）在定 Zed 后不成立 |
| 5 | 编辑器基座 | fork Zed（GPL-3.0，接受） | Rust 原生性能 + GPUI；VS Code(MIT) 记为换路预案；Lapce 停滞弃用 |
| 6 | fork 改造边界 | 只做 agent 挂点，编辑核心不动 | 控制 GPL fork 维护账；改动限于：Chat 面板（GPUI）、⌘K/inline diff、审批卡、pi-wire 客户端、换品牌 |
| 7 | 入口形态 | 主窗口=Agent/管理；点项目开编辑器窗口 | 覆盖早期决策"单 app 模式切换"——双窗口套件，同一 dock 图标 |
| 8 | 功能范围 | A（Cursor 基线）+ B（数字员工差异化）都要 | A 打底 B 差异化；红线：统一 pi-wire 管道，worker 不感知 UI |
| 9 | 平台矩阵 | macOS + Linux 起步，Windows 后置 | 团队 Mac+Linux 工作站；Zed Linux 是二等公民（风险记账） |
| 10 | 分发 | 主 app→DMG(mac)/.deb(linux)；CLI/worker→npm+二进制（现状不动） | npm 装 GUI 是反模式；Linux 只出实际使用的包格式 |
| 11 | repo 拓扑 | Zed fork 独立 repo；OMP monorepo 不动 | 两个 Cargo workspace 不能合一（工具链打架）；参照 brush-vendored 先例；连接点在运行时（spawn + WS），集成在打包产物层 |

## 4. 功能规格

### 4.1 主 app（Phase 0，Tauri）

| 功能 | 来源 |
|---|---|
| 加载 web-app（工作台/agents/models/tasks/todo/skills/settings） | 现成，零改造 |
| worker sidecar 管理（spawn/守护/崩溃重启/版本） | Tauri sidecar |
| 托盘、开机自启、多窗口 | Tauri 插件 |
| 自更新（tauri-plugin-updater） | 对外前接签名源 |

### 4.2 编辑器（Phase 1–2，fork Zed）

**Phase 1（Cursor 基线 A）**：

| 功能 | 优先级 | 来源 |
|---|---|---|
| Chat 面板（侧栏会话流，GPUI） | P0 | pi-wire + web-app 转录组件概念迁移 |
| Agent mode（读→改→跑测试→修错循环） | P0 | worker 25+ 工具链 |
| ⌘K inline edit + diff 预览落 buffer | P0 | worker edit 工具 + Zed inline diff |
| 权限审批卡（允许/会话内允许/拒绝） | P0 | web-app ApprovalCard 概念迁移（审批链已全真上线） |
| Tab 补全 | P1 | pi-ai 多 provider |
| 终端 agent（说人话跑命令） | P1 | worker bash 工具 |

**Phase 2（数字员工差异化 B）**：

| 功能 | 优先级 | 来源 |
|---|---|---|
| 多 agent 并行（前端工/测试工/文档工同项目多会话） | P0 | agent registry + agents 页概念 |
| 会话绑定数字员工身份（权限/记忆/技能随身份走） | P0 | OMP 独有 |
| cron 进编辑器侧栏（打开 IDE 看昨夜干完的活） | P1 | gateway scheduler 资产 |
| self-evolution 学习闭环（review 行为沉淀技能） | P1 | evolution.db |
| 分层级计划体（多 agent 编辑器内协作） | P2 | 新形态，需单独设计 |

**架构红线**：
- 所有 agent 事件走统一 pi-wire 管道——Chat/inline/审批/cron 都是这条流的消费者
- worker 不感知 UI——多 agent/审批/cron 是协议层能力，钉钉/浏览器/IDE 三入口共享同一套数字员工
- Zed fork 改动全部限于扩展点，编辑器核心零改动

### 4.3 UX 参考

- Mock（可交互，浏览器打开）：`tmp/omp-ide-mock.html`（⌥1 IDE / ⌥2 Agent 双模式示意；主从结构调整后，两个模式对应主 app 与编辑器窗口，交互形态以本档为准）
- 截图：`tmp/omp-ide-mock-ide-mode.png` / `tmp/omp-ide-mock-agent-mode.png`

## 5. 风险账本

| 风险 | 等级 | 对策 |
|---|---|---|
| Zed fork 组织账：50 人团队无编辑器工程师，需 1–2 专职 Rust | 高 | Phase 0 上线后实测 code 面使用频率再定 fork 投入；fork 启动设硬门槛 |
| GPL 传染：对外时编辑器部分必须开源 | 高（对外时点） | 已睁眼接受；VS Code(MIT) 是换路预案；worker 进程隔离保持 MIT（对外前法务确认） |
| Zed 商标：名称/logo 必须整体换品牌 | 中 | 换品牌列入 fork 基建，设计成本已记 |
| Zed Linux 二等公民（GPU/Wayland/输入法） | 中 | Linux spike 与 macOS 同批做，不后置 |
| Tauri webview 兼容：mac=WKWebView / linux=WebKitGTK | 中 | 立项第一周 spike：web-app 真实页面过一遍两个内核 |
| 上游同步：rebase 还是冻结 | 中 | fork 基建时定策略（建议季度 rebase） |
| localhost WS 无鉴权，客户端分发放大暴露面 | 中 | 本机 token 握手，Phase 0 后期加 |
| 编辑器独立更新管道（tauri-updater 只管主 app） | 低 | 记账，Phase 1 定方案 |

## 6. 开工顺序（仅为排期骨架，**未开工**）

1. **Tauri 主 app**（约 2–4 周）：壳 + worker sidecar + 加载 web-app → 内部可用
2. **Zed fork 基建**（并行启动）：clone/构建链/换品牌 + pi-wire 客户端协议进 fork
3. **编辑器挂点**：Chat 面板（GPUI）→ inline diff/⌘K → 审批卡
4. **数字员工层**：多 agent 会话/身份绑定/cron 侧栏/学习沉淀闭环

每步含对应 spike：Tauri webview 双内核验证（第 1 步前）、Zed 构建链（第 2 步首日）、GPUI 面板可行性（第 3 步前）。

## 7. 被推翻的决策（过程存档）

| 原决策 | 推翻原因 |
|---|---|
| Zed fork 当宿主，web-app 塞 webview tab | 主从颠倒（用户纠偏：OMP 才是主）；上游 webview 半成品（#10533/#21208），最大技术风险 |
| 单 app 双模式切换（⌥1/⌥2） | 被 B 方案覆盖：套件双窗口 |
| Agent 面板 GPUI 全量重写 web-app 组件 | 决策 B 后不再需要（web-app 就是主 app 主体） |
| VS Code fork（MIT） | 用户拍板"先用 Zed"；MIT 路线保留为换路预案 |

## 8. 待拍板遗留项（开工前须闭合）

1. 产品名/品牌（Zed 商标规避，影响 fork 换品牌工作量）
2. Linux 实际使用的包格式（.deb / .AppImage，看团队发行版分布）
3. fork 上游同步策略（季度 rebase vs 冻结）
4. 专职 Rust 维护者人选（F1 组织账）
5. 对外时点的 GPL 法务确认（worker 进程隔离的衍生作品边界）
