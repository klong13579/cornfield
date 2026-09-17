# T4 首页「输入法与真实性」交付说明

分支 `squad/webapp-fix-t4`，commit `1023f3d1ab`。范围仅限 `packages/web-app/src/pages/home/**` + 测试文件。

## 改动（逐条对照 acceptance）

| acceptance | 改动 |
|---|---|
| 中文输入法组合态按 Enter 不发送、非组合态发送 | composer `onKeyDown` 走 `shouldSubmitOnEnter(key, isComposing)`；组合态（`e.nativeEvent.isComposing`）下的 Enter 只确认选词、不提交 |
| 「最近活跃」改真 | 该区块实为「已注册 Agent（注册表顺序）」，无活跃时间数据。标题改为「Agent」，去掉只取前 3 的 `slice(0,3)`、改为全量渲染 |
| 断连态点「重试」进行中反馈 + 失败原因上屏 | 新增 `connecting` / `connectError` 态：点击后按钮变「连接中…」并禁用；`connect()` 在传输层失败会挂住（pi-client 无握手超时），用 10s 超时兜底，超时后把原因写进屏上 |
| 390 宽不裁切、可达换行 | Agent 卡片容器 `flex` → `flex flex-wrap justify-center`；卡片名加 `truncate` 防长名溢出 |
| 摘要行无空字段 | 环境摘要行抽成 `envSummaryText`：空分支跳过、`pendingCronCount=0`（wire serve 不返回该字段，被适配层缺省为 0）不再硬编「0 定时任务待执行」；Agent 卡片去掉恒空的 `lastAction ?? "—"` 摘要行 |
| 占位文案不写死不存在 agent 名 | `composerPlaceholder`：有焦点 Agent 用其名，否则用通用「发一条指令…」（原「研发助手」硬编码移除） |
| 未连接态既有禁用说明不回退 | 输入框 `disabled={!view.connected || view.isStreaming}` 与「未连接 serve——连接后这里显示当前 Agent 的最近一轮。」保持不变 |

## 证据（本目录，随分支走）

### 1. 输入法组合态 —— 自动化用例

可复跑：`bun test packages/web-app/test/diag-home-truthfulness.test.ts`

`shouldSubmitOnEnter` 纯函数钉死：

- `("Enter", false)` → `true`（非组合态发送）
- `("Enter", true)` → `false`（IME 组合态不发送）
- 非 Enter 键 → `false`

真机 IME 待复核：判据走标准 `KeyboardEvent.isComposing`（浏览器在组合期对确认 Enter 恒设 true），
Chrome/真实输入法下的行为是浏览器收敛的，无需前端另做状态机。

### 2. 390 无裁切 —— `home-390.controls.txt`（390x844，连 serve）

所有控件右缘 `x+width` 均 ≤ 341 < 390，无右缘超出：

- 输入框 `[66,173 220x34]` → 右缘 286
- 发送键 `[296,171 36x36]` → 右缘 332
- 7 张 Agent 卡 `[115,y 160x54]` → 右缘 275（已 `flex-wrap` 换行纵向排列，单行一列，无横向溢出）
- 「转入会话工作台」`[186,232 155x19]` → 右缘 341

同文件可见 Agent 区块从「前 3」变为 7 个全量渲染（default/hr/algorithm/me/dataAgent/sw/mcode）。

### 3. 断连态重试反馈 —— `home-disconnected.steps.txt`（`--ws ws://127.0.0.1:9/ws`，不可达）

点「重试」前后内联文本（steps.txt 里的 eval 读数）：

- 点前：`重试`
- 点后 +800ms：`连接中…`（进行中反馈，按钮同时 `disabled`）
- 点后 +10s：错误文案 `连接超时：serve 未响应，请确认它已启动后重试`（失败原因上屏）

`home-disconnected.console.txt` 同步记录到 `ws://127.0.0.1:9/ws` 的传输层连接失败（`net::ERR_UNSAFE_PORT`）。

### 4. 环境摘要行补真（附带证据）

`home-390.dom.txt` 摘要行现为 `cf-ui-demo · 7 agent 运行中` ——
空分支被跳过、`0 定时任务待执行` 不再出现；同日可见页面无「最近活跃」字样、无「—」空摘要、占位为真实 Agent 名 `给 default 发一条指令…`。

## Gate 结果

- `bun run --cwd=packages/web-app check` → 通过（biome check + tsgo 无错误）
- `bun test packages/web-app/test/diag-home-truthfulness.test.ts` → 11 pass / 0 fail

## 复跑步骤

```bash
# 起自己的 vite（不带共享的 4173）
bun run --cwd=packages/web-app dev --port 4184 --host 127.0.0.1

# 390 无裁切
bun .worktrees/_diag-harness/collect.ts --page '#/' --out docs/web-app-fix-t4 \
  --name home-390 --base http://127.0.0.1:4184 --ws ws://127.0.0.1:7891/ws --view 390x844

# 断连态重试反馈
bun .worktrees/_diag-harness/collect.ts --page '#/' --out docs/web-app-fix-t4 \
  --name home-disconnected --base http://127.0.0.1:4184 --ws ws://127.0.0.1:9/ws --view 390x844 \
  --steps docs/web-app-fix-t4/retry-steps.json
```