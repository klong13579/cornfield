# 外部数据源映射

本文件说明本机器人能够访问的外部数据源。
仅作为参考文档，不实际触发数据同步。
本文件是 **always-on**（由 `prompt-includes.json` 注入）。

## 数据源列表

| 名称 | 类型 | 访问方式 | 同步频率 | 备注/凭据 |
|------|------|---------|---------|----------|
| 钉钉知识库 | Workspace | dws CLI (`skill://dws`) | 手动 | 凭据由 dws 自动管理 |
| GitLab | Code | git CLI / API | 实时 | 凭据见 `.gitlab_credentials` |
| 内部 Wiki | Web | read / puppeteer | 定时 | 需登录凭据 |

> 凭据类文件（`.gitlab_credentials` 等）**不应**直接引用明文值，改引用路径或占位符。

## 访问方式示例

> 编辑本文件时，为每个数据源提供实际查询命令示例。这降低 LLM 在运行时猜测参数格式的概率。

_示例：_

```bash
# 钉钉知识库搜索
dws doc search --query "<关键词>" --workspace-ids "<workspaceId>"

# GitLab 项目搜索
curl --header "PRIVATE-TOKEN: <token>" "https://gitlab.com/api/v4/projects?search=<关键词>"
```
