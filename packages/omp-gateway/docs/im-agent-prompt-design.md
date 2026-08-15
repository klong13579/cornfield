# IM Agent Prompt 分层设计方案

## 参考来源

Hermes Agent + OpenClaw 共同使用的分层模式：
- **stable 层**：缓存友好，base template 提供通用纪律
- **context 层**：项目文件、skills
- **volatile 层**：记忆快照、会话信息

两侧都将 tool discipline / execution bias / verification 放在 base template，不被 SOUL.md/SYSTEM.md 覆盖。

## 分层归属

| 层 | 文件 | 内容 | 维护者 |
|---|---|---|---|
| **Base template** | `custom-system-prompt.md` | 工具纪律、验证纪律、合约规则、failure mode | OMP 项目 |
| **身份** | `.omp/SYSTEM.md` | 角色定位、gateway 工作方式、IM 沟通、安全授权 | agent 作者 |
| **身份补充** | `mission.md` | 具体身份、职责、能力边界 | agent 作者 |
| **项目规则** | `AGENTS.md` | 硬约束、MECE 规则表 | agent 作者 |
| **工具规则** | `TOOLS.md` | per-tool 使用指南 | agent 作者 |
| **SOP** | `skills/` | 可复用流程 | agent 作者 |

## _procedure.md 中需要补到 custom-system-prompt.md 的部分

### 已补（三条）

- 工具返回值校验
- 连续失败上报
- 并行执行

### 新补（三条）

来自 _procedure.md §1 Scope：
- 读技能再行动
- 复杂任务先做计划
- 缺信息先查再问

来自 _procedure.md §4 Task tracking：
- 任务推进时同步更新 TODO.md
- 标记完成即继续下一轮

来自 _procedure.md §6 Verification：
- 声称完成前验证
- 阻塞如实报告不编造

### 不补的

| _procedure.md 内容 | 原因 |
|---|---|
| §2 Before you edit | coding 专属，IM agent 不编辑代码 |
| §3 Parallelization 详述 | IM SYSTEM.md 已有"并行调用" |
| §5 While working 大部 | 抽象层级、修复根因、git 纪律等 coding 专属 |
| Design Integrity / design-checklist | 纯 coding 设计原则 |

## 实施状态

- [x] 2026-07-13: custom-system-prompt.md 新增三个章节（工具使用与执行纪律、任务追踪纪律、交付纪律）
