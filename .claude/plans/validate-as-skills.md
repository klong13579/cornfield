# omp agent validate → Skill-Based Rule Engine

## 设计概述

将 `agent validate` 的硬编码校验规则拆成磁盘上的 skill 文件（`.omp/skills/validate-rules/<name>/SKILL.md`），保留确定性执行引擎。引擎加载 skill → 解析 frontmatter → 按 check type 调度检查 → 汇总结果。

## 规则存储

- **源文件**: `packages/coding-agent/src/validate-rules/<name>/SKILL.md`
- **运行时路径**: `~/.omp/skills/validate-rules/<name>/SKILL.md`
- 用户手动复制/管理，无自动安装

## Frontmatter Schema

```yaml
---
name: no-skeleton-placeholder          # rule id
title: 无骨架占位符残留               # 展示用
severity: error|warning
description: 模板生成的占位符不应残留  # 详细说明

check:
  # 五种 type 之一:
  type: fileExists | fileNotContains | fileIsValidJson | fileIsValidYaml | builtin

  # fileExists / fileNotContains:
  targets:
    - AGENTS.md
    - mission.md

  # fileNotContains 额外:
  patterns:
    - (<机器人名>)
    - (⚠️\s*\*\*请编辑本文件)

  # fileIsValidJson / fileIsValidYaml 额外:
  target: prompt-includes.json
  schema:                              # JSON 特有: 验证顶层字段
    requiredTopLevel: files

  # builtin 额外:
  handler: filemap-accuracy

  # 所有 type 通用的错误消息模板（{file} {match} {line} 变量）:
  errorMessage: "骨架占位符残留: {match}"

repair:                                # 可选
  type: removeMatchingLines | replaceText | rmdir
  # removeMatchingLines: 删除匹配 pattern 的行
  # replaceText:         find-and-replace
  #   old: ".omp/skills/<name>.md"
  #   new: ".omp/skills/<name>/SKILL.md"
  # rmdir:               递归删除目录
  #   path: ".agent"
  message: "已修复"                    # 修复描述
---
```

## 规则清单

| Skill 目录 | check type | repair | 说明 |
|---|---|---|---|
| `always-on-files` | fileExists | — | AGENTS.md, mission.md, TOOLS.md, TODO.md, knowledge/external-workspaces.md |
| `runtime-hard-deps` | fileExists | — | .omp/config.yml, prompt-includes.json |
| `runtime-recommended` | fileExists | — | .gitignore, .omp/SYSTEM.md |
| `format-json` | fileIsValidJson | — | prompt-includes.json 合法 + 有 `files` 顶层字段 |
| `format-yaml` | fileIsValidYaml | — | .omp/config.yml 合法 |
| `no-skeleton-placeholder` | fileNotContains | removeMatchingLines | 占位符文本残留 |
| `no-tool-list-in-mission` | fileNotContains | removeMatchingLines | TOOLS.md 职责移入 mission.md |
| `no-safety-duplication` | builtin | — | AGENTS.md 硬约束 × SYSTEM.md 交叉检查 |
| `no-space-urls-in-mission` | fileNotContains | removeMatchingLines | alidocs URL 应在 external-workspaces.md |
| `no-dws-commands-in-tools` | fileNotContains | removeMatchingLines | dws 命令应在 skill://dws |
| `skills-path-format` | fileNotContains | replaceText | AGENTS.md 中旧路径 <name>.md → <name>/SKILL.md |
| `filemap-accuracy` | builtin | — | AGENTS.md File Map 与磁盘文件一致性 |
| `no-deprecated-agent-dir` | builtin | rmdir | .agent/ 目录已废弃，应迁移到 .omp/ |

## 引擎组件（新建文件）

### `packages/coding-agent/src/validate-rules/engine.ts`

```typescript
export interface ValidateRule {
  name: string;
  title: string;
  severity: "error" | "warning";
  description: string;
  check: FileExistsCheck | FileNotContainsCheck | FileIsValidJsonCheck | FileIsValidYamlCheck | BuiltinCheck;
  repair?: RemoveMatchingLinesRepair | ReplaceTextRepair | RmdirRepair;
}

// 加载所有规则
export async function loadValidateRules(rulesDir: string): Promise<ValidateRule[]>;

// 执行单条规则，返回 violation 列表
export async function executeRule(rule: ValidateRule, agentDir: string): Promise<RuleViolation[]>;

// 执行 repair，返回修复摘要
export async function executeRepair(repair: RuleRepair, agentDir: string, violations: RuleViolation[]): Promise<string>;

// 内置 handler 注册表
const BUILTIN_HANDLERS: Record<string, (agentDir: string) => Promise<RuleViolation[]>>;
```

### 调整 `packages/coding-agent/src/cli/agent-cli.ts`

- 引入 `loadValidateRules` + `executeRule`
- `runAgentValidate` 改为遍历规则而非硬编码检查
- 保留 `runSemanticPhase` 不变（`--semantic` 仍为 LLM audit）

### 删除 `packages/coding-agent/src/cli/mece-rules.ts`

替换为 13 个 skill 文件 + engine.ts。

## 不改变的部分

- `semantic-audit.ts` 和其 system prompt（`--semantic` 流程不变）
- `commands/agent.ts` CLI 参数不变（`--dir`, `--fix`, `--semantic`, `--json`）
- `agent-cli.test.ts` 测试需要更新（改从 skill 文件加载而非直接调用 mece-rules）
- `ValidateResult` / `ValidateIssue` 接口结构不变
