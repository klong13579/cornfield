# 11: IDE Git 面板 UI（status/diff/log/branches 视图 + 提交）

**What to build:** 让研发在 IDE 里完成 git 日常闭环（spec User Story 18）：侧栏/面板 Git 视图显示 status（当前分支 + staged/unstaged/untracked）、diff（working vs HEAD/staged）、log（最近 commit）、分支切换；提交入口（commit message + 提交）。数据来自 02 的 wire git 命令；diff 视图与 08 的审阅组件共用渲染。commit/push 等写操作按审批策略（09）走审批（若配置要求）。

**Blocked by:** 02（wire git 最小集命令）、05（壳骨架）

**Status:** ready-for-agent

**File scope:** packages/editor-extension（Git 面板视图 UI，注册到侧栏/底部容器）；消费 wire git_* 命令；diff 渲染复用 08 的审阅组件。

- [ ] Git 面板显示 status（分支/staged/unstaged/untracked）、diff、log、分支列表
- [ ] 提交入口可用（commit message + 提交成功反馈）
- [ ] 需要审批的写操作（若策略要求）走审批流而非绕过
- [ ] 验收冒烟：IDE 里对真实仓库完成 看状态 → 看 diff → 提交 闭环

---
*来源：v3-architecture 阶段 B2；spec User Story 18；review 补票（原票包漏 IDE git UI）*
