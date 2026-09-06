# 01: default Agent workspace 固定与幂等初始化

**What to build:** serve/欢迎页首次访问时，default Agent 的业务 agentDir/workspace 固定为 `~/cf-workspace` 并按现有 Agent skeleton 幂等初始化。初始化目录包含 `TODO.md`、`topics/`（skeleton 需新增该目录）、`.cornfield/config.yml`、sessions 等骨架内容。初始化不执行 `git init`。default Agent 运行时配置真源从全局配置目录迁至 `~/cf-workspace/.cornfield/config.yml`：首次初始化时把旧全局配置文件合并迁移到该文件，旧文件保留为备份，此后不再作为 default Agent 运行时真源。其他 Agent 不受影响，继续使用各自 agentDir 下的配置。

**Blocked by:** None（可立即开始）。

**Status:** ready-for-agent

- [ ] 默认 workspace 路径解析为 `~/cf-workspace`（受环境变量约定的现有 dirs 机制影响时，语义保持 default Agent 专用）
- [ ] 首次访问 `~/cf-workspace` 时按 Agent skeleton 完整初始化；再次访问幂等，不覆盖已有内容
- [ ] skeleton 目录清单与内容模板新增 `topics/`（含既有文件布局约定一致的占位或模板）
- [ ] workspace 初始化不执行 `git init`，不创建 git 元数据
- [ ] default Agent 的模型/运行配置从 `~/cf-workspace/.cornfield/config.yml` 读取
- [ ] 首次初始化将旧全局配置（`~/.cornfield/agent/config.yml`）内容合并迁移到 `~/cf-workspace/.cornfield/config.yml`；旧文件保留为备份，之后不再读取为 default Agent 运行时真源
- [ ] 其他 Agent（各自 agentDir 配置）行为不变，相关既有测试仍绿
