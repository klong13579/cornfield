---
name: prompt-optimizer
description: 诊断和优化 agent prompt 文件结构 — 基于 Karpathy 单文件风格和 Anthropic Context Engineering 最佳实践
---

# Prompt Optimizer

当用户要求"优化 prompt"、"诊断 agent"、"检查 AGENTS.md" 或类似请求时，执行以下流程。

**参考标准**：
- Karpathy CLAUDE.md：单文件、编号段落、可执行 bullet、结尾成功标准、无 YAML frontmatter
- Anthropic Context Engineering（2025）：Context 是有限资源、最小高信噪 token 集合、Just-in-Time 检索优于预注入
- "Do the simplest thing that works"

---

## Step 1: 发现文件结构

读取目标工作区（默认 `cwd`）的以下文件：

```
WORKSPACE/
├── AGENTS.md（或 CLAUDE.md / .agents.md / GEMINI.md）
├── USER.md（如有）
├── .omp/
│   ├── rules/   （所有 .md 文件）
│   └── skills/  （所有 */SKILL.md）
```

统计：文件总数、总行数、always-injected 文件数及行数（带 `alwaysApply: true` 的 rule/skill）。

## Step 2: 诊断检查

逐项检查以下问题，记录每项的状态（✓ 通过 / ✗ 需改进）：

### 文件结构
- [ ] **碎片化**：文件数 ≤ 3 为佳。> 5 个 = 过度碎片化
- [ ] **总行数**：always-injected 内容 ≤ 200 行为佳。> 300 = context bloat
- [ ] **重复内容**：同一约束/行为在多个文件中出现 = ✗
- [ ] **YAML frontmatter**：指令文件不需要 frontmatter。有 = 工程化过度

### 内容质量
- [ ] **成功标准**：是否有 "These guidelines are working if..." 类闭环？无 = ✗
- [ ] **可执行性**：每条约束是具体可执行 bullet，不是抽象描述
- [ ] **自相矛盾**：是否同时预注入知识又要求"按需读取"？= ✗
- [ ] **工具描述**：是否手动列出 OMP 内置工具？= ✗（OMP 自动注入）

### 架构原则
- [ ] **单文件优先**：所有约束是否能在 AGENTS.md 内表达？能 = 合并
- [ ] **JIT 检索**：产品知识/模板是否转为"按需 read"而非预注入？
- [ ] **分层幻觉**：多层 rule/skill 文件对 LLM 是否只是拼接后的长字符串？是 = 合并

## Step 3: 输出诊断报告

按以下格式向用户报告：

```markdown
## Prompt 诊断报告

### 现状
| 维度 | 当前 | 建议 |
|------|------|------|
| 文件数 | N | ≤ 3 |
| always-injected 行数 | N | ≤ 200 |
| 重复内容 | 有/无 | 无 |
| 成功标准 | 有/无 | 有 |
| ... | ... | ... |

### 问题
1. [问题描述]
2. [问题描述]

### 建议操作
1. [具体操作：合并 X 到 Y]
2. [具体操作：删除 Z]
3. [具体操作：添加成功标准]
```

## Step 4: 执行优化（用户确认后）

### 4.1 合并
将所有 always-injected 的内容（rules、skills 中的 alwaysApply 项）合并进 AGENTS.md：
- 按 Karpathy 风格组织：编号段落 + tagline
- 每段 5-8 条 bullet
- 去除重复内容
- 保留产品核心知识（如产品定位、硬约束），但将详细参考文档转为 JIT

### 4.2 清理
- 删除已合并的 rule 文件（`.omp/rules/` 下被吸收的 .md）
- 删除已合并的 skill 目录（`.omp/skills/` 下已吸收的 alwaysApply skill）
- 保留作为参考的 skill（非 alwaysApply，按需 read）
- 删除空的 `.omp/rules/` 目录

### 4.3 添加成功标准
在 AGENTS.md 末尾添加：
```
## N. Success Criteria
These guidelines are working if: [3 条可观察的行为变化]
```

## Step 5: 验证

优化后报告最终结构：
```
WORKSPACE/
├── AGENTS.md          ← 唯一 always-injected 文件（~80-150 行）
├── USER.md            ← 知识库（按需 read）
└── .omp/
    └── skills/        ← 参考文档（按需 read，非 always-injected）
```

对比表：

| 维度 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| always-injected 文件 | N | 1 | -N |
| always-injected 行数 | N | ~80-150 | -N% |
| 重复内容 | 有 | 无 | 消除 |
| 成功标准 | 无 | 有 | 新增 |
