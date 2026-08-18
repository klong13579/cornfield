# Phase 2 防互踩规则（硬性，违反即打回）

1. **一工位一 worktree，永不越界**：
   - W1 → .worktrees/hermes-fusion（分支 w1-shell）
   - W2 → .worktrees/fusion-w2（分支 w2-render）
   - W3 → .worktrees/fusion-w3（分支 w3-data）
   - 主线 → .worktrees/fusion-main（你们不碰）
2. **git 纪律**（上轮事故的教训）：
   - 任何 git 命令前 `pwd` 确认在自己 worktree
   - 禁止 `git add -A`，只 `git add <精确路径>`
   - 禁止 checkout/merge 其他工位分支，同步统一走 `git merge hermes-fusion`
3. **文件所有权**（phase 2 修订）：
   - W1：packages/web-app 的 layout/ pages/（除 W3 专属目录） index.css
   - W2：packages/web-app 的 render/ components/
   - W3：packages/web-app 的 pages/insights,memory,tasks,skills/ + pi-wire/ + coding-agent serve 侧
   - 冲突地带：**pi-wire/src/commands.ts 和 wire-server.ts 是 W3 专属**（上轮五处冲突全在这两个文件，教训）
   - package.json/bun.lock 改动 = 先在群里报备（intercom/pane prompt 问主线），不擅自加依赖
4. **提交节奏**：每卡一 commit，commit 前 `git merge hermes-fusion` 同步 + 完整 `bun run check`（不是 touched files）
5. **上报**：完成/block 发 intercom 到主线（ID 见各 kickoff；不确定 ID 就 pane 里等着，主线轮询会读）
