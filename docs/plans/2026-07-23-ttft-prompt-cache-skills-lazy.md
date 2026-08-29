# TTFT 优化：Prompt 构建缓存 + Skills 按需加载

**Status**: 方案设计  
**Date**: 2026-07-23  
**Scope**: OMP prompt assembly 层（`packages/coding-agent/src/system-prompt.ts`）  
**Reference**: Hermes Agent v0.19 Quicksilver（PR #59332, #59389, #3395, #3421）

---

## 1. 背景

### 1.1 当前 TTFT 基线（hr3 agent，deepseek-v4-flash）

| 场景 | TTFT | 输入 tokens |
|---|---|---|
| 新会话首条 | 3,816ms | 69,534 |
| 后续消息（cache hit） | 1,590–1,831ms | 45–470 新增 |

瓶颈排序：
1. **Prompt 体积过大**（~69K tokens，其中 OMP 框架注入占 ~51K）
2. **Gateway 前处理延迟**（~750ms，含 session 旋转 + 附件下载 + prompt 拼接）
3. **冷启动 cache miss**（session 重置后 prompt 需完整重建）

### 1.2 Hermes v0.19 的启示

Hermes 用 cProfile 对真实进程做了 profiling，发现 TTFT 瓶颈不在模型推理，而在「发起 API 请求之前」的阻塞操作。核心方法论：

> 把工作从关键路径上移走，而非试图让工作本身更快。

关键优化：
- **Prompt 构建缓存**（#3421）：进程内 LRU + 磁盘快照，同进程复用 <1ms，冷启动 297ms → 103ms
- **Skills 按需加载**（#3421 隐含）：skills 内容不在启动时全量注入，而是按需读取
- **后台预热**（#59332）：CLI 在用户打字时后台预 import 和预构建 prompt

---

## 2. 当前 OMP Prompt 构建流程

参考 `docs/omp-prompt-assembly-v1.0.md`，当前流程：

```
buildSystemPrompt()
  → loadProjectContextFiles()       // 读 AGENTS.md / TOOLS.md / mission.md 等
  → loadCapability("context-files") // 多个 discovery provider
  → dedupeExactContextFiles()       // 按内容去重
  → extractNeverRules()             // 提取 MUST NOT 硬约束
  → prepareContextFilesForPrompt()  // 剥离 NEVER 行
  → prompt.render(system-prompt.md) // Handlebars 渲染
```

**关键问题**：每次 `buildSystemPrompt()` 调用都从头执行完整链路。Session 重置时（240min 空闲 / 凌晨 2 点），即使所有 prompt 文件未变，也全量重建。

---

## 3. 方案 A：Prompt 构建缓存（2a）

### 3.1 设计

参照 Hermes #3421 的两层缓存架构：

```
                    ┌─────────────────────┐
                    │  buildSystemPrompt() │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  mtime 校验          │
                    │  (所有 prompt 文件)   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ 未变化    │    │ 变化      │    │ 无缓存    │
        │ → 命中    │    │ → 重建    │    │ → 重建    │
        └────┬─────┘    └────┬─────┘    └────┬─────┘
             │               │               │
             ▼               └───────┬───────┘
        ┌──────────┐                 │
        │ 返回缓存  │                 ▼
        └──────────┘        ┌──────────────┐
                            │ 渲染 + 写缓存  │
                            └──────────────┘
```

### 3.2 缓存层

**进程内 LRU 缓存**（`system-prompt.ts` 内）：

```typescript
// 伪代码
const promptCache = new LRUCache<string, PromptCacheEntry>({
  max: 8,  // 最多 8 个 agent 的 prompt（gateway 多账号场景）
});

interface PromptCacheEntry {
  prompt: string;
  manifest: Record<string, { mtime: number; size: number }>;
  builtAt: number;
}
```

- Key：`contextFiles` 的文件路径列表的排序后 SHA-256
- 同进程内同 agent 复用：**<1ms**
- 多 agent（gateway 多账号）：独立缓存条目，不互相污染

**磁盘快照**（可选，冷启动加速）：

```
~/.cornfield/gateway-data/prompt-cache/<agent-hash>.json
```

- 存储已渲染的 prompt 文本 + 文件 manifest
- 新进程启动时校验 mtime/size，命中则直接读磁盘 → **<50ms**
- 不命中则走完整渲染，结果写回磁盘

### 3.3 缓存失效策略

| 触发条件 | 动作 |
|---|---|
| `prompt-includes.json` 中任意文件 mtime 变化 | 重建该 agent 的缓存 |
| `SYSTEM.md` mtime 变化 | 重建 |
| `SKILL.md` 任意文件 mtime 变化 | 重建（或仅重建 skills 段，见方案 B） |
| `user.md` mtime 变化 | 重建 |
| OMP 框架 `system-prompt.md` 模板 mtime 变化 | 全局清空所有缓存 |
| 磁盘快照超过 24h 未命中 | 异步清理（不阻塞请求） |

### 3.4 改动范围

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/system-prompt.ts` | 添加 LRU 缓存 + mtime 校验逻辑 |
| `packages/coding-agent/src/prompt-cache.ts`（新文件） | 缓存实现 + 磁盘快照 |
| `packages/coding-agent/test/prompt-cache.test.ts`（新文件） | 缓存命中、失效、磁盘读写测试 |

### 3.5 预期收益

| 场景 | 当前 | 优化后 |
|---|---|---|
| 同进程第二次 buildSystemPrompt（cache hit） | ~300ms | **<1ms** |
| 新进程，文件未变（磁盘快照命中） | ~300ms | **<50ms** |
| 文件变化（cache miss） | ~300ms | ~300ms（无回退） |

**对用户感知 TTFT 的影响**：Session 重置后的冷启动场景（每天至少 1 次），Gateway 前处理从 ~750ms → ~500ms。

---

## 4. 方案 B：Skills 按需加载（2b）

### 4.1 当前状态

7 个 SKILL.md 文件在每次 prompt 构建时全量解析并注入到 `<skills>` 区块（~4,000 tokens）。无论当前对话是否触发这些 skill，都占用 prompt 体积。

参考 `omp-prompt-assembly-v1.0.md` §3.4：

```
118|az. 5. Conditional guides: intent tracing, MCP discovery, python/bash priority, …
```

当前 skills 在 Handlebars 模板中通过 `{{#each skills}}` 渲染，每个 skill 输出其 `name` + `description` + 完整 `SKILL.md` 内容。

### 4.2 设计

**启动时**：只注入 skill 名称 + 一句话描述（`description` 字段），不注入完整 SKILL.md。

**运行时**：当 agent 调用 `read("skill://<name>")` 时，才读取并注入完整 SKILL.md 内容。

改动点：

1. **Skill 索引**：`{{#each skills}}` 只渲染 `name` + `description` 摘要行
2. **SKILL.md 懒加载**：`skill://` URI 解析时，检查是否已注入，未注入则追加到当前 prompt 的 `<skills>` 区块
3. **缓存**：同进程内已加载的 skill 不重复读取

### 4.3 实现细节

**现有 skill 数据结构**（`packages/coding-agent/src/skills/`）：

```typescript
interface Skill {
  name: string;
  path: string;        // SKILL.md 文件路径
  description: string;  // 一句话描述
  // ... 其他字段
}
```

**修改 Handlebars 模板**（`system-prompt.md`）：

```diff
- {{#each skills}}
- <skill name="{{name}}">
- {{content}}
- </skill>
- {{/each}}
+ {{#each skills}}
+ - `skill://{{name}}` — {{description}}
+ {{/each}}
```

**懒加载实现**（`skill://` URI 解析器）：

```typescript
// resolvers/skill.ts
async function resolveSkillUri(uri: string): Promise<string> {
  const skillName = parseSkillName(uri);
  
  // 检查是否已加载
  if (loadedSkills.has(skillName)) {
    return loadedSkills.get(skillName)!;
  }
  
  // 读取 SKILL.md
  const skillPath = findSkillPath(skillName);
  const content = await readFile(skillPath);
  
  // 解析 frontmatter + 正文
  const parsed = parseSkillMarkdown(content);
  
  // 缓存
  loadedSkills.set(skillName, parsed.body);
  
  // 注入到当前 prompt 的 <skills> 区块
  injectSkillIntoPrompt(skillName, parsed);
  
  return parsed.body;
}
```

### 4.4 兼容性

- `skill://` URI 的行为不变：agent 调用 `read("skill://dws")` 仍然返回完整 SKILL.md
- 差异仅在于：SKILL.md 内容不再在启动时预注入，而是在首次触发时注入
- 对 agent 行为无影响，因为 agent 必须通过 `skill://` URI 读取 skill 内容

### 4.5 改动范围

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/prompts/system/system-prompt.md` | 修改 `{{#each skills}}` 区块 |
| `packages/coding-agent/src/resolvers/skill.ts`（或等价文件） | 添加懒加载 + 缓存逻辑 |
| `packages/coding-agent/src/skills/` | 可能需要调整 skill 数据结构 |
| `packages/coding-agent/test/skill-lazy-load.test.ts`（新文件） | 懒加载、缓存、并发测试 |

### 4.6 预期收益

| 指标 | 当前 | 优化后 |
|---|---|---|
| Skills 区块 token 数 | ~4,000 | ~200（仅名称+描述） |
| Prompt 总 token 数 | 69,534 | ~65,500（-6%） |
| Skill 首次触发延迟 | 0ms（已预加载） | +50-100ms（读文件） |
| Skill 二次触发延迟 | 0ms | 0ms（已缓存） |

---

## 5. 组合效果预估

| 场景 | 当前 TTFT | 仅 2a | 仅 2b | 2a + 2b |
|---|---|---|---|---|
| 新会话首条 | 3,816ms | 3,566ms | 3,600ms | **3,350ms** |
| Session 重置（文件未变） | 3,816ms | **3,566ms** | 3,600ms | **3,350ms** |
| 后续消息（cache hit） | 1,600ms | 1,600ms | 1,550ms | **1,500ms** |

> 注：以上为 LLM 层 TTFT 估算。Gateway 前处理延迟（~750ms）额外减少约 250ms（2a 缓存命中时）。

---

## 6. 实施优先级与依赖

| 步骤 | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| 1 | 对 `buildSystemPrompt()` 跑 cProfile，确认各环节精确耗时 | 无 | 0.5 天 |
| 2 | 实现 2a（进程内 LRU 缓存） | 步骤 1 数据 | 1 天 |
| 3 | 实现 2a（磁盘快照） | 步骤 2 | 0.5 天 |
| 4 | 实现 2b（Skills 按需加载） | 无（独立） | 1 天 |
| 5 | 集成测试 + 回归 | 步骤 2-4 | 1 天 |

**总计**：3-4 天。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 缓存失效遗漏导致 prompt 过期 | mtime 校验覆盖所有 prompt 文件；磁盘快照 24h 强制过期 |
| Skills 懒加载导致首次触发延迟 | 触发时延迟 <100ms，且同进程缓存，影响可接受 |
| 多 agent 并发缓存竞争 | LRU 用 `OrderedDict` 实现，单线程无锁 |
| 磁盘快照占用空间 | 单 agent 快照 ~70KB，8 agent 约 560KB，可忽略 |

---

## 8. 参考

- Hermes Agent #3421: [perf(ttft): cache skills prompt with shared skill_utils module](https://github.com/NousResearch/hermes-agent/pull/3421)
- Hermes Agent #59332: [perf: cut first-turn time-to-first-token by ~80%](https://github.com/NousResearch/hermes-agent/pull/59332)
- Hermes Agent #59389: [perf(cli): TTFT round 2](https://github.com/NousResearch/hermes-agent/pull/59389)
- OMP Prompt Assembly v1.0: `docs/omp-prompt-assembly-v1.0.md`
- OMP System Prompt Builder: `packages/coding-agent/src/system-prompt.ts`