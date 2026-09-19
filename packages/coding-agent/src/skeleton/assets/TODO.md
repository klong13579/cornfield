# TODO

> 本文件**不进自动注入**（已从 `prompt-includes.json` 摘除）：Agent 会话默认不带它。
> 这个 Agent 的任务在那个 Agent 的任务板里：`<agentDir>/.cornfield/agent-todos.json`
> （结构化：status / priority / dueAt / notes），由 serve 的 `list_agent_todos` /
> `set_agent_todo` / `delete_agent_todo` 读写，Todo 页是它的界面。
>
> **不要手改任务板 JSON**：`createdAt` / `updatedAt` 由存储盖章，终态不可重开，
> `sessionRefs` 记的是哪些会话推进过它 —— 手改会绕过这三条。
>
> 本文件保留为历史记录（旧的任务清单与 `→ topics/<slug>.md` 链接在这里），只读。
