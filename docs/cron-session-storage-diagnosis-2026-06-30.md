# hr3 cron 会话文件诊断

**作者**: Pi staff engineer
**日期**: 2026-06-30
**触发问题**: `/Users/sz-0203015357/Desktop/Narwal/OMP-workspace-test/hr3/sessions` 内 cron 文件结构异常
**结论摘要**: 两套 session 存储路径并存 + 15 个孤儿空目录由历史清理残留导致, 当前路径已稳定

---

## 1. 现场观察（2026-06-30 03:34 抓取）

`hr3/sessions/` 实际内容（节选）:

```
drwxr-xr-x  cron_1782345600088/   0 files   Jun 25 08:00
drwxr-xr-x  cron_1782345600666/   0 files   Jun 25 08:00
... 15 个空目录, 跨度 Jun 25 08:00 ~ Jun 26 19:00 (BJT) ...
drwxr-xr-x  cron_1782601200061/   0 files   Jun 28 08:00
-rw-r--r--  cron_1782601200061.jsonl   26845 B   Jun 28 08:00
... Jun 28 ~ Jun 29: 6 对 dir+jsonl 配对 ...
-rw-r--r--  cron_1782756775419.jsonl   1437 B    Jun 30 02:12
... Jun 30 02:12 ~ 02:25: 6 个裸 .jsonl ...
-rw-r--r--  cron_1782757489005.jsonl   1717 B    Jun 30 03:12
drwxr-xr-x  cron_1782760309116/   0 files   Jun 30 03:11
-rw-r--r--  cron_1782760309116.jsonl   34012 B   Jun 30 03:11
```

时间戳解码（`Date.now()` 毫秒）均为 BJT 整点/半点, 与 cron 调度时间一致。

## 2. 关键发现

### 发现 1: hr3 agent 当前使用两套 session 存储路径并存

| 路径 | 触发代码 | 用途 |
|---|---|---|
| `<agentDir>/sessions/cron_<id>.jsonl` | `gateway-cron-lifecycle.ts:179` `buildAgentSessionPath(agentDir, "cron_<Date.now()>")` | gateway cron 显式指定路径 |
| `~/.omp/agent/sessions/<encoded-cwd>/by-date/<YYYY-MM-DD>/<HHMMSS>__<8hex>.jsonl` | OMP 子进程在 `setSessionFile` 未传 `sessionPath` 时的默认布局 | 交互式 session / 部分 cron 跑 |

**直接证据**: `daily-1200-schedule` 任务（`task_1782756229437_6q26gt`）在 executions 表里出现两次:
- 跑 1: `started_at=1782756394719` (BJT 02:06:34), `agent_session_path=/Users/sz-0203015357/.omp/agent/sessions/-Desktop-Narwal-OMP-workspace-test-hr3/by-date/2026-06-30/020635__2f131176.jsonl`
- 跑 2: `started_at=1782760309115` (BJT 03:11:49), `agent_session_path=""` (空)

后者对应的 JSONL 在 `<agentDir>/sessions/cron_1782760309116.jsonl`, 但 `findAgentSessionPath` (默认扫 `~/.omp/agent/sessions`) 找不到, 所以 executions 表里 `agent_session_path` 是空字符串。

**次要影响**: `by-date/2026-06-30/` 下同时存在大量裸 .jsonl 与同名空目录, 模式与 `hr3/sessions/` 一样, 只是规模小很多。

### 发现 2: 15 个孤儿空目录对应历史 cron 跑到 by-date 后被批量清理

| 目录 mtime | by-date 同期内容 |
|---|---|
| Jun 25 08:00 ~ Jun 26 19:00 | `by-date/2026-06-25/` 存在但 26/27 目录**整体不存在**; 28 起恢复 |
| Jun 28 07:00, 08:00 | `by-date/2026-06-28/` 存在 |

15 个空目录时间戳与"30 分钟一次"密集调度匹配, 反推次数也对得上（14–16 次 / 2 任务 × 2 天）。

**最可能解释** (推断, 未直接证实):
- Jun 25–26 期间 cron 任务走的是早期代码路径, 写到 by-date;
- 那批 by-date JSONL 后来被外部清掉（手动 / 某清理任务）, 但 `<agentDir>/sessions/cron_<id>/` 同名 artifact 目录是 OMP session manager 创建的, 跟 by-date 路径不在同一处, 清理时漏掉;
- 6 月 28 日代码切到 `buildAgentSessionPath` 后, JSONL 直接落在 `<agentDir>/sessions/`, 之后能稳定保留。

**未排除的替代解释**:
- 早期版本 `ArtifactManager` 实现是 eager 创建（不是现在 `artifacts.ts:38` 的 lazy `#ensureDir`）, 而 session 文件写入失败后目录残留;
- 其他运维操作（迁移、磁盘满后 truncate）导致 JSONL 丢失但目录元数据保留。

### 发现 3: 投递链路在 Jun 25 早期有 `Unknown channel: dingtalk` 失败, 但 3 个当前任务已正确

服务日志 `~/.omp/gateway-data/logs/service.log`:
- Jun 25 08:00:45: `Cron result delivery failed channel=dingtalk error="Unknown channel: dingtalk" taskName=daily-today-schedule`
- Jun 30 02:13 / 02:16 / 02:19: 三个 `test-deliver-*` 任务投递失败, 后两条错误是 `Unknown channel: dingtalk:hr:hr` (双后缀)

scheduler 当前 3 个任务:
```
check-mail-daily        delivery_channel=dingtalk delivery_account_id=hr
group-daily-summary     delivery_channel=dingtalk delivery_account_id=hr
daily-1200-schedule     delivery_channel=dingtalk delivery_account_id=hr
```

`createCronTaskFromMessage` (`scheduler/from-message.ts:140-147`) 的 `addTask` 调用没传 `accountId` 字段, `delivery` 对象也没 `accountId`; `host-tool.ts#handleAdd` 通过 `active.accountId` 自动推断会填好, 这两个路径行为不一致。当前 3 个任务都走 host tool 路径, 所以 `delivery_account_id` 已正确。

`Unknown channel: dingtalk:hr:hr` 这个双后缀错误路径来源未查清, 已在 6/30 02:22 之后不再出现, 推断是 `test-deliver-v4` 那次手填 `delivery` 时把 `channel: "dingtalk:hr"` 当成纯 id 传入导致。

### 发现 4: 旁路告警（不阻塞当前功能, 但值得记一笔）

- `SQLiteError: disk I/O error SQLITE_IOERR_VNODE` at 2026-06-30T00:42:46, 触发点 `scheduler/storage.ts:440 listTasks` → `file-store.ts:137 syncToDb` → `gateway-cron-lifecycle.ts:99`. 这是 uncaughtException, 之后 02:00 左右恢复。errno 6922 是 macOS `ENOTBLK`-类 I/O 错, 多数是文件系统/磁盘压力瞬间抖动, 不一定复现。
- `Gateway already running (PID 19888)` at 02:19:27, 重复启 gateway 失败的常见告警, 不影响主进程。
- `posix_spawn 'sh' ENOENT` at 2026-06-25T08:00:00, 影响已下线的 `daily-calendar-push` (taskId `task_1781936667447_1d82e9`), 同一任务 3 次重试全失败, 任务已被删除。

## 3. 推断的不变量 vs 实测

**实测**:
- 时间戳解码、目录 mtime、文件大小、内容抽样
- 6 月 30 日两个 daily-1200-schedule 跑分别落到两条路径, executions 表 `agent_session_path` 字段
- by-date 2026-06-26/27 目录不存在
- scheduler 当前 3 任务的 `delivery_*` 字段
- `createCronTaskFromMessage` / `host-tool.ts#handleAdd` 两个 cron 创建路径的差异（代码静态阅读）

**推断 (标 [inference])**:
- 15 个孤儿目录 = Jun 25–26 cron 跑到 by-date 后被批量清理, artifact 目录漏清。证据是 mtime + 调度密度 + by-date 同日空缺, 但**没有**直接证据证明是某次清理脚本干的。
- 6 月 28 日发生过代码路径切换使 cron 落到 `buildAgentSessionPath` 路径。证据是 28 之前 sessions/ 只有空 dir 没有 jsonl, 28 之后才成对出现; 但**没有**直接看到 commit 或配置变更证据。

## 4. 已知风险（不修, 记下）

| 编号 | 风险 | 影响 | 建议 |
|---|---|---|---|
| R1 | `findAgentSessionPath` 默认 `~/.omp/agent/sessions`, 不扫 `<agentDir>/sessions/cron_*.jsonl` | 走 gateway cron 显式路径的 runs 在 executions 表里 `agent_session_path` 为空, 后续 stats / debug 工具链看不到 | 后续加一段 fallback: 找不到时再扫 `<agentDir>/sessions/cron_*.jsonl` |
| R2 | `createCronTaskFromMessage` 没传 `accountId` | 通过 `/cron create` 旧 slash 创建的任务, 投递会因 key 缺后缀失败 | 如果该路径还在用, 需补 `accountId` 注入 |
| R3 | 6 月 30 日 00:42:46 出现过 `SQLITE_IOERR_VNODE` | 4 分钟窗口内 scheduler sync 不可用 | 监控告警 + 给 `syncToDb` 加 try/catch, 不要让异常冒泡到 process 级别 |
| R4 | `createCronTaskFromMessage` 与 `host-tool.ts#handleAdd` 行为不一致 | 同样的 cron 创建需求走两条路径会得到不同的 task 记录 | 收敛到 host tool, 或在 `from-message.ts` 复用 host tool 的 auto-inference |

## 5. 已确认的现状（不需要动作）

- 当前 3 个 cron 任务（`check-mail-daily`, `group-daily-summary`, `daily-1200-schedule`）都能正常跑 + 正常投递, executions 表里状态都对。
- 投递链路在 6/30 02:25 之后没有再出现 `Unknown channel` 类错误。
- `<agentDir>/sessions/` 里 Jun 28 之后的 `cron_<id>/` 空目录是正常 artifact 目录, JSONL 里的 tool 输出没超截断阈值所以目录保持空, 与旁边的 `cidz1b3B6_..._/1.bash.log` 等结构一致。
- 6 个 Jun 30 02:12–02:25 的小 jsonl（1.4–1.7 KB）是显式的 `测试 deliver 链路 OK` 测试任务, 4 行结构完整, 不算异常。

## 6. 不动, 等用户决定后续

按用户 2026-06-30 决定: 本次诊断仅作归档, **不**清理孤儿目录, **不**改动 `findAgentSessionPath`, **不**补 `createCronTaskFromMessage` 的 accountId 注入。
