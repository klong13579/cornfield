# 03: SQLite 持久层

**What to build:** task-control 专用 SQLite 持久层，遵循仓库既有 Bun SQLite + WAL + schema version + 按数据库路径 singleton 的约定。表覆盖来源项、proposal、Task、依赖边、TaskRun、Verification、事件、Task Package 与 Main Worker 记录。所有状态写入在事务内校验状态机合法转移并追加事件；claim 使用条件更新保证并发下至多一个赢家；Run/Verification 历史行 append-only，不做破坏性改写。store 以 repository 接口暴露给上层（domain 层依赖接口而非 SQL）。

**Blocked by:** 01（DB 路径位于 default Agent workspace 之下）, 02（消费其类型与状态机）。

**Status:** ready-for-agent

- [ ] 建立 schema version 迁移：首次建库与升级路径可用，WAL 与 busy timeout 打开
- [ ] 表结构与约束覆盖实现规格 §4 列出的全部实体（含 task_packages / main_workers 及外键关系）
- [ ] 所有状态写入 = 单事务（校验转移 + 更新状态 + 追加事件），非法转移在存储层被拒绝
- [ ] claim 为条件更新（仅 `ready` 可被 claim），两个并发调用方至多一个成功
- [ ] 同一 Task 的 active Run 唯一性由存储层保证；attempt 序号连续且唯一
- [ ] Run/Verification 历史记录不可被覆写或删除
- [ ] repository 接口与 SQLite 实现分离；store 接口测试用真实临时 DB（不 mock），覆盖迁移、WAL reopen、事件追加顺序
