# 采用上游 xd:// 作为 Tool 呈现协议

**Status: accepted**

CornField 不再自行推导 Tool 呈现方案，改为移植上游 oh-my-pi 已验证的设计：Tool 分 Tool Catalog / Enabled Tool Set / Discoverable Tool Set 三层，每个 Tool 声明 Load Mode（`essential` / `discoverable`），`discoverable` Tool 通过 `xd://` 设备挂载呈现，由 `read`/`write` 承担 transport。选择理由是上游该设计已经过生产故障验证（#5764 adapter 重注册导致核心 Tool 静默降级、#5973 模型不认识 xd 协议导致 `web_search` 实际不可达、#7312 层级元数据缺失），重新推导会重复付出同等代价。

## 决策要点

- **规范名分两层落地**：本批只上「规范名集合 + legacy 别名解析机制」，使旧名仍能解析到同一工具；registry key、配置 key 与提示词文本的重命名（`find → glob`、`search → grep`、`todo_write → todo`）以及旧名移除另开一票，不与呈现协议改造同批。理由：重命名是横向机械改动，会把 prompts、配置与测试大面积卷进来，并让名称票与提示注入票在同一批文件上相撞。
- **Load Mode 声明在 Tool 上**：每个 Tool 类声明 `loadMode` 与 `summary`；集中 essential 名单（上游 `ESSENTIAL_BUILTIN_TOOL_NAMES` + `defaultLoadModeForToolName`）只做兜底，防止 adapter 或 UI 重注册把核心 Tool 静默降级为 `discoverable`。
- **transport 不可挂载**：`read`/`write` 既是 `xd://` 的列出与执行入口，永远保持顶层。
- **保留顶层例外名单**：沿用上游 `XDEV_KEEP_TOP_LEVEL` 的思路——与 harness、prompt 或模型调用习惯强耦合的 Tool，即使标为 `discoverable` 也不挂载。CornField 的首版名单按本仓库主路径单独确定。
- **`internal` 是本仓库扩展**：上游只有 `essential`/`discoverable`；CornField 增加 `internal` 表达「不可由配置、发现或显式 `toolNames` 选中，只能由拥有它的运行时注入」的控制 Tool。`internal` 约束**注入权**而非**调度权**：一旦运行时把某个 `internal` Tool 注入该 Session（如子 Agent 的 `yield`、review 的 `report_finding`、审批队列的 `resolve`），模型可以照常调用它。
- **配置开关**：沿用上游 `tools.xdev` 语义，且**默认开启**——普通 Session（含 gateway、cron、interactive）即走 `xd://` 挂载，`tools.xdev` 用于关闭。
- **首版 Load Mode 按本仓库主路径分类**：`essential` = `read`/`write`/`edit`/`find`/`search`/`bash`/`ask`/`task`/`job`/`project_context`/`todo_write`/`exit_plan_mode`/`identity`；其余公开 Tool 为 `discoverable`；`yield`/`resolve`/`report_finding`/`report_tool_issue` 为 `internal`。代码组织上的 `HIDDEN_TOOLS` 不等同于领域上的 `internal`。
- **`createTools()` 消费 Enabled Tool Set**：`tools.xdev` 关闭时保持当前顶层暴露行为；开启时 `discoverable` Tool 卸载为 `xd://` 设备；`internal` Tool 始终不进入模型可选择集合。现有运行时注入路径（`resolve` 注入、autoqa 注入、`yield` 注入、`report_finding` 注入）保持行为不变，不因 `internal` 分类而收紧。
- **MCP 收口**：MCP Tool 最终统一走 `xd://` 挂载，`search_tool_bm25` 与 `mcp.discoveryMode` 退场（保留读旧配置的兼容层）。该迁移在内置 Tool 之后单独落地，不与 `agent-session.ts` 的会话持久化改动耦合成一批。

## 考虑过的方案

- **自建 metadata-only 地基、择期再定发现协议**：被否。上游已完成该设计并用生产故障验证过，重新推导重复付出代价。
- **先测量 CornField 的 tool schema 成本再决定是否建设**：被否。直接采用上游已验证设计，不等本地测量。

## 后果

- 变更面包含 `read`/`write` 的语义（承担 `xd://` transport），而这两个 Tool 被 gateway、子 Agent、RPC host tool 与自演化调用路径共用，影响面需单独评估。
- 名称规范化分两层：本批只上别名解析机制，registry key、配置 key 与提示词文本的重命名与旧名移除另立一票。
- MCP 发现路径的最终形态已定（统一 `xd://`），但落地分批：内置 Tool 先走，MCP 迁移（含 `agent-session.ts` 会话持久化与旧配置兼容层）紧随其后单独一票。
- 与本仓库 ADR-0001/0002 正交：本 ADR 决定 Tool 呈现协议，不涉及进程模型与 Wire 协议。
