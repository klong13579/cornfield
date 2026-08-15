# Compaction 优化：对标 Hermes Agent

**Status**: 实施方案  
**Date**: 2026-07-23  
**Scope**: compaction 触发策略、多层防御、空闲压缩、per-model 阈值  
**Reference**: Hermes Agent context-compressor (50% threshold, dual-layer, idle compaction)

## 1. 现状问题

| 问题 | 表现 | 根因 |
|---|---|---|
| TTFT 随 session 持续恶化 | 从 4.4s 逐步升到 8-9s（29 turn） | 默认阈值过高（~85%），compaction 触发太晚 |
| 无空闲压缩 | 用户离开回来，首条消息仍加载全部 context | 没有配置驱动的空闲检查 |
| 无 per-model 策略 | 所有模型共用同一个阈值 | `modelThresholds` 不存在 |
| 尾部保护固定 | `keepRecentTokens: 20000` 与 context window 无关 | 没有比例配置 |
| 无防抖动 | 短时间内可能多次 compaction | 没有 cooldown |

## 2. 实施步骤

### 步骤 1：改默认阈值（已执行）

```yaml
# ~/.omp/agent/config.yml
compaction:
  thresholdPercent: 50    # 从 75 降到 50
```

```yaml
# hr3 agent
compaction:
  thresholdPercent: 50
```

预期效果：128K 模型触发点从 ~109K 降到 ~64K。约 20-25 个 turn 触发一次 compaction。TTFT 从持续恶化变为周期性回落。

观察 2-3 天，检查：
- gateway session TTFT 是否改善
- agent 行为是否有退化（丢失上下文导致答非所问）
- 是否有 compaction 失败/异常

### 步骤 2：Gateway 层安全网（1 天）

**范围**：gateway 模式 only

**改动点**：`packages/omp-gateway/src/agent-bridge.ts`

```typescript
// getOrCreateSession 时检查
if (session.entries.length >= 4) {
  const lastUsage = getLastUsageFromEntries(session.entries);
  if (lastUsage?.input > contextWindow * 0.80) {
    await session.compact("auto: gateway hygiene - context too large");
  }
}
```

- 80% 阈值（高于 agent 内 50%，安全网）
- 只检查 `entries.length >= 4`（避免短 session 误触）
- 不阻塞消息流转（fire-and-forget 或在消息排队时后台执行）

### 步骤 3：空闲压缩配置化（1 天）

**改动点**：

1. `packages/coding-agent/src/config/settings-schema.ts`：新增 `compaction.idleCompactAfterSeconds`

```yaml
"compaction.idleCompactAfterSeconds":
  type: "number"
  default: 0  # 0 = disabled
```

2. `packages/coding-agent/src/session/agent-session.ts`：

```typescript
// prompt() 入口
const idleSeconds = (Date.now() - this.#lastActivityTime) / 1000;
const idleSetting = this.settings.get("compaction.idleCompactAfterSeconds");
if (idleSetting > 0 && idleSeconds > idleSetting) {
  const contextTokens = estimateMessagesTokens(this.agent.state.messages);
  const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
  const targetRatio = this.settings.get("compaction.targetRatio") ?? 0.20;
  if (contextTokens > threshold * targetRatio) {
    await this.#runAutoCompaction("idle", false);
  }
}
```

### 步骤 4：Per-model 阈值（0.5 天）

**改动点**：

1. `packages/coding-agent/src/config/settings-schema.ts`：新增 `compaction.modelThresholds`

```yaml
"compaction.modelThresholds":
  type: "object"
  default: {}
```

2. `packages/coding-agent/src/session/compaction/compaction.ts`：`resolveThresholdTokens` 增加 modelId 参数

```typescript
export function resolveThresholdTokens(
  contextWindow: number, 
  settings: CompactionSettings, 
  modelId?: string
): number {
  if (modelId && settings.modelThresholds) {
    const matchedKey = Object.keys(settings.modelThresholds)
      .filter(k => modelId.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (matchedKey) {
      return Math.floor(contextWindow * settings.modelThresholds[matchedKey]);
    }
  }
  // 原逻辑
}
```

### 步骤 5：动态尾部保护 + 防抖动（0.5 天）

**尾部保护动态化**：

```yaml
# 新增配置
compaction:
  targetRatio: 0.20     # 尾部保护 = threshold × targetRatio
  keepRecentTokens: 0   # 0 = 自动计算
```

```typescript
export function resolveKeepRecentTokens(thresholdTokens: number, settings: CompactionSettings): number {
  if (settings.keepRecentTokens > 0) return settings.keepRecentTokens;
  return Math.floor(thresholdTokens * (settings.targetRatio ?? 0.20));
}
```

**防抖动**：

```typescript
// agent-session.ts 新增
#lastCompactionTime = 0;
readonly #COMPACTION_COOLDOWN_MS = 60_000;

// #tryAutoCompact 中
if (Date.now() - this.#lastCompactionTime < this.#COMPACTION_COOLDOWN_MS) return;
```

### 步骤 6：Tool 预裁剪集成（0.5 天）

当前 `pruneToolOutputs()` 在 compaction 检查前独立调用。改为集成进 `prepareCompaction`：

```typescript
export function prepareCompaction(entries, settings) {
  if (settings.pruneBeforeCompaction !== false) {
    pruneToolOutputs(entries, settings);
  }
  // 原逻辑
}
```

## 3. 收益预估

| 步骤 | 优化 | 预期 TTFT 改善 | 范围 |
|---|---|---|---|
| 1 | 阈值 50% | -1,000~1,500ms | 全模式 |
| 2 | Gateway 安全网 | 溢出保护（极端场景） | gateway only |
| 3 | 空闲压缩 | 恢复后首条 -1,000~2,000ms | 全模式 |
| 4 | Per-model 阈值 | 慢模型额外 -500~1,000ms | 全模式 |
| 5 | 动态尾部 + 防抖 | 避免过度 compaction / 质量退化 | 全模式 |
| 6 | Tool 预裁剪 | compaction 质量改善 | 全模式 |

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Compaction 过于频繁导致 LLM 调用成本上升 | 防抖动 cooldown 限制频率；观察后调高 thresholdPercent |
| 频繁 compaction 导致上下文丢失 | 动态尾部保护确保最近 20-30% 上下文保留；appenedPrompt 可保留关键信息 |
| 空闲压缩误触（用户刚离开一分钟回来就压缩） | `idleCompactAfterSeconds` 默认 0，用户手动启用 |

## 5. 进度

- [x] 步骤 1：改阈值（hr3 + ~/.omp 已应用）
- [ ] 步骤 2：Gateway 层安全网
- [ ] 步骤 3：空闲压缩配置化
- [ ] 步骤 4：Per-model 阈值
- [ ] 步骤 5：动态尾部保护 + 防抖动
- [ ] 步骤 6：Tool 预裁剪集成
