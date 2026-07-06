---
name: validate-agent
title: Agent Directory Validation
description: >
  Validate an agentDir structure for completeness, file format, and MECE ownership compliance.
  Use this when the user asks to "validate an agent", "check agent", "audit agent", or
  when they run `omp agent validate --dir <path>`.
---

# Validate Agent Directory

## Quick Run

Run the bundled validation script to perform ALL deterministic checks in one call:

```bash
bash <(cat skill://validate-agent/validate.sh) <agentDir> [--fix]
```

The script outputs structured lines:
```
ERROR:<file>:<message>     # Agent is non-functional — must fix
WARN:<file>:<message>      # Quality issue — should fix
FIXED:<file>:<message>     # Auto-repaired (only with --fix)
PASS:<count> FAIL:<count> WARN:<count>   # Summary line
```

`exit 0` = no errors (warnings OK), `exit 1` = errors exist.

## Procedure

### 1. Run the script

Run `validate.sh <agentDir> [--fix]`. Capture the full output.

### 2. Interpret results

- **ERROR** entries → report to user, agentDir is non-functional
- **WARN** entries → report to user as quality suggestions
- **FIXED** entries (with `--fix`) → confirm what was auto-repaired
- Exit code 1 → set `valid: false`

### 3. Optional: Semantic audit (`--semantic`)

If the user also requests a semantic audit, load ALL prompt files from the agentDir and send them to the configured model with these instructions:

Analyze for:
| Rule | Check |
|---|---|
| S1 | Identity conflicts across files |
| S2 | Content duplication across files |
| S3 | Fact repetition within files |
| S4 | Tool coverage gaps |
| S5 | Datasource accuracy (stale URLs) |
| S6 | Task lists out of sync with TODO.md |
| S7 | Mission drift from original purpose |

Ask the model to return structured violations (severity, file, message, suggestion).

### 4. Report

Summarize grouped by severity:

```
===== 校验结果 =====
目录: <agentDir>
是否通过: <yes/no>

[错误] <file> — <message>
[警告] <file> — <message>

<修复摘要> (if --fix was used)
```

## Checks covered by the script

| Check | Severity | Auto-repair |
|---|---|---|
| Always-on files (5) | error | — |
| Runtime hard dep (.omp/config.yml) | error | — |
| Recommended files (3) | warning | — |
| prompt-includes.json format | error | — |
| .omp/config.yml format | error | — |
| R1: skeleton placeholder residue | warning | remove lines |
| R2: tool list in mission.md | warning | replace with ref |
| R3: hard constraint duplication | warning | remove dupes |
| R4: alidocs URLs in mission.md | warning | remove + add ref |
| R5: dws commands in TOOLS.md | warning | remove + add ref |
| R6: old skills path format | warning | replace path |
| R7: File Map accuracy | warning | — |
| R8: deprecated .agent/ dir | error | rm -rf |
