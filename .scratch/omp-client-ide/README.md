# omp-client-ide 工作包

范围：**阶段 0（wire 地基）+ 阶段 B（IDE 先行）**。依赖文档：docs/editor-extension/topics/（v2-requirements / v3-architecture / spec-implementation / spike-opensumi-verdict）。

## 票清单（依赖序）

| # | 票 | 阻塞于 | Wave |
|---|---|---|---|
| 01 | wire fs 写命令面 | — | W1 |
| 02 | wire git 最小集 | — | W1（wire 组串行） |
| 03 | wire 配置命令 | — | W1（wire 组串行） |
| 04 | AcpAgent requestPermission | — | W1 |
| 05 | 壳骨架（两段，见下） | — | W1 |
| 06 | IDE 文件通路 | 01, 05 | W2 |
| 07 | 设置通路 | 03, 05 | W2 |
| 08 | diff 审阅 | 01, 05 | W2 |
| 09 | 审批卡内嵌 | 04, 05 | W3 |
| 10 | 我的 agent 轻视图 | 05 | W2 |
| 11 | IDE Git 面板 UI | 02, 05 | W3 |

## 范围声明（本包承接 vs 后续包）

**本包覆盖**：wire 命令地基（写/git/配置）、IDE 壳与研发协作核心（对话/diff 审阅/审批/文件通路/设置/Git 面板）、我的 agent 轻视图起点。

**后续包承接（不在本包，勿误判为漏项）**：
- L1 域 agent（域管理视图 / 域级协作发起 / 域 4 目标）——D8/D10
- CEO 工作台（域级战报 / 跨域事项 / 下钻）——D11
- 员工 agent 4 目标引擎（钉钉 context 摄入 / 知识库刷新 / 画像保鲜 / 业务进展秒答的常驻运行）——D9
- 追溯台（会话/工具调用/决策回放）——User Story 23
- 阶段 C 单壳收敛（web-app 12 页迁移清单逐页三态拍板后执行）——D14 终点

## 并行执行要点（squad-programming）

- **Wave1 = 3 个 worktree**：04 / 05 / wire 组（01→02→03 串行，共享 pi-wire 命令 schema 与 wire-server 分发文件，勿并行）
- **Wave2 = 最多 4 个并行**：06 / 07 / 08 / 10
- **Wave3**：09 / 11
- 关键路径：05 → 08（壳 → 核心差异化）
- 05 是 6 张票共同前置——优先保障，内部按两段交付（见票 05）
