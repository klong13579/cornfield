# Agent Design V1

> Agent 运行时 + agentDir 布局设计
>
> 实施基线：`/Users/sz-0203015357/Desktop/Narwal/OMP-workspace-test/omp-atomix`（2026-06-18）

---

## 1. 范围与术语

| 术语 | 定义 |
|---|---|
| Agent 进程 | `omp --mode rpc` 子进程，由 AgentBridge 启动 |
| agentDir | Agent 进程的工作目录，包含所有 prompt / config / runtime 文件 |
| account | 钉钉机器人账号（1:1 绑定 agentDir） |
| 加载 | Agent 启动时 OMP 读取 agentDir 下的文件构建 system prompt |

**不在本文档范围：**
- Agent 进程的调用方（spawn 机制、RPC 协议、IM 消息处理） — 这些是网关侧的职责
- OMP 内部的 prompt 发现与注入机制（参见 OMP coding-agent 包的设计文档）

---

## 2. agentDir 完整布局

> 实施基线：omp-atomix（2026-06-18）
> 标尺：**5 个 always-on 文件**（AGENTS.md 作 manifest 触发器 + 4 个文件由 prompt-includes.json 注入） + **1 个项目级 user 人设（user.md）** + **root AGENTS.md 主导** + **prompt-includes.json 显式声明**。

```
<agentDir>/                            ← Agent 工作目录（1 个 account = 1 个目录）
│
├── AGENTS.md                          ← [ALWAYS-ON] Manifest + 全局硬约束
│                                           OMP 原生 discovery 触发
│                                           提取 MUST NOT → <hard-constraints>
│
├── mission.md                         ← [ALWAYS-ON] 身份叙事（IDENTITY 层）
│                                           注入 <context>
│
├── TOOLS.md                           ← [ALWAYS-ON] 工具用法 + co-located MUST/MUST NOT
│                                           工具级规则紧贴工具描述
│
├── TODO.md                            ← [ALWAYS-ON] 当前任务状态
│
├── user.md                            ← [PROJECT PERSONA] 项目级用户人设
│                                           补充 / 覆盖用户级 `~/.omp/user.md`
│                                           不进入 prompt-includes.json（避免与
│                                           `loadUserProfile` 重复注入）
│                                           OMP 启动时 `loadUserProfile` 从
│                                           `~/.omp/user.md` 加载到 <user> block；
│                                           agentDir 级 user.md 是项目级覆盖
│
├── prompt-includes.json               ← [RUNTIME] 显式声明 always-on 文件列表
│                                           触发 OMP 注入 <context>
│                                           5 文件：AGENTS.md, mission.md, TOOLS.md,
│                                                 TODO.md, knowledge/external-workspaces.md
│                                           （user.md 不在列表中——见 user.md 注释）
│
├── .omp/
│   ├── config.yml                     ← [RUNTIME] OMP 配置（modelRoles / 工具 / 主题）
│   ├── SYSTEM.md                      ← [RUNTIME] 覆盖 OMP 内置 system prompt（gateway agent 基线）
│   ├── evolution/                     ← [RUNTIME] Evolution 数据（gitignored）
│   └── skills/                        ← [BEHAVIOR] 项目级 skills（on-demand，OMP 原生路径）
│       └── <skill-name>.md
│
├── knowledge/                         ← [CONTEXT] 静态知识库
│   ├── external-workspaces.md         ← [ALWAYS-ON] 外部数据源映射
│   ├── faq.md                         ← [ON-DEMAND] 高频问题
│   └── handbook/                      ← [ON-DEMAND] 操作手册
│
├── cron/                              ← [BEHAVIOR+RUNTIME] 定时任务
│   ├── tasks/
│   │   └── <id>.json5                 ← [RUNTIME] 调度元数据 + prompt（command 字段；不再使用 .prompt.md 配对）
│   └── logs/                          ← [RUNTIME] 执行日志（gitignored）
│
├── scripts/                           ← 工具脚本（gitlab_auth.py 等）
├── external/                          ← 外部数据源（YAML 映射，可选）
├── sessions/                          ← 对话历史（gitignored）
│   └── cid_<safeConvId>.jsonl
├── weekly-reports/                    ← 周报快照（项目专属）
├── examples/                          ← 数据示例
├── docs/                              ← 设计文档（仅供人读）
└── .gitignore
```

### 2.1 always-on vs on-demand

| 类别 | 文件 | 触发方式 |
|---|---|---|
| **always-on (5)** | `AGENTS.md`, `mission.md`, `TOOLS.md`, `TODO.md`, `knowledge/external-workspaces.md` | OMP 原生 discovery → `prompt-includes.json` → 注入 `<context>` |
| **project persona (1)** | `user.md` | 不走 prompt-includes。`loadUserProfile` 从 `~/.omp/user.md` 注入 `<user>`；agentDir/user.md 是项目级覆盖（未来 OMP 版本可被 `loadUserProfile` 识别） |
| **on-demand (skill)** | `.omp/skills/<name>.md` | `skill://<name>` URI 触发 |
| **on-demand (read)** | `knowledge/faq.md`, `knowledge/handbook/*` | agent 主动 `read` |
| **on-demand (run)** | `cron/tasks/*.json5` (command 字段) | 定时调度触发 |

#### 2.1a user.md 语义（user 级 vs agentDir 级）

| 路径 | 层级 | 加载位置 | 作用 |
|---|---|---|---|
| `~/.omp/user.md` | user 级（跨 agentDir 共享） | `<user>` block（`loadUserProfile`） | 用户跨项目基线身份 |
| `<agentDir>/user.md` | agentDir 级（项目级覆盖） | 当前 OMP 版本：未加载 | 项目级用户人设覆盖；供项目定制使用 |

**为什么分两级**：
- 用户级 `~/.omp/user.md` 跨所有 agentDir 共享，是用户的跨项目基线。
- agentDir 级 `<agentDir>/user.md` 允许项目在不动用户级配置的前提下，定制该项目下的用户人设。
- 例如：用户是 CEO，但 customer-facing 项目的 user.md 可能希望“助理”以“客户支持专员”的身份应对。

**schema**（与 identity 工具的 `update_persona` 对齐）：

```yaml
sections: [basics, career, interests, preferences, interaction, thinking, constraints]
format:   ## <section>\n- <key>: <value>\n- ...
```

key-value 形式不严格（identity 工具以 "key: value" bullet 合并；同 key 覆盖，新 key 追加）。

### 2.2 默认 `.gitignore`

创建 skeleton 时一同写入，忽略运行时数据与敏感凭据：

```gitignore
sessions/
cron/logs/
.omp/evolution/
.omp/
*.log
*.bak
```

> 注：`.omp/evolution/` 下的人可读报告（`*.md`）通常需要追踪，需加 `!` 反向规则（见 omp-atomix `.gitignore`）。

---

## 3. 加载流程

```
Agent 进程启动 (cwd = agentDir)
  │
  ├── 1. OMP 读 .omp/config.yml                  ← 模型 / 工具 / 主题配置
  │
  ├── 2. OMP 读 mission.md                        ← 注入 <system>（核心人格）
  │
  ├── 3. OMP 原生 discovery 扫 root AGENTS.md
  │     ├── 提取 MUST NOT / NEVER 行 → <hard-constraints>
  │     └── 剩余内容（去重后）→ <context>
  │
  ├── 4. OMP 读 root prompt-includes.json
  │     └── 注入列出的所有文件到 <context>
  │         ├── AGENTS.md（去重后）
  │         ├── mission.md
  │         ├── TOOLS.md
  │         ├── TODO.md
  │         └── knowledge/external-workspaces.md
  │     （user.md 不在列表中——见 §2.1a）
  │
  ├── 5. OMP 扫描 .omp/SYSTEM.md + skills/
  │     ├── .omp/SYSTEM.md → 覆盖 OMP 内置 system prompt（gateway agent 基线）
  │     └── .omp/skills/   → 注册到 omp skill 系统
  │
  ├── 6. `loadUserProfile` 读 `~/.omp/user.md`（user 级）
  │     └── 注入 <user> block（详见 §2.1a；agentDir 级 user.md 未来可被
  │         `loadUserProfile` 识别为项目级覆盖）
  │
  ├── 7. Cron 引擎扫 cron/tasks/*.json5
  │     └── 注册定时任务
  │
  └── 8. Session 层加载 sessions/ 下的活跃 session
```

**关键点：**
- **Step 3-4 是核心**：AGENTS.md 是 manifest 触发器，prompt-includes.json 加载其他 4 个 always-on
- **Step 5 的 .omp/SYSTEM.md 是 auxiliary**，主路径在 Step 3-4
- **Step 6 的 `<user>` block** 提供用户人设（与 mission.md 的 agent 人设正交）
- **mission.md 与 AGENTS.md 都有 identity 内容**，但 mission.md 是 IDENTITY 层（narrative），AGENTS.md 是 MANIFEST 层（操作性硬约束）

---

## 4. 文件语义（6 层 MECE）

| 层 | 文件 | 职责 |
|---|---|---|
| **IDENTITY** | `mission.md` | 我是谁（公司 / 产品 / 领域 / skills） |
| **USER PERSONA** | `user.md`, `~/.omp/user.md` | 用户是谁（姓名 / 角色 / 时区 / 跨项目偏好）—— 与 IDENTITY 正交 |
| **MANIFEST** | `AGENTS.md` (前半) | 加载哪些文件 + File Map + 更新指南 |
| **CONSTRAINTS** | `AGENTS.md` (后半) + `TOOLS.md` (co-located) | 行为硬约束 + 工具级规则 |
| **CONTEXT** | `TOOLS.md`, `knowledge/*`, `TODO.md` | 工具用法 / 数据源 / FAQ / 任务 |
| **BEHAVIOR** | `.omp/skills/` | 一次性 procedure |
| **RUNTIME** | `.omp/config.yml`, `prompt-includes.json`, `cron/*.json5` | 配置 / 调度元数据 / 注入清单 |

**MECE 5 原则：**
1. 一个概念 = 一个文件
2. 工具级规则 co-located with 工具描述（TOOLS.md）
3. 全局行为规则在 AGENTS.md
4. IDENTITY 单独 mission.md（不混入规则）
5. USER PERSONA 单独 user.md（不混入 agent 身份）—— agent 身份 与 用户身份 是正交维度
6. 没有消费者的设计文档 = 删除

---

## 5. 文件来源（谁创建）

| 路径 | 创建者 | 说明 |
|---|---|---|
| `AGENTS.md` | **skeleton（手动）** | Manifest + 全局硬约束 |
| `mission.md` | **skeleton（手动）** | 核心人格 |
| `TOOLS.md` | **skeleton（手动）** | 工具指南 + 工具级 MUST/MUST NOT |
| `TODO.md` | 用户 | 当前任务 |
| `user.md` | **skeleton（手动）** | agentDir 级用户人设（项目级覆盖；与 `~/.omp/user.md` 正交，见 §2.1a） |
| `prompt-includes.json` | **skeleton（手动）** | 显式声明 always-on（不包含 `user.md`，避免与 `loadUserProfile` 重复加载） |
| `.omp/config.yml` | skeleton | 默认 modelRoles |
| `.omp/evolution/` | 运行时 | Evolution 数据（gitignored） |
| `.omp/skills/` | 用户 | on-demand 技能 |
| `.omp/SYSTEM.md` | skeleton | 覆盖 OMP 内置 system prompt（gateway agent 基线） |
| `knowledge/external-workspaces.md` | **skeleton（手动）** | 外部数据源映射 |
| `knowledge/faq.md` | 用户 | 高频问题（按需） |
| `knowledge/handbook/` | 用户 | 操作手册（按需） |
| `cron/tasks/*.json5` | 用户 | 定时任务定义（含 prompt） |
| `cron/logs/*.log` | 运行时 | 执行日志（gitignored） |
| `scripts/` | 用户 | helper 脚本 |
| `external/` | 用户 | 外部数据源 YAML |
| `sessions/*.jsonl` | OMP 运行时 | 对话历史（gitignored） |
| `weekly-reports/` | 用户 | 周报快照 |
| `examples/` | 用户 | 数据示例 |
| `docs/` | 用户 | 设计文档 |
| `.gitignore` | skeleton | Git 忽略规则 |

> **Skeleton 源**：`packages/coding-agent/src/skeleton/`（`@oh-my-pi/pi-coding-agent/skeleton`）
> - 创建目录列表：`src/skeleton/dirs.ts`（当前：`.omp`、`.omp/skills`、`knowledge`、`knowledge/handbook`、`cron`、`cron/tasks`、`cron/logs`、`sessions`）
> - 资产文件：`src/skeleton/assets/`（bun 静态 import，非运行时读取）
> - 入口函数：`ensureAgentDir(agentDir)` / `resolveAgentDir(accountId, explicitDir?)` / `buildAgentSessionPath(agentDir, conversationId)`
> - 调用方：`pi-gateway`（账户安装 / 启动时 ensure）、`omp agent init`（CLI）

---

## 6. agentDir 创建与管理

### 6.1 agentDir 创建机制

agentDir 的创建由调用方负责（典型场景：网关启动时为每个 account 创建）。两种行为：

- **`mission.md` 不存在** → 触发全量创建（agentDir 不存在则从零创建，存在但 mission.md 缺失则只补 mission.md 等必要文件）
- **`mission.md` 已存在** → additive 更新（补充其他缺失的 skeleton 文件，不覆盖任何已有内容）

**skeleton 内容**见本文档 §2。**错误处理**：创建过程中任何 I/O 失败应作为调用方的启动错误（由调用方决定是终止还是重试）。

### 6.2 推荐的 CLI 命令

> Gateway auto-create 解决了启动时的 skeleton 问题。以下为已实现的命令集。

| 命令 | 作用 | 状态 |
|---|---|---|
| `omp agent init <name>` | 从模板创建新 agentDir（独立于 Gateway） | **已实现** |
| `omp agent list` | 列出已配置 agent（含 gateway 注册的 agentDirs） | **已实现** |
| `omp agent validate <agentDir>` | 校验 agentDir 结构完整性 | **已实现** |
| `omp agent clone <source> <target>` | 从现有 agent 克隆 | 待实现 |
| `omp agent show <name>` | 显示 agent 摘要 | 待实现 |
| `omp agent migrate <agentDir>` | 应用 schema 迁移 | 低优先级 |

**`omp agent init` 工作流：**

```bash
# 创建新 agent
omp agent init hr-bot --template default

# 生成的 agentDir（按本文档 §2 布局）：
# hr-bot/
# ├── AGENTS.md (从模板，含占位段)
# ├── mission.md (含占位 "你是 HR 助手")
# ├── TOOLS.md (从模板)
# ├── user.md (从模板——与 `~/.omp/user.md` 的 schema 对齐，可被项目覆盖)
# ├── prompt-includes.json (5 个 always-on 文件；user.md 不在列表中)
# ├── .omp/config.yml (默认 modelRoles)
# └── ...
```

**`omp agent clone` 工作流：**

```bash
# 克隆现有 agent 作为新 agent 模板
omp agent clone omp-atomix/ atomix-clone/

# 克隆时：
# - 保留：AGENTS.md, mission.md, TOOLS.md, user.md, knowledge/, .omp/skills/
# - 脱敏：scripts/.gitlab_credentials, .gitlab_cookies.json
# - 重新生成：sessions/ (空)
# - 更新：mission.md 中的硬编码 ID（可选）
# - 警告：user.md 含个人身份信息；克隆后应审查是否与新 agentDir 场景匹配
```

**`omp agent list` 工作流：**

```bash
$ omp agent list
NAME          AGENT_DIR                                    STATUS
opencode      /Users/.../omp-atomix                        active
test          /Users/.../omp-atomix-test                   active
```

### 6.3 文件系统设计原则

agentDir 文件系统的设计遵循五个原则：

1. **配置在文件中，不在进程中。**
   agent 的人格、模型、行为规则、工具配置全部存储在文件里。备份 agentDir = 完整恢复整个机器人。同一代码可以启动无限个不同人格的机器人，只需要切换 agentDir 路径。

2. **物理隔离 = 安全隔离。**
   每个 agent 拥有独立的文件系统命名空间。运维机器人的 session 文件不会被 HR 机器人读到。cron 任务、脚本、知识库都按 agent 分隔——故障不会跨越目录边界。

3. **按生命周期分层。**
   以 agentDir 根为原点，距离根越近的文件越核心（人格定义），距离越远的越基础设施（运行时数据）：

   ```
   <agentDir>/      ← 人格核心 (AGENTS.md, mission.md, TOOLS.md, user.md)
     ├── .omp/      ← 运行时配置 + 系统 prompt 覆盖 (modelRoles / skills / evolution / SYSTEM.md)
     ├── sessions/  ← 运行时数据 (对话历史)
     ├── cron/      ← 定时任务 (调度元数据)
     ├── knowledge/ ← 参考知识
     └── external/  ← 外部数据源映射
   ```

   `user.md` 与人格核心同层（agent 身份与用户身份同时被 agent 知晓）。详见 §2.1a。

4. **内容优先于目录。**
   只定义目录结构，不预定义用户内容文件名（除 5 个 always-on 外）。omp 框架钩子文件（`.omp/config.yml`、`.omp/SYSTEM.md`、root `AGENTS.md`）在 skeleton 中创建为占位模板；用户内容文件（`knowledge/*`、`external/*`）由 agent 创建者决定。结构提供组织框架，不约束内容。

5. **可选文件不报错。**
   结构图中标注"可选"的文件在缺失时不应产生任何错误或警告。只有 5 个 always-on 文件（`AGENTS.md`、`mission.md`、`TOOLS.md`、`TODO.md`、`knowledge/external-workspaces.md`）和 `.omp/config.yml` 是 runtime 硬依赖。`user.md` 是 skeleton 资产但不是 runtime 硬依赖（缺失不报错）。

---

## 7. 与 Hermes Agent / OpenClaw 对比

| 维度 | Hermes Agent | OpenClaw | 本设计 |
|---|---|---|---|
| 配置集中度 | `config.yaml`（540 行涵盖全部） | `AGENTS.md` + 多个 bootstrap 文件 | **拆分**：多个 config + 启动脚本（按职责分） |
| 人格定义 | `SOUL.md` | `AGENTS.md` (主) | **`mission.md`** |
| 用户人设 | （未拆分） | （未拆分） | **`user.md`**（双层：user 级 + agentDir 级） |
| 多 agent 隔离 | `profiles/<name>/` (切换) | `agents/<id>/` | **`<agentDir>/`** (1:1 绑定 account) |
| 会话隔离 | `sessions/` (request_dump + jsonl) | `sessions/` | **`sessions/cid_<id>.jsonl`** (omp 原生格式) |
| 任务调度 | `cron/` | `cron/` | **`cron/tasks/*.json5`** + `cron/logs/` |
| 状态存储 | `state.db` | `.openclaw/...` | **`.omp/evolution/`** (gitignored) |
| Prompt 注入 | 单一文件 | 多 bootstrap 文件 | **root AGENTS.md + prompt-includes.json 显式 5 文件** + `<user>` block |

**核心差异：**
- Hermes 集中（单 yaml），本设计**拆分**（多文件按 MECE 6 层）
- Hermes / OpenClaw 都有显式 SOUL/AGENTS，本设计用 **mission.md 单独**（IDENTITY 层独立）
- 本设计独立 `user.md` 拆分 USER PERSONA 层（与 IDENTITY 正交）——其他两家 agent 与 user 人设混杂
- 本设计引入 **prompt-includes.json 显式注入**（更可控的 always-on）

---
