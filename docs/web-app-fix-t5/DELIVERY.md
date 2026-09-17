# T5 设置页 真实态与写保护 — 交付说明

分支 `squad/webapp-fix-t5`，commit 见 git log。改动范围（仅 scope 内）：

- `packages/web-app/src/pages/settings/SettingsView.tsx`（改）
- `packages/web-app/src/pages/settings/connection-config.ts`（新增）
- `packages/web-app/test/diag-settings-writes.test.ts`（新增）

## 逐条判据与证据

| 判据 | 实现 | 证据 |
|---|---|---|
| 保存并重连不覆盖已存 Token | `saveConnection` 经 `resolveNextToken(input, stored)`：空/纯空白输入保留已存凭据；token 输入框初值从 `loadServeConfig().token` 读回 | `evidence/settings-token-preserve.steps.txt`（before/after 均为 32 长度，见下）+ 单测 |
| 连接状态行三态文案 | `已连接` / `重连中（指数退避）` / `已断开` | `evidence/settings-connected.dom.txt`、`evidence/settings-disconnected.dom.txt` |
| 保存成功有反馈 | 成功显示「已保存并重连」 | `evidence/settings-save-success.dom.txt` |
| 无桌面壳「检查更新」禁用并说明 | `!canCheckUpdate` 时禁用 + 正文说明 | `evidence/settings-connected.controls.txt`（`检查更新 DISABLED`）、`evidence/settings-connected.dom.txt` |
| 主题区不再承诺未实现能力 | 移除「消息密度」行；颜色主题标注「当前唯一主题，深色未实现」 | `evidence/settings-connected.dom.txt` |
| 快捷键表不再承诺未实现能力 | 移除 `Cmd+M 切换模型（TODO）` 行 | `evidence/settings-connected.dom.txt` |
| 禁用控件原因正文可读 | 钉钉只读/测试连接、重置设置的原因改为正文 | `evidence/settings-connected.dom.txt` |

## Token 保留 前后值（只写长度/存在性，不贴明文）

- 落盘路径：`localStorage` 键 `cornfield.serve.connection`（`{ wsUrl, token }` JSON）。
- 复跑：`evidence/token-preserve-steps.json` 驱动的一次「写入→点保存并重连（Token 框留空）→读回」闭环。
- 前后（来自 `evidence/settings-token-preserve.steps.txt`）：

  | 时刻 | token 存在性 | token 长度 |
  |---|---|---|
  | 保存前（seed 合成 token） | true | 32 |
  | 保存并重连后 | true | 32 |

- 回滚证据：单测 `diag-settings-writes.test.ts` 每个写用例跑在局部内存 `Storage` 上，`afterEach` 删除全局 `localStorage`，不污染真实配置；页面级复跑用合成 token（非真实凭据），且证据只记长度。

## 复跑命令

```bash
# 门禁
bun run --cwd=packages/web-app check
bun test packages/web-app/test/diag-settings-writes.test.ts

# 页面证据（dev server 4185 + 采集器）
bun run --cwd=packages/web-app dev --port 4185 --host 127.0.0.1
bun .worktrees/_diag-harness/collect.ts --page '#/settings' --out <证据目录> --base http://127.0.0.1:4185 --ws ws://127.0.0.1:7891/ws [--steps evidence/token-preserve-steps.json]
```
