# 工作台 粘贴/模型/compact 修复证据（T3 · squad/webapp-fix-t3）

分支 `squad/webapp-fix-t3`。四条判据的真页面证据 + 自动化断言，采集自本分支改动的 dev 实例（`bun run --cwd=packages/web-app dev --port 4183`，后端共享 `ws://127.0.0.1:7891/ws`）。

采集器：`<cornfield>/.worktrees/_diag-harness/collect.ts`（每次运行独立 headless Chrome）。

## 判据 → 证据对照

| 判据 | 结论 | 证据 |
|---|---|---|
| 粘贴图片→附件，纯文本不被吞 | 通过 | `paste-attachment.steps.txt`（`clipTitle:"1 张图片已附加（发送时随指令）"`）、`paste-send.ws.txt`（出站 `prompt` 帧带 `images` 载荷）；纯文本不吞见 `test/diag-workspace-composer.test.ts` 的 `imageFilesFromClipboardData` 断言 |
| 图片随 prompt 真正发出（出站帧可见图片载荷） | 通过（真发送 1 次） | `paste-send.ws.txt` 第 29 行：`-> {"type":"request","command":{"type":"prompt","message":"帮我看看这张图（真发送 1 次）","sessionId":"default","images":[{"type":"image","data":"iVBORw0KGgo…","mimeType":"image/png"}]}}` |
| 模型「当前」徽标同 id 多 provider 只落一条且与实际生效一致 | 通过 | `model-compact.steps.txt`（`'当前'` 计数 `→ 1`）；`model-compact.ws.txt`：快照 `model.provider="narwal-plan"`，而 `get_available_models` 同时返回 `deepseek-v4-flash` 于 `alibaba-coding-plan` 与 `narwal-plan` 两个 provider（第 12/17/24/30/31 行） |
| 模型列表可过滤 | 通过 | `model-compact.steps.txt`（`!!input[placeholder*="过滤模型"] → true`，placeholder = `过滤模型（id / provider）…`），过滤 `deepseek` 后徽标仍 `1`；`model-compact-model-menu-filtered.png` |
| compact 需显式确认（一点不真压缩）并说明压缩上下文 | 通过 | `model-compact.steps.txt`（`会压缩上下文 → true`，控件含 `确认`/`取消`）；`model-compact.ws.txt` 全文无 `"type":"compact"` 帧；`model-compact-compact-arm.png` |
| 中文输入法组合态 Enter 不发送 | 通过（自动化断言） | `test/diag-workspace-composer.test.ts` 的 `shouldSendOnEnter`：组合态 `isComposing=true` 时 `Enter` 返回 `false`。headless 无法强制原生 IME `isComposing`，真机路径与 T4 同判据（各改各文件） |

## 自动化断言（gate）

- `bun run --cwd=packages/web-app check` — biome + tsgo 全绿
- `bun test packages/web-app/test/diag-workspace-composer.test.ts` — 14 pass
- 回归：`bun test packages/web-app/test/composer-model-groups.test.ts` — 6 pass

## 改动范围

- `packages/web-app/src/pages/workspace/ComposerBar.tsx` — 粘贴图片→附件、纯文本不吞、`ModelList`（可过滤 + 徽标按 provider 去重）、`shouldSendOnEnter` 组合态判据
- `packages/web-app/src/pages/workspace/WorkspaceView.tsx` — `CompactButton` 两步确认（`compactStageAfter` 状态机）
- `packages/web-app/src/state/session-store.ts` — 共享文件，**仅加 `modelProvider` 一个字段** + 快照三处赋值（`buildBaseView` 两处 + `applySnapshot`）
- `packages/web-app/test/diag-workspace-composer.test.ts` — 新增自动化断言

## 复跑

```bash
bun run --cwd=packages/web-app dev --port 4183 --host 127.0.0.1   # 起本分支 dev 实例

# 模型下拉 + compact
bun ~/.worktrees/_diag-harness/collect.ts --page '#/workspace' --out docs/web-app-fix-t3 --name model-compact \
  --base http://127.0.0.1:4183 --ws ws://127.0.0.1:7891/ws --wait 2500 \
  --steps docs/web-app-fix-t3/steps-model-compact.json

# 粘贴→附件→发送（真发送 1 次）
bun ~/.worktrees/_diag-harness/collect.ts --page '#/workspace' --out docs/web-app-fix-t3 --name paste-send \
  --base http://127.0.0.1:4183 --ws ws://127.0.0.1:7891/ws --wait 2500 \
  --steps docs/web-app-fix-t3/steps-paste-send.json
```

（`~/.worktrees` 实为 `<cornfield>/.worktrees`，按仓库实际路径替换。）