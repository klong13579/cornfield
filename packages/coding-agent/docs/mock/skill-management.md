# OMP 前端 · Skill 管理方案思路

> 2026-08-17 · 依据：开源 skill management 方案调研（skills-manager / vercel/skills / SkillNote / skm）
> 关联：`requirements.md` FR-2 · `agent-detail.html`（Skills tab）· `docs/skills.md`（skill 运行时）· `docs/marketplace.md`
> 定位：前端设计约束 + 后端协议扩展建议，不是桌面文件管理工具的重造

---

## 1. 现状盘点

### 1.1 omp 侧（后端能力已齐，前端只缺可视化）

| 能力 | 现状 | 出口 |
|---|---|---|
| skill 定义 | 目录 + `SKILL.md`（frontmatter：name/description/globs/alwaysApply） | `docs/skills.md` |
| 发现 | provider discovery（native/Claude/Codex/agents/plugin）+ customDirectories，非递归 `*/SKILL.md` | `src/extensibility/skills.ts` |
| 开关 | settings `skills.enabled`；按名禁用 `disabledExtensions`（`skill:<name>`） | settings schema |
| 分发 | marketplace（`.claude-plugin/marketplace.json`，git repo 或本地目录）；`/marketplace add/install` | `docs/skills/authoring-marketplaces.md` |

### 1.2 前端现状（mock V3-V6）

唯一触点：**Agent 详情 → Skills tab** —— 技能行（mono 名 + 描述 + 版本 + toggle）。

缺：来源、搜索、更新感知、安装/卸载、市场浏览、批量（技能组）。

---

## 2. 开源方案调研结论

| 方案 | 形态 | 支持 omp | 核心能力 | 借鉴点 |
|---|---|---|---|---|
| **skills-manager** | Tauri 桌面 + CLI（Rust） | ✅ **原生**（`omp_agent` adapter：`~/.omp/agent/skills` + `<repo>/.omp/skills`） | 中央库、preset 技能组、52 agent 一键部署、Git 备份/多设备同步、skills.sh 市场 | preset 技能组语义、来源管理、更新追踪、多 agent 部署 |
| **vercel/skills** | CLI（`npx skills`） | ❌（77 agents 无 omp） | 生态事实标准：add/find/update、git/github/locale 源解析、symlink/copy 安装 | skill 来源解析协议、skills.sh 市场 |
| **SkillNote** | 自托管 registry（Docker + PG + Web） | ❌ | 团队共享 registry、版本化、collection 作用域、浏览器编辑 60s 同步、agent 评分 | 团队共享模型、collection 作用域、评分反馈闭环 |
| **skm** | Python CLI | ❌ | YAML 声明式全局管理、idempotent 同步、lock 文件 | 声明式配置 + lock 的可复现性 |

**结论**：
- 单机文件级管理可白嫖 skills-manager（已适配 omp 路径，零改造）——**不重复造**。
- omp 前端要解决的是**数字员工平台的 skill 管理**（给每个 agent 装配能力、统一市场分发），不是桌面文件同步。
- 因此：**前端做可视化 + 交互，复用 omp 已有 skills/marketplace 机制，借鉴开源方案的管理语义**。

---

## 3. 方案思路

### 3.1 三层目标形态

| 层 | 内容 | 对应页面 | 优先级 |
|---|---|---|---|
| L1 | Agent 详情 Skills tab 完整性补齐：来源/版本/更新/搜索 | `agent-detail.html` | P3（agent 详情真实读写） |
| L2 | Skills 市场页：浏览/安装/卸载技能包（类比模型市场） | 新路由 `/skills` | 远期（可插队） |
| L3 | 技能组（preset）批量装配 + （远期）团队共享 registry | Agent 详情 → 技能组 tab / 设置 | 远期 |

### 3.2 数据与协议（复用后端，不新增体系）

| 前端需求 | 后端出口 | 说明 |
|---|---|---|
| 技能列表 | `get_snapshot` 扩展 `skills: [{name, description, version, source, enabled}]` | 复用现有 skill 发现结果 + 补 version/source 字段 |
| 启用/停用 | 复用 `set_host_tools` 同类路径 → `set_skill_enabled(name, bool)` | 后端已有 `disabledExtensions` 持久化 |
| 安装/卸载 | 复用 marketplace 命令链（`/marketplace add/install`）→ RPC 封装 `install_skill` / `uninstall_skill` | 不新建分发体系 |
| 更新感知 | 前端显式「检查更新」→ 读远端 git / registry 版本 | skills-manager 同款更新追踪，前端仅展示 |

> 协议字段扩展标注 `[P3+]`：P3 前保持现有 mock 数据源，字段先以占位 mock 呈现，不阻塞前端开发。

### 3.3 交互设计（对齐 mock 视觉语言）

**L1 · Skills tab 行升级**：`skill-name` + `desc` + 来源 badge（native / marketplace / custom）+ 版本 + 更新可用指示（dot）+ toggle。加搜索 + 状态筛选（全部/启用/禁用）。

**L2 · Skills 市场页**：卡片网格（类比模型市场）。来源分组（内置 / 市场）；卡片 = 名称/描述/版本/来源；安装 = toggle；已装的显示当前版本。路由 `/skills`，导航分组 primary。

**L3 · 技能组（skills-manager preset 语义）**：命名组 = 有序技能名集合，一键应用到 agent（等价批量 `set_skill_enabled`）。若做，落 Agent 详情 → 技能组 tab；分组数据源放 agent 配置扩展，不回前端代码。

### 3.4 落地分期

- **P3**（与 agent 详情真实读写同批）：Skills tab 基础 toggle 接入真实接口
- **P3+**：来源/版本/搜索/更新 dot（纯展示增强，低风险）
- **远期**：Skills 市场页（新路由，类比 `/models` 的投入产出，可按业务优先级插队）
- **远期**：技能组 preset + 团队共享（SkillNote collection 模型的轻量版——私有 marketplace repo 已够用，registry 服务不建）

---

## 4. 明确不做

- **不做本地文件级 skill 管理**：那是 skills-manager 的活，且它已原生支持 omp 路径，白嫖即可
- **不自研版本控制**：git 已够；版本 = frontmatter `version`（需后端补充解析）或 git commit
- **不建 registry 服务**（远期也先用私有 marketplace repo）：SkillNote 的重型形态（Docker+PG）与 omp 本地架构不符
- **不引入 Electron 级同步**：omp 多设备语义在 gateway/agentDir，不归前端

---

## 5. 待确认

- [ ] Skills 市场页是否本期做（类比 `/models` 的投入产出权衡）
- [ ] version/source 字段来源：SKILL.md frontmatter 扩展 vs 发现结果推断（需后端定）
- [ ] 技能组 preset 是否进 P3 范围（取决于 agent 配置模型是否支持组语义）