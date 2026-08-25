# Spec：omp 客户端单壳收敛（Agent 视图 + IDE 视图）

> 状态：**待 review**（2026-08-25，to-spec 生成）
> 前置：`v2-requirements.md`（D1–D16）、`spike-opensumi-verdict.md`（三轮实证）、`v3-architecture.md`（架构基线）
> 发布：本地工作包（GitHub tracker 无 ready-for-agent 标签，未发布 issue）

---

## Problem Statement

公司用 omp 搭建数字员工平台（三层：员工个人 agent / 域 agent / 研发 IDE），但当前客户端形态撑不住这个目标：

1. **没有 IDE**：研发团队没有在真实编辑器里与 agent 协作的界面——agent 改文件人没法审（无 diff 审阅、无接受/拒绝），只能看 chat 里的文本
2. **两个壳分裂**：OpenSumi（IDE 底座）有自己的一套 UI/设置（~/.sumi），web-app 有另一套——同一平台两套风格、两套设置、功能各自实现，长期必然漂移
3. **配置无统一读写面**：平台设置（模型/thinking/权限/技能）散落在分散命令里，无通用配置命令，新前端（IDE）接不上
4. **审批链断**：agent 在 IDE（ACP）里干活时无法向人发起审批请求，危险操作没有把关点

## Solution

**单壳收敛**：OpenSumi 3.9.1-next 为唯一客户端壳，Agent 视图（团队工作台）与 IDE 视图（研发工作台）都是壳内一等视图；web-app 资产组件化迁入后退役；配置/风格/数据全部归 omp 平台，壳不产生第二份。

- 员工、域负责人、CEO 在壳内看到各自角色的视图（我的 agent / 分域管理 / CEO 工作台）
- 研发团队在壳内 IDE 与 omp agent 真实协作（对话 / diff 审阅 / 审批卡 / agent workspace 预览）
- 钉钉仍是员工与域 agent 的日常入口（gateway 常驻，独立于壳）
- 平台配置唯一真源是 omp（config.yml / models.yml / agentDir），壳只做读写代理
- 壳的 UI 风格与动效沿用 web-app 设计体系

## User Stories

1. 作为员工，我想在钉钉里随时找到我的个人 agent 并让它干活，以便它成为我的提效助手
2. 作为员工，我想在壳里打开"我的 agent"轻视图看到它的状态/知识库/画像/近期任务，以便我了解它在帮我积累什么
3. 作为员工，我想我的 agent 通过钉钉持续了解我的工作上下文，以便它理解我的工作状态与意图
4. 作为员工，我想我的 agent 定期更新我的个人知识库与画像（mission/user.md），以便它越用越懂我
5. 作为员工，我想随时问我的 agent"我手头业务的进展"，以便快速掌握状态而不翻聊天记录
6. 作为域负责人，我想管理本域的域 agent 与域内员工 agent，以便统一推进域内工作
7. 作为域内成员，我想找域 agent 请教本域业务问题，以便快速获得域级知识
8. 作为域负责人，我想让域 agent 发起域级协作（拉人和他们的 agent 进来），以便协同完成跨员工的任务
9. 作为 CEO，我想在壳内看到公司运转看板（每域一张战报卡：推进/产出/卡点），以便一眼掌握全局
10. 作为 CEO，我想在壳内看到一个"跨域事项"区（交期冲突/产出异常/资源协调），以便聚焦需要我判断的事
11. 作为 CEO，我想点进某个域看域内员工 agent 明细，以便下钻了解细节
12. 作为研发工程师，我想在壳内打开一个项目（git repo）进行编码，以便在真实编辑器里工作
13. 作为研发工程师，我想在 IDE 里跟 omp agent 对话（侧栏 + inline ⌘K），以便让 agent 直接改代码
14. 作为研发工程师，我想看到 agent 改动的 diff 并接受/拒绝/手动修改后接受，以便我信任 agent 的产出
15. 作为研发工程师，我想在 IDE 里内嵌审批卡（agent 要 push/改配置时），以便不切窗口完成审批
16. 作为研发工程师，我想从 agent 详情跳转查看它的 workspace 文件（只读预览），以便了解 agent 在文件世界的工作现场
17. 作为研发工程师，我想在显式授权后编辑 agent 的配置/技能文件（skill.md/mission.md/rules），以便维护数字员工本身
18. 作为研发工程师，我想在 IDE 里看到 git 状态/diff/log/分支并提交，以便完成日常开发闭环
19. 作为任何用户，我想壳内看到的设置与 omp 平台配置一致（改一处处处生效），以便不被两套设置搞晕
20. 作为任何用户，我想壳内 UI 风格/动效和之前的 web-app 一致，以便无缝迁移、不重新学习
21. 作为任何用户，我想平台配置（模型/thinking/权限/技能开关）只此一份且归 omp，以便换前端不丢配置
22. 作为管理员，我想 agent 的危险操作（花钱/改权限/删数据/对外发消息）必须经过审批，以便守住安全底线
23. 作为管理者，我想查看任何 agent 的会话/工具调用/决策依据回放，以便追溯与复盘

## Implementation Decisions

1. **单壳收敛（D14）**：OpenSumi `3.9.1-next-1787303337.0`（锁快照）为唯一客户端壳；Agent 视图 = 壳内自定义视图（`LayoutService.collectTabbarComponent` 动态注册 + `TabbarHandler` 控制），按账号角色注入（员工/域负责人/CEO）
2. **双协议通路**：IDE 内 agent 对话走 ACP（OpenSumi Agentic Layout 强制，spawn `omp acp` stdio）；Agent 视图内对话走 wire（PiClientAdapter prompt）；两类会话都落 omp sessions（追溯台统一）。文件/状态/配置一律走 wire
3. **wire 命令面（阶段 0）**：新增 `fs_write` / `fs_edit` / `fs_diff`（含 LSP writethrough 续接）、git 最小集（`git_status/git_diff/git_log/git_show/git_branches`）、通用配置命令 `get_config` / `set_config`（现有仅分散写命令 set_skill_enabled/set_model_disabled，无通用读写——需补）
4. **文件服务接 wire**：OpenSumi `IFileService` 注册自定义 FileSystemProvider 代理到 wire；agent workspace 预览用 `omp-agent://` scheme（只读；编辑需显式授权，D5）
5. **审批链路（阶段 3）**：OMP AcpAgent 补发 ACP `requestPermission`（agent→client 方法，OpenSumi 侧处理器已存在）；审批决策两端（IDE 审批卡 / Agent 视图）一致
6. **配置统一（D16）**：omp 配置（config.yml/models.yml/agentDir）唯一真源；OpenSumi 偏好仅存 IDE 瞬时视图状态，持久化用 preferenceDirName 系列重定向，不落 ~/.sumi 平台配置；设置 UI 经 wire `get_config/set_config` 读写
7. **UI 风格统一（D15）**：自定义 OpenSumi 主题 = `IThemeContribution` 注册 color-token JSON（含 textMateRules），对齐 web-app 设计 token；web-app 组件（Tailwind）随 import 带入，动效随组件继承
8. **包结构**：新建壳集成层包（renderApp 组装/自定义视图/主题/配置代理/agent 注册）；现有 Electron 壳（desktop）主进程机制保留（窗口/托盘/sidecar）；web-app 为资产源逐步迁入后退役；pi-wire/pi-client 扩展命令不破协议；coding-agent 小扩（fs_* 服务端 + requestPermission）
9. **集成环境要点**（spike 实证）：monaco worker 本地化（next CDN 404）；短 TMPDIR（watcher socket 路径上限）；默认 agent 用正规偏好配置（`ai.native.agent.defaultType` + `ai-native.acp.agents`）；workspace 经 `?workspaceDir=` 传递；Electron 侧原生模块重建流程文档化；正式壳建议 Electron ≥28（免 Node16 polyfill）
10. **zomp 冻结**：feat/zomp-embedded 分支保留不删，作为编辑体验升级后备；路线无关资产已在 main

## Testing Decisions

- **好测试的定义**：测协议往返与用户可见行为（命令发出去、结果正确回来、审批决策生效、diff 可接受/拒绝），不测实现细节
- **Seam 方案（最低 seam 数 = 2 协议契约 + 1 验收冒烟）**：
  - **wire 协议 seam**（平台命令）——最高 seam：所有前端消费同一协议。用 `PiClient` 直连 wire-server 的集成测试测 fs_*/git_*/config 命令契约。先例：现有 wire-server 集成测试
  - **ACP 协议 seam**（agent 会话/审批）——用 `acp-session-test.ts` 模式（ACP JSON-RPC 直连 omp acp）测会话生命周期与 requestPermission 发射。先例：acp-smoke / acp-session-test
  - **壳 e2e 冒烟**（验收用，非常规测试）——spike 的全量探针（OpenSumi + omp acp + 真实对话 + workspace 文件树）保留为阶段验收冒烟，不作为每次回归
- **测试模块**：pi-wire（命令契约）、coding-agent（fs_* 实现 + acp server + requestPermission）、壳集成层（冒烟）
- **先例复用**：gateway 的 fake-RPC 模式（agent 行为注入）可用于壳内 diff 审阅的验收测试

## Out of Scope

- web-app 全部存量页面的迁移收尾（voice/insights/records 等——按价值排序，阶段 4 判定归档或迁移）
- 插件市场 / wasm 扩展宿主 / 远程协作 / multi-root workspace / AI inline 补全（均显式拒绝或 v2 评估）
- zomp/Zed 深度集成（仅保留为后备）
- 编辑体验类增强：LSP 深度集成、symbol outline、markdown 预览、terminal inline chat
- 性能优化与首屏专项（阶段 4 验收项，不在此 spec 展开）

## Further Notes

- 与 unified-protocol-layer 的协同：阶段 0 的 wire 命令应落在其 P0 命令面收窄之后（或同步做），避免旧面加命令再迁移；本文档的 wire/ACP 双协议边界需在其方案中显式承认（编辑器是双协议消费者）
- OpenSumi 版本跟随：ai-native 迭代快（ACP 还在演进），锁快照 + 升级走单独评审；stable 出 ACP 后评估切换
- 探针环境保留于 `~/Desktop/Narwal/omp-opensumi-spike`（ide-electron / ide-startup 两套 + 全部 patch 记录），可复现
- 依赖文档：v2-requirements（需求）、v3-architecture（架构）、spike-opensumi-verdict（实证与集成点）
