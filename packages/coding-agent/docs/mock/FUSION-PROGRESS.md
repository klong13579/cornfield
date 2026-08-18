# Fusion 总账（Phase 1 + Phase 2 · 完结）

> 2026-08-18 · 基线 0c54175c4b → HEAD，81 文件 +7807/-437，27 张卡全交付
> 分支：hermes-fusion（主），w1-shell / w2-render / w3-data（三工位），一工位一 worktree

## 一、交付清单（27 卡）

### W1 骨架线（8 卡）
| 卡 | 内容 | commit |
|---|---|---|
| S2 | rail panel 化 + M1 注册表 + PanelHost（精确匹配+Outlet 回退） | 91dbc711c1 |
| S2c | AgentDetailView 弹层化（~900 行路由页→overlay） | d2199b9e9b |
| S3 | 会话侧栏 pin/工作区分组/搜索/双源 tab | 32b5a44544 |
| S4 | composer 中枢：ContextRing+QueueCard+agent 下拉增强 | 55f18a1953 |
| S5 | 右栏 Files/Artifacts + 共享 FileExplorer（-127 行重构） | e41125fbec |
| F1 | zinc 黑白 token 全站 + DevicePreview 移位 + 响应式抽屉 | 95503eea16 |
| W1-2 | SlashPalette 斜杠命令补全 | 42d8d91cf3 |
| W1-3 | Transcript swap（ActivityFold 消费）+ F2 骨架 | 9e4ad94d12 |

### W2 渲染线（6 卡）
| 卡 | 内容 | commit |
|---|---|---|
| R5 | ContextRing/QueueCard/SteerIndicator 三组件（第1天交付） | a5442043ec |
| R1a | markdown 管线 spike（不降级结论）+ SPIKE.md | 3c1a9edc23 |
| R1b | 管线接入 + 删 MarkdownLite（katex/hljs 拆 chunk） | ae8056febe |
| R2 | mermaid@11 lazy + 查看器（zoom/pan/fullscreen，573 行） | 70cc88626f |
| R3 | ActivityFold 折叠行（thinking+工具收纳，per-turn localStorage） | 11c9e1877b |
| R4/R6 | MsgActions hover 操作条 + 审批/澄清卡 UI 壳 | d4cdfa01b5 / cff7e26522 |

### W3 数据线（6 卡）
| 卡 | 内容 | commit |
|---|---|---|
| D1 | get_stats 命令（接 omp-stats，e2e 17/17） | 2a7fbf7e98 |
| D2 | InsightsPanel + list_sessions source 字段 + priceCatalog 修复（34/69） | 8d81ff422b |
| D3 | get_memory 三分区 + MemoryView（回落逻辑） | 0aca20958b |
| D4 | cron 面板壳（preset 体系+表达式预览+croner 同库校验，13 单测） | 7e47db7d03 |
| D5 | get_skills（42 技能真数据 user29+project13）+ SkillsView | 3b46d5053f |
| F2 | 真实 e2e（serve 源码启动→真 LLM 闭环，1.7min pass） | 8b7c37949a |

### 追加批（7 卡，用户日间决策）
| 卡 | 内容 | commit |
|---|---|---|
| STREAM-1 | **流式缺口修复**（progress 字段名不匹配——真 e2e 抓到的 bug） | 71dcc9ba82 |
| UNDO-1 | undo_exchange/retry_from/fork_from 三件套 + MsgActions 通电 + e2e | 24cfce9026 |
| APPROVAL | permission shell：inject/respond 命令 + pending 表(60s 超时) + R6 通电 | d895a13cc6 |
| 协议批 B-1 | steer 事件回显 + 流式 progress 帧 | 85ed9fb208 |
| 协议批 B-2 | queue 完整态 + cancel_queued | 10b8ad1100 |
| 协议批 B-3 | list_commands（SlashPalette 真源） | e0bb04f81a |
| 协议批 B-4 | response error 升级 { code, message } 12 码枚举（向后兼容） | a6f3270740 |

## 二、最终验证（主线独立复跑，非听汇报）

- check：62 文件 biome 0 错 + tsgo 干净
- build：vite ✓（主包 461KB/gzip 140KB，mermaid/katex/hljs 全部独立 chunk）
- **真实 e2e：1 passed 1.6min，sawStreaming=true（textLens [17,19] 双样本）——流式修复被证实**
- serve 启动：listening 正常，5 agents attach

## 三、夜间事故与处置（时间序）

| 事故 | 处置 |
|---|---|
| W1 双 block：node simdjson 缺库 + alibaba quota 429 | 补软链 + 换 narwal 池 |
| **共享 worktree 分支互踩**（W2 发现） | 重构为一工位一 worktree（fusion-w2/w3/main） |
| intercom broker 一夜死两次（watchdog 自身卡住） | gateway 重启恢复 ×2；根因调查独立 bug 卡（用户接管） |
| **W3 误提交污染 main**（git add -A 在主仓根执行，卷走 bug agent 在途工作） | main reset 回 86f06b8c4b，零丢失恢复；W3 加硬纪律（pwd 确认+禁 add -A） |
| W3 虚假验收（biome 3 错称全绿） | 打回；自验升级为完整包级 check |
| 三线合并冲突五处（含 merge 工件致 serve 语法错误） | 全部手解；wire-server 缺 return 那处是真险情（e2e 抓到） |

## 四、遗留账本（按优先级）

1. **agent-core canUseTool 挂起钩子**：审批闸门最后一块（~150 LOC + 挂起语义三决策：超时默认/abort 处理/多端谁响应）。前置全部就绪（permission shell 通、inject 模拟源可换真）。**公网开放前必须完成**
2. B3 技能写协议（set_skill_enabled）：SkillsView toggle 现为禁用态
3. gateway cron 代理命令（B6）：TasksView 列表数据通电
4. pi-wire 协议版本协商：分仓（A 方案）前需要
5. 根级存量 check 红（omp-gateway 在途测试/self-evolution/tui）：bug 线收尾后统一清
6. hermes 深读时记录的 backlog：Excalidraw/saved prompts/设置搜索/tab 排序/键盘守卫（均低优）

## 五、复盘要点

- **并行拓扑**：一工位一 worktree 是硬前提，共享单树必然互踩（第二小时就炸）
- **验收纪律有效**：W3 一次虚假验收被抓；e2e 抓到流式 bug 和合并语法错误——"不要被骗"的机制真实起效
- **三步决策门**：W2 方案等确认那次是好纪律，但也造成 idle——后续对信任度高的 agent 可以"方案+开工并行，事后审"
- 成本：全程三 agent 并行约 8 小时，模型费合计 <$25（kimi-k2.6/deepseek-v4-pro/flash 三池）


## 六、Phase 2 交付（追加，2026-08-18 下午）

| 卡 | 内容 | commit |
|---|---|---|
| P2-W2-1 | AssistantTurn（ActivityFold+MsgActions 行）+ FloatingCardHost | 77be94431f |
| P2-W2-2 | 渲染统一出口 + mermaid 复制源码 + ThinkingFold 死代码清除 | 598b81fae6 |
| P2-W3-1 | B6 cron 只读代理（get_cron_tasks，真机 6 任务） | 333839e8d0 |
| P2-W3-2 | cron 日志接口（真机 5 条记录 + 截断契约） | 22c432e340 |
| P2-W3-3 | B3 技能写协议（42→41→42 严格往返 + disabled 名单/回切） | 7490c8bdc1 |
| P2-W1-1 | **agent-core canUseTool 挂起钩子**（五路单测，零变化守卫） | ef1a367d93 |
| P2-W1-4 | **serve 审批接线——审批链全真**（bash 上闸、once/session、14 测试） | 5ee903ad88 |

### Phase 2 里程碑：审批闸门上线
agent 跑 bash → web/任一端弹审批卡 → 人批（once/session）→ agent 继续。
终验活链路：真 serve + inject approval → push 实际到达 → respond → 全链路 true。
always 持久化按安全理由砍掉（模糊 pattern 雷区），permission-allowlist.json 留后续卡。

### Phase 2 事故
- W1/W2 被外部误杀 ×1 → worktree 是真相源，10 分钟恢复，W1 未提交 81 行零丢失
- intercom 会话 ID 失效两次（worker 发旧 ID 静默丢信）→ 上报地址统一纠正 + intercom-check.sh 每日轮询进监控
- W3 技能热重载 bug（42→74）→ 打回复修（重发现参数对齐 boot），往返严格一致

### 遗留（更新）
1. always 持久 allowlist + glob pattern（安全设计需单独立项）
2. 澄清 disabledExtensions 与 ignoredSkills 双通道的管理面（现面板只管后者）
3. web-app 全量 check:types 存量红（部分树缺 markdown 依赖——分支树孤立问题，合并主线已自愈）
4. 存量 backlog 不变（协议版本协商/omp-gateway 在途测试/低优 hermes 项）
