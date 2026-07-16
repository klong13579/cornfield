## 配置项完整说明（含使用场景）

按 UI 的 8 个 tab 分。没有使用场景说明的表示一般不需要动，保持默认即可。

---

### Appearance（外观）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `theme.dark` | 暗色主题 | `titanium` | 换主题 |
| `theme.light` | 亮色主题 | `light` | 换主题 |
| `symbolPreset` | 图标风格：unicode / nerd / ascii | `unicode` | 终端不支持 unicode 符号时切 ascii |
| `colorBlindMode` | 色盲模式（diff 新增用蓝不用绿） | `false` | 色盲用户开 |
| `statusLine.preset` | 状态栏预设 | `default` | 觉得状态栏太挤/太空时选 compact/minimal/full |
| `statusLine.separator` | 状态栏分隔符样式 | `powerline-thin` | 终端不支持 powerline 时切 slash/pipe/ascii |
| `statusLine.showHookStatus` | 状态栏下显示 hook 状态 | `true` | hook 太多觉得吵就关 |
| `terminal.showImages` | 终端内嵌显示图片 | `true` | 终端不支持或不需要看图时关 |
| `images.autoResize` | 大图自动缩到 2000x2000 | `true` | 传给模型的图片太大浪费 token 时截断 |
| `images.blockImages` | 禁止发图片给 LLM | `false` | 想省 token 或隐私顾虑时开 |
| `display.tabWidth` | Tab 渲染宽度（空格数） | `3` | 看代码 tab 缩进不合眼时调 |
| `display.showTokenUsage` | 每条 assistant 消息显示 token 用量 | `false` | 想监控 token 消耗时开 |
| `showHardwareCursor` | 显示终端硬件光标（IME 输入用） | `true` | 输入法光标有问题时关 |
| `clearOnShrink` | 内容缩小时清空空行（可能闪屏） | `false` | 屏幕刷新有残留时开，闪屏就关 |

---

### Model（模型）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `defaultThinkingLevel` | 推理深度：minimal/low/medium/high/xhigh | `high` | 模型响应太慢时调低到 low/minimal；复杂推理不够时调高到 xhigh |
| `hideThinkingBlock` | 隐藏 thinking 块 | `false` | 看 thinking 太占屏或者不需要推理过程时开 |
| `repeatToolDescriptions` | 系统 prompt 里重复完整 tool 描述 | `false` | 模型选错工具频率高时开（代价是浪费 token） |
| `temperature` | 采样温度（-1=模型默认，0=确定，1=创意） | `-1` | 需要更确定性输出设 0；需要更创意设 0.7-1 |
| `topP` | 核采样（-1=模型默认） | `-1` | 一般不动 |
| `topK` | Top-K 采样（-1=模型默认） | `-1` | 一般不动 |
| `minP` | 最小概率阈值（-1=模型默认） | `-1` | 过滤低概率 token 时用 |
| `presencePenalty` | 存在惩罚（-1=模型默认） | `-1` | 模型话题太重复时调高 |
| `repetitionPenalty` | 重复惩罚（-1=模型默认） | `-1` | 模型句子/短语复读时调高 |
| `serviceTier` | OpenAI 服务优先级 | `none` | 有 OpenAI 容量层套餐时设 flex/scale 省钱 |
| `streaming.doomLoop.enabled` | 检测并中止思考/文字重复死循环 | `true` | 跑 benchmark/fixture 测试时关掉 |
| `streaming.doomLoop.thinking.uniqueRatio` | 唯一 4-gram 比例阈值 | `0.15` | 模型频繁死循环但检测没触发，调低到 0.1 |
| `streaming.doomLoop.thinking.minPhraseRepeat` | 短语重复次数阈值 | `200` | 模型短句频繁复读，调低尽早触发 |
| `streaming.doomLoop.maxThinkingChars` | 单条 thinking 硬上限（0=不限制） | `16384` | 模型 thinking 太长导致超时，设 8192 限制 |
| `streaming.doomLoop.maxRetries` | 死循环恢复重试次数（关 thinking 重试） | `1` | 设 0 则检测到死循环直接终止不重试；设 2 给更多恢复机会 |
| `retry.maxRetries` | API 错误最大重试次数 | `3` | 网络不稳定时调高到 5 |
| `retry.fallbackCooldownMs` | 降级冷却最短时间 | `60000` | 降级太快切回主模型又崩时调高 |
| `retry.fallbackRevertPolicy` | 何时回到主模型：冷却过期 / 永不 | `cooldown-expiry` | 主模型不可靠时设 `never` 保持在降级模型 |

---

### Interaction（交互）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `autoResume` | 自动恢复最近 session | `false` | 经常在同一目录断线重连时开 |
| `steeringMode` | 排队消息处理方式：all / one-at-a-time | `one-at-a-time` | agent 干活时你连发多条消息，all 会在当前轮结束后全部处理，one-at-a-time 一条一条处理 |
| `followUpMode` | 后续消息排放方式 | `one-at-a-time` | 同上，控制 agent 完成后多条待处理消息怎么消化 |
| `interruptMode` | 中断消息何时打断工具执行 | `immediate` | 设 `wait` 则 agent 等到当前工具执行完才处理新消息，适合工具执行不能中断的场景 |
| `loop.mode` | `/loop` 迭代间处理 | `prompt` | `compact` 每次循环压缩上下文减少 token；`reset` 重置上下文但保留指令 |
| `doubleEscapeAction` | 空编辑器中按两次 Esc | `tree` | 设 `branch` 直接进 branch 管理，`none` 不做任何事 |
| `treeFilterMode` | 会话树默认过滤 | `default` | 想默认只看用户消息选 `user-only`，全看选 `all` |
| `autocompleteMaxVisible` | 自动补全最大显示数 | `5` | 补全项太多看不清就调低 |
| `startup.quiet` | 跳过欢迎和启动状态消息 | `false` | 测试或 CLI 脚本调 omp 时开 |
| `startup.checkUpdate` | 启动时检查更新 | `true` | 离线环境或不想慢启动时关 |
| `collapseChangelog` | 更新后显示简化 changelog | `false` | 更新日志太长时开 |
| `completion.notify` | 任务完成通知 | `on` | agent 在后台干活你去干别的，完成后想被通知保持 on |
| `completion.sound` | 完成提示音 | `Hero` | 换一个喜欢的提示音 |
| `ask.notify` | Ask 工具等待输入时通知 | `on` | agent 问问题时不需要通知就关 |
| `stt.enabled` | 语音输入 | `false` | 想用语音发指令时开 |
| `stt.language` | 语音识别语言 | `zh` | 换其他语言 |
| `stt.modelName` | Whisper 模型 | `mlx-community/whisper-large-v3-turbo` | 准确度不够换更大模型，速度慢换更小模型 |

---

### Context（上下文）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `contextPromotion.enabled` | 上下文溢出时自动提升到大窗口模型 | `true` | 不想因溢出自动切模型就关（但会走到 compaction） |
| `compaction.enabled` | 自动压缩上下文 | `true` | 关掉不会解决溢出，只会让 agent 在长会话中表现越来越差，不推荐关 |
| `compaction.strategy` | 压缩策略：context-full / handoff / off | `context-full` | `handoff` 会产生新 session 类似翻页，适合极长会话；`context-full` 原地压缩 |
| `compaction.thresholdPercent` | 压缩触发百分比 | `-1` | 设 80 表示上下文用到 80% 时触发；-1 走 legacy 逻辑 |
| `compaction.thresholdTokens` | 固定 token 上限 | `-1` | 设 64000 表示超 6.4w token 就压缩，覆盖百分比配置 |
| `compaction.idleEnabled` | 空闲时预压缩 | `false` | 经常停在 agent 思考但你离开了，开这个让它闲时预压缩 |
| `branchSummary.enabled` | 离开分支时自动摘要 | `false` | 常用 branch 切换的人开，方便回来时回忆上下文 |
| `memories.enabled` | 自动记忆提取与整合 | `false` | 想让 agent 跨 session 记住你的偏好和项目知识时开 |
| `selfEvolution.enabled` | 自我进化学习系统 | `true` | 跑测试/调 prompt 不想被学习过程干扰时关 |
| `selfEvolution.nudgeContextInjection` | 注入 session 提示到上下文 | `true` | 觉得 nudge 提示分散注意力就关 |
| `selfEvolution.enableNudgeUI` | 显示 nudge 通知 | `true` | 提示弹窗多了觉得烦时关 |
| `ttsr.enabled` | 时间旅行流规则（匹配模式时打断/警告） | `true` | 不需要实时规则干预时关 |
| `ttsr.interruptMode` | 何时打断 vs 完成后再警告 | `always` | 设 `prose-only` 只打断文本输出不打断工具调用 |

---

### Editing（编辑）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `edit.mode` | 编辑模式 | `hashline` | patch 频繁失败切 `replace`（最稳但 token 多）；喜欢 vim diff 格式切 `vim` |
| `edit.fuzzyMatch` | 模糊匹配空白差异 | `true` | patch 因缩进频繁失败时关掉（更严格），但通常开着更好 |
| `edit.streamingAbort` | patch 预览失败时中止流式编辑 | `false` | 开的话 patch 失败就停，避免继续浪费时间 |
| `edit.blockAutoGenerated` | 禁止编辑自动生成文件 | `true` | 需要改 protoc/sqlc 等生成文件时关 |
| `readLineNumbers` | read 输出默认显示行号 | `false` | 经常要跟 agent 说行号时开 |
| `readHashLines` | read 输出显示行 hash | `true` | hashline 编辑模式需要，关掉会影响 edit 精度 |
| `read.defaultLimit` | read 默认行数 | `500` | 经常需要看更多/更少上下文时调 |
| `lsp.enabled` | 启用 LSP 工具 | `true` | 不需要 LSP 诊断/类型查询时关（省资源） |
| `lsp.formatOnWrite` | 写入后自动格式化 | `false` | 想让 agent 写完代码自动格式化时开 |
| `lsp.diagnosticsOnWrite` | 写入后返回诊断 | `true` | 写文件后想顺便看错误/警告就保持开 |
| `lsp.diagnosticsOnEdit` | 编辑后返回诊断 | `false` | 开的话每次 edit 都会多一次 LSP 调用，改文件出错多时值得开 |
| `bashInterceptor.enabled` | 拦截用 bash 替代专用工具的命令 | `false` | agent 频繁用 grep/sed/cat 代替专用工具导致效率低时开 |
| `shellMinimizer.enabled` | 压缩 verbose 输出 | `true` | git/npm/cargo 等输出太长占上下文 token 时保持开 |
| `python.toolMode` | Python 执行方式 | `both` | 只用 IPython 时选 `ipy-only`，只用 bash 执行时选 `bash-only` |
| `python.kernelMode` | IPython kernel 保持 session / per-call | `session` | 内存泄漏或 kernel 太占资源时切 `per-call`（每调用重启） |

---

### Tools（工具）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `tools.artifactSpillThreshold` | 工具输出大于此值存 artifact（KB） | `50` | 工具输出经常被截断就调高，想省上下文 token 就调低 |
| `tools.intentTracing` | agent 执行工具前说明意图 | `true` | 觉得 agent 做事前啰嗦就关，但开有助于发现工具选错 |
| `todo.enabled` | 启用 todo 工具 | `true` | 不需要任务追踪就关 |
| `todo.eager` | 首次消息后自动创建 todo 列表 | `false` | 复杂项目开，agent 会自动拆任务；简单场景关掉避免啰嗦 |
| `todo.reminders` | 停止前提醒完成 todo | `true` | 不需要 agent 停之前纠缠 todo 就关 |
| `find.enabled` | 启用 find 工具 | `true` | 几乎不需要关 |
| `search.enabled` | 启用 search 工具 | `true` | 几乎不需要关 |
| `astGrep.enabled` | 启用 ast_grep | `true` | 几乎不需要关 |
| `astEdit.enabled` | 启用 ast_edit | `true` | 几乎不需要关 |
| `irc.enabled` | 启用 IRC agent 间通信 | `true` | 单 agent 场景不需要 IRC 就关 |
| `debug.enabled` | 启用 debug 工具（DAP） | `true` | 不需要调试就关 |
| `switchModel.enabled` | 启用 switch_model | `true` | 不想让 agent 主动换模型就关 |
| `fetch.enabled` | 允许 read 工具获取 URL | `true` | 安全策略不允许访问外网时关 |
| `web_search.enabled` | 启用网页搜索 | `true` | 省 token/省搜索额度时关 |
| `github.enabled` | 启用 GitHub CLI 工具 | `false` | 需要 agent 操作 GitHub 时开 |
| `browser.enabled` | 启用浏览器 | `true` | 不需要网页抓取/操作时关 |
| `browser.persistState` | 持久化浏览器登录状态 | `true` | 不想 cookie 跨 session 留存时关 |
| `async.enabled` | 启用异步命令执行 | `false` | 需要后台跑长任务时开 |
| `mcp.enableProjectConfig` | 从项目根加载 MCP 配置 | `true` | 不想加载项目级 MCP 时关 |
| `mcp.discoveryMode` | MCP 工具发现模式 | `false` | MCP 工具太多，想精选展示时开 |
| `ask.enabled` | 启用 ask 工具 | `true` | agent 频繁问问题打扰你时关（会改成自由文本输入或 grilling） |

---

### Tasks（任务）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `task.isolation.mode` | 子任务隔离模式 | `none` | 多个 subagent 改同一文件打架时开 `worktree`（代价是磁盘和 merge 耗时） |
| `task.isolation.merge` | 隔离变更合并策略 | `patch` | worktree 隔离时 `patch` 应用简洁，`branch` 适合需要人工 review 每个 subagent 的变更 |
| `task.isolation.commits` | 隔离仓库提交信息风格 | `generic` | 想看到 AI 生成的详细提交信息切 `ai` |
| **`task.eager`** | **默认委托子任务** | `false` | 开：agent 自动把多文件改动/调研/测试拆成 task 并行，更快但 token 更多。关：agent 自己串行干。适合复杂多步任务时开。 |
| `task.simple` | 任务输入模式 | `default` | `schema-free` 省掉 schema 定义；`independent` 每个子任务完全独立不共享 context，适合安全隔离需求 |
| `task.maxConcurrency` | 子任务最大并发数 | `32` | 内存/API 配额有限时调低到 4-8 |
| `task.maxRecursionDepth` | 子任务可再派生子任务的最大深度 | `2` | 简单任务 1 足够不需要嵌套；复杂多层任务可能需要 3 |
| `tasks.todoClearDelay` | 已完成/放弃 todo 自动清除延迟（秒） | `60` | 想多看一会已完成的任务就调大 |
| `skills.enabled` | 技能系统总开关 | `true` | 不需要技能注入 prompt 时关 |
| `skills.enableSkillCommands` | 注册技能为 `/skill:name` 命令 | `true` | 技能太多导致斜杠命令列表太长时关 |

---

### Providers（提供商）

| 路径 | 说明 | 默认值 | 使用场景 |
|---|---|---|---|
| `secrets.enabled` | 发送给 AI 前混淆敏感信息 | `false` | 不想 API key/token 被模型看到时开（有性能开销） |
| `providers.webSearch` | 网页搜索提供商 | `auto` | 想指定只用某家（如 kimi/perplexity）时选，`auto` 会试所有已配置的 |
| `providers.image` | 图像生成提供商 | `auto` | 想指定只用某家时选 |
| `providers.openaiWebsockets` | OpenAI Codex WebSocket 策略 | `auto` | 显式强制开启或关闭 WebSocket |
| `exa.enabled` | Exa 搜索总开关 | `true` | 不用 Exa 时关 |
| `searxng.endpoint` | 自建搜索端点 URL | undefined | 自建了 SearXNG 就填地址 |
