# 01: P0 — Agent 中轴纵切（Project 注册表 + 权威归属）

**What to build:** 一条可验证的纵切，证明 agent 模型成立：创建 agent → serve 发现（registry）→ attach → 权威归属（list_sessions 返回 agentId + projectId）→ 切换 project → 发起/恢复 session → gateway 绑定不破。端到端用户可见效果：首页按 agent 组织、每个 agent 卡显示权威项目归属、会话列表按 projectId 分组（不再猜路径）。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `list_projects` / `get_project` / `attach_project` wire 命令可用，projectId 稳定（git root hash 或显式生成，P0 定案）
- [ ] session 元数据写入 projectId + agentId；`list_sessions` 返回权威归属（前端不再猜 encoded-cwd）
- [ ] workspace.json 保持 Agent 声明（方案 A）；Project 级配置不在 agentDir 内双真相
- [ ] agent 实体化补齐 agentContext 元数据（default 统一 + 服务过的项目/角色）
- [ ] default agent 一次性迁移（幂等 + 备份 + 回滚 + 旧版 CLI 兼容）；重复执行无副作用
- [ ] 前端首页以 agent 为纲 + 员工工作台 UI 壳（导航 + 空状态 + 复用现有 tab）
- [ ] 顶栏项目 chip 升级为选择器，切换不重启 serve
- [ ] `cornfield agent` 命令输出层改用 centralized logger（硬约束，P0 前）
- [ ] 批准写操作走真实 permission-gate（inject_permission 接 agent-core）
- [ ] 验收补边界：重启后 agent 可恢复 / 重复创建 / agentDir 已存在 / workspace.json 缺失 / registry 损坏 / 迁移失败