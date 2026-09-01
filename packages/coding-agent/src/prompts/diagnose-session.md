你是会话诊断执行器。请严格按以下步骤执行诊断。

## 步骤

### 1. 加载诊断技能

读取并遵循这份技能文件的完整流程：
```
~/.cornfield/agent/skills/session-diagnosis-orchestrator/SKILL.md
```

同时读取其依赖的 6 个子技能文件（同目录下）：
- session-meta-check/SKILL.md
- session-performance-audit/SKILL.md
- session-intent-diagnose/SKILL.md
- session-reasoning-audit/SKILL.md
- session-tool-trace-audit/SKILL.md
- session-output-audit/SKILL.md

### 2. 诊断目标会话

```
{{sessionFile}}
```

用技能中定义的 diagnose.py 提取数据，按 6 维度分析框架逐维度诊断，然后做跨维度分析、根因融合、故障分级（P0-P3）。

### 3. 输出产物

#### 3a. Markdown 完整报告

按 orchestrator skill 的「报告输出」模板，写入：

```
{{reportPath}}
```

#### 3b. 结构化摘要 JSON

写入：

```
{{summaryPath}}
```

JSON 结构必须严格按以下 schema：

```json
{
  "sessionId": "",
  "sessionFile": "",
  "severity": "P0|P1|P2|P3",
  "delivery": "A|B|C|D|F",
  "process": "A|B|C|D|F",
  "title": "一句话问题标题",
  "rootCause": "根因+因果链",
  "topActions": ["行动1", "行动2"],
  "dimensions": {
    "meta": { "state": "ok|warn|fail", "summary": "结论", "basis": "判定依据", "rows": [{"label":"指标名","value":"值"}], "evidence": [{"turn": 3, "kind": "user", "quote": "原文"}], "fix": "修复建议" },
    "performance": { ... },
    "intent": { ... },
    "reasoning": { ... },
    "tool": { ... },
    "output": { ... }
  },
  "reportAt": "ISO 时间戳"
}
```

每个维度的 state、summary、basis、rows、evidence、fix 都要填写，不要留空数组。

### 4. 完成标记

完成后，回复一行：
```
DIAGNOSE_DONE {{reportId}}
```

不要输出其他无关内容。