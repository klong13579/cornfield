# 外部数据源映射

本文件说明本机器人能够访问的外部数据源。
仅作为参考文档，不实际触发数据同步。
本文件是 **always-on**（由 `prompt-includes.json` 注入）。

## 数据源列表

| 名称 | 类型 | 访问方式 | 同步频率 |
|---|---|---|---|
| 钉钉知识库 | Workspace | dingtalk MCP | 手动 |
| GitLab | Code | git MCP | 实时 |
| 内部 Wiki | Web | http MCP | 定时 |

⚠️ **请编辑本文件补充真实的数据源。**
