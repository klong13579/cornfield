# SKILL.md 写作模板 — v1.0

本模板是将 [`writing-great-skills`](SKILL.md) 的原理转化为可填充骨架的实操指南。共包含 6 种 Skill 原型，根据你的场景选择最贴近的一个，删除其他无用部分，填充占位符即可。

> 开始之前建议先读 `skill://writing-great-skills` 熟悉关键概念（leading word、progressive disclosure、completion criterion、no-op）。

---

## 选型速查

| 你的 Skill 符合… | 用这个原型 | 典型例子 |
|------------------|-----------|---------|
| 检测用户意图类型，根据类型走不同路径 | **Branch** | `grilling`（user / task / design） |
| 只有一种场景、按固定步骤执行 | **Process** | `tdd`、`diagnose` |
| 由另一个 skill 委派过来，不做自己工作 | **Routing** | `grill-me`（→ `grilling`） |
| 主体是规则、定义、对照表，无固定步骤 | **Reference** | `domain-modeling`、这个文件本身 |
| 先做检查清单，通过后才能继续 | **Gate** | `context-mode-ops`（claim verification / TDD / grill-me 三道门） |
| 每次调用产出固定格式的文档 | **Template** | `to-prd`、`to-issues` |

> 也可以混合：Process 尾部加 Gates 段落、Branch 每个分支底部套 Template——但守住**一个文件只有一个主线结构**。

---

## 原型 A — Branch（分支）

适用于：Skill 需要根据输入上下文走不同的执行路径。

```yaml
---
name: <kebab-case-name>
description: >-
  When the user wants to <trigger 1>, <trigger 2>, or <trigger 3>,
  identify the intent type and follow the corresponding branch.
  Skip if <explicit out-of-scope condition>.
---

# <Title>

> <Leading word — 一个能锚定整个 skill 的预训练概念。可选但有力。>

## Which

根据上下文判断用户意图类型：

- **type A** — `<识别条件>` → 走 [Branch A](#branch-a)
- **type B** — `<识别条件>` → 走 [Branch B](#branch-b)

如果不能确定，问一个问题来区分，然后走对应的分支。

## Branch A

<本分支做什么的简短描述>

### Outcome

<可核查的完成标准>

### Procedure

1. <Step 1 — 做什么>
   - <完成标准：何时可以进入下一步>
2. <Step 2>

### Pitfalls

- <常见错误>
- <反模式>

## Branch B

<同上结构>

### Outcome
### Procedure
### Pitfalls

## 什么时候不该用

- <具体的不适用场景>
- <与其他 skill 的边界>
```

---

## 原型 B — Process（流程）

适用于：一个确定场景、固定步骤序列。

```yaml
---
name: <kebab-case-name>
description: >-
  When the user <trigger>, follow a strict sequence of steps to
  <what the skill achieves>. Skip if <explicit out-of-scope condition>.
---

# <Title>

> <Leading word>

## Outcome

<完成本 skill 后交付什么——可核查的完成标准。>

## Procedure

### Step 1 — <步骤名>

<做什么>

完成标准：<可核查条件，抵御 premature completion>。

### Step 2 — <步骤名>

<做什么>

完成标准：<同上>。

### Step 3 — <步骤名>

<做什么>

完成标准：<同上>。

## Verification

完成后逐项检查：

- [ ] Original repro no longer reproduces（如果适用）
- [ ] <其他验证项>

## Pitfalls

- <常见错误>
- <反模式>
```

---

## 原型 C — Routing（路由）

适用于：这个 Skill 本身不执行任务，只是委派给其他 Skill。

```yaml
---
name: <kebab-case-name>
description: >-
  <一段描述，说明本 skill 何时触发、委派到什么。>
  Skip if <anti-trigger>.
---

# <Title>

这是一个路由 skill。它不自己做任何工作——它把控制权转交给具体的 skill。

## Which

- **场景 A** → Read `skill://<skill-A>` and follow its instructions.
- **场景 B** → Read `skill://<skill-B>` and follow its instructions.
- **场景 C** → Read `skill://<skill-B>` then `skill://<skill-C>`, running them together.

> 路由 skill 的最佳长度：3–10 行。超过 10 行说明这里有真的工作要做，应该拆成 Process。
```

---

## 原型 D — Reference（参考）

适用于：Skill 的内容主要是规则、定义、对照表，没有固定的执行顺序。

```yaml
---
name: <kebab-case-name>
description: >-
  Reference for <what this skill covers>. Use when <trigger>.
  <When another skill needs to…>.
disable-model-invocation: <true 则用户触发；false 则模型触发>
---

# <Title>

> <Leading word>

## <Section 1>

<定义、规则、事实。Colocation 原则：同一概念的定义、规则、注意事项放在同一个段落。>

### 子条目

- <bullet 1>
- <bullet 2>

## <Section 2>

| 症状 / 条件 | 行动 / 归属 |
|-------------|------------|
| <symptom A> | <action A> |
| <symptom B> | <action B> |

## 常见误用

- <不要把这个 skill 用于…>
- <反模式>

> **引用原则**：每个概念只有一个 Single Source of Truth。不要跨文件重复定义。
```

---

## 原型 E — Gate（门）

适用于：Skill 要求在进入主要流程之前，先通过若干不可协商的检查。

```yaml
---
name: <kebab-case-name>
description: >-
  <描述。通常在描述里就标注 gate 的存在。>
---

# <Title>

## <GATE 1>: BLOCKING — <门名称>

<gate_description_enforcement>
STOP. <不可协商的规则。用 MUST / MUST NOT / REQUIRED / FORBIDDEN 写。>
</gate_description_enforcement>

<门的具体要求。包括完成标准。>

## <GATE 2>: BLOCKING — <门名称>

<同样的结构>

---

## Main Procedure

（以上 Gate 通过后才能进入。以下结构同 Process 或 Branch。）

## Verification

在交付前逐项检查：

- [ ] Gate 1 仍然满足
- [ ] Gate 2 仍然满足
- [ ] <其他项>
```

---

## 原型 F — Template（模板）

适用于：Skill 的主要产出是一个固定格式的文档。

```yaml
---
name: <kebab-case-name>
description: >-
  When the user <trigger>, produce a <document kind> using the template below.
  Skip if <anti-trigger>.
disable-model-invocation: <推荐 true>
---

# <Title>

## Process

（用 Process 或 Branch 的步骤引导到输出。）

1. <Step 1>
2. <Step 2>
3. Produce the output using the template below.

## Template

```markdown
<template-delimiter>

## <Section 1>

<占位符说明>

## <Section 2>

<占位符说明>

<template-delimiter>
```

## 填充规则

- <占位符 X → 写入什么>
- <如果数据不可用 → 怎么处理>
```

---

## 原则：脚手架化

SKILL.md 的固定结构（frontmatter、原型骨架、段落模板）不应手写。
用本 skill 目录捆绑的脚本生成初始文件，然后专注填充内容。

```bash
# 创建 Branch 原型 skill（模型触发）
~/.omp/agent/skills/writing-great-skills/create-skill my-skill \
  --archetype branch \
  --description "When the user asks to X, Y, or Z, follow intent. Skip if Q."

# 创建 Process 原型 skill（用户触发）
~/.omp/agent/skills/writing-great-skills/create-skill my-skill \
  --archetype process \
  --user-invoked

# 查看所有可用选项
~/.omp/agent/skills/writing-great-skills/create-skill --help
```

也可以创建 alias（添加到 `~/.zshrc` / `~/.bashrc`）：
```bash
alias create-skill="$HOME/.omp/agent/skills/writing-great-skills/create-skill"
```

脚本处理的事项：
- 目录创建（`<skills-root>/<name>/SKILL.md`）
- frontmatter 生成（name、description、disable-model-invocation）
- 原型骨架填充
- 引用 `writing-great-skills` 和本模板的链接

不脚本化的事项（需要 human judgment）：
- 描述的具体措辞（trigger + scope + anti-trigger）
- 步骤的内容和顺序
- 决策表的具体条目
- 反例和 Pitfalls 的写作

---

## 通用段落说明

无论用哪个原型，以下段落按需选用（不需要就删）：

### Outcome

```
<完成本 skill 后交付什么——可核查的完成标准>
```

**好**：A failing test that reproduces the bug, plus the fix commit.

**不好**：A better understanding of the bug.（不可核查）

### Completion Criterion（步骤内部的完成标准）

```
<条件，可以判断"做完"还是"没做完">
```

**好**：`Bun test` passes on the modified file.

**不好**：The implementation feels right.

### Pitfalls

```
- <常见错误>
- <反模式>
- <反例/不适用场景>
```

### Anti-triggers（在 When NOT to use / Verify / Pitfalls 中均可）

每个 Skill 都应该明确说"什么时候不使用我"。反触发器越具体越好：

**好**：Skip if the user already has a clear hypothesis and is asking for help testing it.

**不好**：Don't use for unrelated tasks.（毫无信息量——模型视为噪音）

### Verification（结尾检查清单）

```
完成后检查：
- [ ] <可核查条件>
- [ ] <同上>
- [ ] 所有 [DEBUG-*] 类 instrumentation 已清除（如果适用）
- [ ] 原始场景已不复现（如果适用）
```

---

## 决策速查表

| 问题 | 推荐 | 依据 |
|------|------|------|
| 描述怎么写？ | `When <trigger>, <verb> <scope>. Skip if <negative>.` | Anthropic 最佳实践 + claudskills 一致推荐 |
| 模型触发还是用户触发？ | 只有 agent 需要自主调用或别的 skill 需要引用时才模型触发 | context load 是有限资源 |
| 步骤还是参考？ | 有固定顺序就写步骤，没有就写参考 | 信息层次的第一刀 |
| 什么时候分拆 skill？ | 描述里出现第二个独立动词时；步骤序列超过 8 步时 | 拆细花 context load；拆粗花 cognitive load |
| 步骤的完成标准要写多仔细？ | 可核查 + 有完成感的强标准 | 抵御 premature completion |
| 描述要不要写反触发器？ | 要。Claude 在触发决策时就会读到 | 减少误触发最有效的结构 |
| 一个 skill 多长合适？ | SKILL.md body ≤ 200 行；描述 ≤ 500 字符 | OMP 导出上限 + Anthropic 建议 |
| 什么时候用 leading word？ | 能找到预训练概念的时候；找不到就造一个+定义 | Leading word 用模型已有知识锚定行为 |
| 什么时候加 linked file？ | body 超过 200 行、或某段落只被部分分支需要 | Progressive disclosure——没被用到就不进 context |
