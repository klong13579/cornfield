# 02: wire git 最小集命令（status/diff/log/show/branches）

**What to build:** 让前端能经 wire 查看仓库 git 状态：`git_status`（当前分支 + staged/unstaged/untracked 列表）、`git_diff`（working tree vs HEAD 或 staged）、`git_log`（n 条 commit：hash/author/msg）、`git_show`（单 commit 详情）、`git_branches`（local + remote + current）。实现走 spawn git 子进程（与项目既有 spawn 框架一致），不做 typed git 工具集。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**File scope:** packages/pi-wire（命令 schema）、packages/coding-agent（serve 端分发 + git spawn 实现）、wire-server 集成测试。

- [ ] 五命令 PiClient 可调通并返回正确结构（空仓库/有改动/多分支场景各一）
- [ ] `bun test` 相关用例全绿
- [ ] 命令超时与错误码处理与其他 wire 命令一致

---
*来源：v3-architecture 阶段 0；spec Implementation Decision #3*
