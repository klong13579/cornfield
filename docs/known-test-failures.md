# 已知测试失败清单（更新 2026-08-26）

> 状态：不阻塞发布（release 已与 test job 解耦）。`check`/`native`/`release_binary` 全绿。
> 本次更新：删除 7 个冗余/假路径测试、修复 10 个（mock 补齐/期望对齐）。
> 剩余失败 = 功能行为验证类 + 环境依赖类，均需**功能判断**（不是期望值错误）。

## 当前总数

`bun --cwd=packages/coding-agent test`：**3984 测试，31 fail**（48 → 31，-17）。

剩余 31 个按根因分组：

---

## 1. 功能行为验证类（实现行为 vs 测试期望，需团队判断对错）

### 1a. createAgentSession MCP discovery ×6 — `test/sdk-mcp-discovery.test.ts`
激活工具列表包含 9-11 个工具（read/intercom/write_memory/...），测试期望 `expect.arrayContaining` 语义或精确列表不符。
**问题**：discovery 模式下激活工具集的实际构成与测试假设不同。

### 1b. ModelRegistry ×5 — `test/model-registry.test.ts`
canonical 变体归并（claude-opus-latest → claude-opus-4-7）、baseUrl 覆盖、模型 merge、discovered 字段继承——mock fixture 期望的归并/覆盖逻辑与实现不符。
**问题**：canonicalization 行为的预期 family 归属需确认。

### 1c. AgentSession retry fallback ×3 — `test/agent-session-retry-fallback.test.ts`
期望 fallback 链走 `openai/gpt-4o-mini` → `openai/gpt-4o`，实际三次全请求主模型 `anthropic/claude-sonnet-4-5`——**fallback 未触发**（模型存在，机制性问题）。
**问题**：fallback 链在测试场景下不生效。

### 1d. AgentSession replay ×2 — `test/agent-session-openai-responses-replay.test.ts`
reload 后期望模型切换为新保存值（openai/gpt-5-mini、openai/gpt-5.4-mini），实际仍保持旧模型（openai-codex/gpt-5-mini）——**reload 未反映模型变更**。
**问题**：`session.reload()` 后的模型状态同步。

### 1e. memories runtime ×3 — `test/memories-runtime.test.ts`
MEMORY.md 内容（期望 "Consolidated body" 实际含 V3 节）+ 清理行为（old.md 未删、MEMORY.md 未删）——~3 秒 waitFor 超时边缘。
**问题**：phase2 输出/清理行为与期望不符或过慢。

### 1f. 其他 ×7
- `createTools` search_tool_bm25（MCP discovery 未产出）
- `edit tool CRLF` BOM 保留
- `EventController idle` `#handleAgentEnd` 崩溃（`this.ctx` undefined——**疑似真 bug**）
- `createAgentSession skills option`（sdk-skills，5 秒超时——MCP server 加载）
- `issue #846` logger.error 未触发（3 秒边缘）
- `RPC lifecycle` start-after-stop 错误消息不符
- `协议批 B-3` 命令描述空

## 2. 环境/数据依赖类（≤8）

- `wire-server-skills` ×3：缺 `demo-user-skill` seed 数据
- `W3 D3 get_memory`：memoryRoot 真实路径期望
- `resolveActiveProjectRegistryPath`：tmp 目录无 `.git` 的 fallback 路径
- `createAgentSession skills option` 超时（MCP server 启动）

---

## 已删除（2026-08-26，用户确认）

|目标|理由|
|---|---|
|`test/tools/python-fallback.test.ts` + `python-tool-mode.test.ts`|与 `python-tool-settings.test.ts` 重复（同 describe 同断言）|
|`agent-session-handoff.test.ts` ×3 it（uses handoff strategy / completes threshold auto-handoff / falls back to context-full）|设计缺陷：`emitExternalEvent` 模拟不触发真实 handoff 流程（compaction/handoff 只在真实 prompt 路径运行）|
|`agent-session-auto-compaction-x-initiator.test.ts` ×2 it（主/子会话 agent attribution）+ 相关未用辅助函数|同设计缺陷：compaction 事件链不触发 → 5 秒超时|

## 已修复（2026-08-26）

|组|数量|修法|
|---|---|---|
|python tool 期望|2|期望列表补 `identity` 工具（新工具未更新测试）|
|SessionStore|6|mock 补 `getMessageEntryIdMap`；幂等测试对齐 `isStreaming` phase 联动设计（idle 强制 false）|
|registry 版本|1|`version` 期望 1 → 2（注册表演进）|

---

## 复现方式

```bash
# 用 workspace cwd（不要从仓库根跑——根目录 24.7 万文件触发 bun fd bug，spawn pipe 全空误报）
bun --cwd=packages/coding-agent test
```

## 修复后恢复发布门禁

`test` job 全绿后，把 `.github/workflows/ci.yml` 中 `release_binary`/`release_desktop` 的 `needs` 加回 `test`：

```yaml
needs: [check_latest_tag, check, native, test]
```