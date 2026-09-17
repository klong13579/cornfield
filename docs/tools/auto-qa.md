# Auto-QA（工具缺陷上报）

> 状态：真值
> 代码：`packages/coding-agent/src/tools/report-tool-issue.ts`（写入端 + 数据库）、`src/cli/grievances-cli.ts`（读取/导出/清理）、`src/commands/grievances.ts`（命令入口）

## 它是什么（不是什么）

一套**工具缺陷的本地证据通道**：agent 在工作中发现某个工具行为与预期不符时，把它记下来；事后用人可读的方式取出来。

- **写入端**：`report_tool_issue` 工具。任何 agent（含 subagent）都可调用，落一行到本地 SQLite。
- **读取端**：`cornfield grievances` 命令（`list` / `export` / `clean`）。

它**不是**：

- 不是 telemetry —— 默认纯本地、零网络，没有任何上报 endpoint（见「边界」）。
- 不是 issue tracker —— 没有状态流转、指派、去重、修复标记；`exported` 只表示「这份内容已经被取走过」。
- 不是 bug 复现工具 —— 库里存的是**一句人写的描述**加少量上下文（模型、版本、工具名、时间、会话），不是调用现场。

## 写入端：`report_tool_issue`

**开关**：`PI_AUTO_QA=1` 环境变量，或设置 `dev.autoqa`（`settings-schema.ts`）。两者都默认关闭。

**注入**：开启后它被无条件注入每个 agent（含 subagent），并且**抵抗运行时的工具集裁剪**——三处各自保它：

- `src/tools/index.ts`（`createTools()` 注入，不受请求的工具列表影响）
- `src/session/agent-session.ts`（`setTools` 时补回）
- `src/modes/rpc/rpc-mode.ts` / `src/modes/wire-stdio.ts`（`set_disabled_toolsets` 时保留）

系统提示在它存在时会多一段 `<critical>` 催促上报（`src/system-prompt.ts`），并明说「误报可接受」——这是刻意的：模型判断一次工具「不对劲」的成本很低，漏掉一次真实缺陷的成本很高。

**`tool` 参数是枚举**，取值 = 本次会话**真正构造出来**的 built-in / hidden 工具名（`createTools()` 在注入时把这份快照传给工厂）。MCP server 与扩展工具在 `sdk.ts` 里晚于 `createTools()` 进集合，**天然落在枚举外**——那些是用户自己的配置，不是我们发布的东西。

模型无视枚举、报了别的名字时：**不落库、不建库**，明确回 `Not recorded: "<tool>" is not a built-in tool in this session. Nothing was saved.`。旧名（`find` / `search` / `todo_write`）先过 `builtin-names.ts` 的 `normalizeToolName` 归一，不会因为「名字旧」被拒。

**失败也不说谎**：写库失败（库打不开、插入失败）时返回 `details.error` + 原因，正文写 `Not recorded (…). This report was NOT saved.`；成功才是 `Noted, thanks!`。工具本身不抛异常——QA 侧信道不该打断调用方的回合。

**`report` 字段要求**：只写失败形状，**不要写 PII**（路径、文件内容、标识符、提示词原文）——schema 描述里就写着这条。

## 数据在哪

`<agentDir>/autoqa.db`（默认 `~/.cornfield/agent/autoqa.db`）。**gateway 每个账号有自己的 agentDir**，所以每个账号一个库；查别的账号要带上那个 agentDir：

```bash
CORNFIELD_AGENT_DIR=~/.cornfield/agents/<accountId> cornfield grievances
```

表只有一张 `grievances`：

| 列 | 含义 |
|---|---|
| `id` | 自增主键，删除全部时会重置序列 |
| `model` / `version` | 上报时的生效模型串与产品版本 |
| `tool` | 被上报的工具名（枚举内，已归一为规范名） |
| `report` | 人写的一句话描述 |
| `createdAt` | 上报时刻（epoch ms）。**旧行为 NULL** —— 真实状态是「无时间」，不是 0 |
| `sessionId` | 上报的会话（便于回会话 JSONL 取证）。旧行同样为 NULL |
| `exported` | 0/1，是否已被 `export` 取走（加列时带 `DEFAULT 0`，所以旧行自动是未导出，不会被漏掉） |

打开/迁移/连接缓存的**唯一入口**是 `report-tool-issue.ts` 的三个函数：`openAutoQaDb()`（可写，带缓存与迁移）、`openAutoQaDbReadonly()`（列表用）、`closeAutoQaDb()`（唯一允许关缓存句柄的出口）。旧库在打开时按 `PRAGMA table_info` 就地 `ALTER TABLE` 补列。**不要手改这个库**——schema 由代码拥有。

## 什么时候用哪个动作

| 动作 | 触发时机 | 代价 |
|---|---|---|
| `cornfield grievances`（`list`） | 随时扫一眼；排查某个工具时 `-t <名>`；发版前过一遍 | 只读 |
| `… -s 7d -m` | 想直接读一段给人看的摘要（纯查看，不消费） | 只读 |
| `… export -s 7d -o <文件>` | ① 每周 / 每次迭代收尾，把**新报告**送进人的视野；② 要给某人看或存档；③ **`clean` 之前留底** | 只写 `exported` 标记，改内容之外什么都不动 |
| `… clean -t <名>` / `--id <n>` | 清整类噪声（例如某一类历史事故刷出来的上千条）、清已导出且已看过的旧批次 | **不可恢复** |
| `… clean --all` | 只在明确不要这份历史时（换机器、重开基线） | **不可恢复**，并重置自增序列 |

两条规矩：

1. **`clean` 之前先 `export`。** 删除不可逆；`export` 的标记语义是「已消费」而不是「已修复」，所以处理完的条目**仍然留在库里**，要显式 `clean` 才消失。
2. **CLI 必须跑在同一个 agentDir 上**（见上），否则你看的是另一个库。

`export` 是**至少一次**语义：摘要写成功之后才打标记，写不进去（目标不可写）就原样留在队列里等下次，不会因为一次重定向到断管而静默丢行。`--json` 必须配 `--out` —— JSON 已占 stdout，而「没产出摘要却标成已导出」是撒谎。重复跑只会得到 `No new reports to export.`。

## 例行节奏

```bash
# 每周一次：只导出没导过的，落成一份可读的 markdown
cornfield grievances export -s 7d -o ~/autoqa/$(date +%F).md

# 一次性清掉某一类噪声
cornfield grievances clean -t yield
```

其它常用：

```bash
cornfield grievances -n 50 -t write      # 只看 write 工具的最近 50 条
cornfield grievances -s 7d -m            # 最近一周的摘要（不消费）
cornfield grievances clean --id 486      # 删单条
```

## 边界与已知缺口

- **没有去重**：同一个缺陷被多轮会话反复上报就是多行（历史上 `yield` 缺工具那条刷了 395 行）。
- **没有「已修复」状态**：`exported` 只表示被取走过。判断某条是否已修，靠人（或靠 CHANGELOG / 代码）。
- **越界问题不进库**：MCP、扩展工具、`xd://` 设备的问题会被枚举与运行时白名单挡在外面，不会落行（设计如此，但也意味着这类问题没有本地出口）。
- **未接 push / consent**：上游 `0bb385f8ab` 实现了「用户同意后批量 POST 到 `dev.autoqaPush.endpoint`」+ `omp grievances push`，本仓 2026-04-30 分叉后未同步；本仓目前只有「导出到文件/标准输出」这一种出口。
- **旧行没有时间**：`createdAt` / `sessionId` 为 NULL 的行来自比“加这两列的那次构建”更旧的构建，任何时间窗口查询都会把它们排除（命令会明说被排除了多少条）。
  **不是“2026-09-15 之前的行”**：一个在升级前启动的长命进程会一直写 NULL 行到它退出为止。2026-09-16 实测：库里 id 497–499 的 NULL 行夹在两条 v1.2.3 行中间（05:08 与 17:07），全部标着 `version=1.2.2`。
  同一形状也适用于枚举：`tool` 取到非 built-in 名字（`mcp__…` / `xd://…`）的行**全部**是无时间戳的那些，即来自枚举守卫之前的构建；带时间戳的行（v1.2.3）零条越界。旧进程退出后这种残留就不再新增。
- **`--tools report_tool_issue` 是唯一能拿到无枚举变体的路径**：它落在 `createTools()` 的 `filteredRequestedTools` 分支上，直接调 `HIDDEN_TOOLS.report_tool_issue` 工厂（`tools/index.ts:261`，不传 `activeBuiltinNames`）。默认路径不走那里——`HIDDEN_TOOLS` 不被逐个枚举，带守卫的注入（`tools/index.ts:489-500`）才是活的注册点，而 `[]` 回退为自由字符串是**有意且被测试钉住**的行为（`test/tools/report-tool-issue.test.ts:184,210`）。目前仓内无任何调用方走 `--tools report_tool_issue`。
