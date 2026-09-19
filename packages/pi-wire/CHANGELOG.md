# Changelog

## [Unreleased]

### Added

- **`rename_session`**（`src/commands.ts`, `test/shape-lock.test.ts`）：`{ sessionFile, name }`——改**磁盘上**一条会话记录的名字（`list_sessions` 给出的绝对路径）。与 `set_session_name` 的分工写在命令注释里：后者按附件地址定位、只能改本连接挂着的那个会话；前者够得到会话列表里那些不在任何进程里的历史会话。serve 侧的拒绝原因（越界路径 / 挂着的会话 / 刚被写过的文件 / 名字为空）原样回给客户端。

- **`ArtifactDto.source`：产物说清是谁放进会话的**（`src/results/artifacts.ts`）：`ArtifactDto` 加必填字段 `source: ArtifactSource`（`"agent" | "user"`），`list_artifacts` 从此报两本账 —— `agent` = 会话 JSONL 里 write / edit / puppeteer screenshot 写出的文件；`user` = 用户发给该会话的文件（目前是贴/选进来的图，落在会话 artifacts 目录的 `uploads/`）。必填而不是可选：两个产出方都在本仓，谁产出谁声明，前端因此不必猜、也没有「来源未知」这一态。路径约束两个来源相同（会话 workspace roots，与 fs_read / `/preview` 同一条边界），所以 /preview 不用为它开新口。

### Fixed

- **shape-lock 的命令清单补上 `pick_directory`，并登记 `rename_session`**（`test/shape-lock.test.ts`）：`pick_directory` 进了 `WireCommand` union 但漏了 `COMMAND_TYPES` 清单，`_noMissing` 断言因此失败——`packages/pi-wire` 的 `check:types` 一直是红的。清单是命令面的唯一台账，加命令与登记清单必须同一次改。

## [1.3.0] - 2026-09-17

### Added

- **`hello_ack` 增加可选 `gatewayWirePort`**（`src/frames.ts`）：服务端报它自己用的 gateway wire 端口（`CORNFIELD_GATEWAY_WIRE_PORT`，缺省 7892，与 serve 内部代调 gateway 的值同源）。浏览器读不到 env，前端该连哪个端口只能由握手告诉它 —— 此前 web-app 自己写死 7892，于是用**隔离 HOME** 起的 serve 里打开页面，前端照样连到本机真实运营中的 gateway。stdio 语义的握手不代调 gateway，因此不报（客户端在拿到之前必须明说端口未知，不得回退到一个猜的端口）。

- **`set_thinking_level` 增加可选 `persist`**（`src/commands.ts`）：缺省只改本次会话（与随时切档同语义）；`persist: true` 时内核把生效档位一并写进目标 agent 的配置，重启后仍是它。内核只在档位真的发生变化时才写盘。

- **`get_agent_prompt_sources`**（`src/commands.ts`, `src/results/agents.ts`）：读目标 agentDir 的 prompt 源清单，逐项 `{ path, title, description, exists }`。清单的权威在服务端（`skeleton/agent-dir-files.ts`），形状与 `exists` 一起构成契约：缺的那项也在清单里，不裁成「存在的那些」。

- **`create_agent`**（`src/commands.ts`, `src/results/agents.ts`）：建一个 agentDir（`name` 必填，`dir` / `mission` / `template` 可选），回传 `{ name, agentDir, created, filesWritten }` —— serve 侧复用 `cornfield agent init` 的实现，失败把服务端原文交给客户端。

- **「最深祖先 root 获胜」规则单源化**（`src/scope.ts`）：新增纯选择函数 `pickDeepestRootIndex(roots, targetPath)` —— 返回命中 `targetPath` 的最深祖先 root 的下标（未命中 = -1）。不碰文件系统、不做归一化：输入是调用方按自己运行时的真实能力归一后的字符串（serve 用 realpath，浏览器用词法），判定只有这一份。边界：`/a/b` 不是 `/a/bc` 的祖先；`/a/b/` 与 `/a/b` 等价；空串 root 跳过；多个命中取最深者。

- **调度定义写面与 schedule 绑定形状**（`src/commands.ts`, `src/results/cron.ts`）：新增 `cron_create` / `cron_update` / `cron_remove` / `cron_test_run` 四条 wire 命令（`cron_update` / `cron_remove` 用 `taskId` —— 不复用命令的关联 `id`）；`TaskRowDto` 补 agent 绑定（`agentId` / `agentDir` / `agentDisplayName` / `agentResolution` / `agentEnabled` / `agentError` / `projectIds`）与可靠性事实（`taskType` / `timeoutMs` / `retry` / `repeatCount` / `repeatCompleted` / `delivery` / `lastDeliveryError` / 时间戳），`CronLogEntryDto` 补 `agentSessionPath`；新增 `ScheduleAgentResolution` 三态（registered / unregistered / unbound）与写面入参/回写形状。

- **听记条目形状 canon化**（`src/results/listen.ts`）：`ListenRecordingDto` + `ListenProvenanceDto`（写入时标下的 agentId / agentDir / projectId / sessionFile）进 pi-wire，serve 与 web-app 共用一份（客户端级听记库里的归属只能来自这个字段，缺省 = 未标注）。

- **`CronUpdateInput.unbind`**（`src/results/cron.ts`）：改绑语义写进契约 —— 两个字段都不给 = 不动绑定；只给 `agentId`/`agentDir` = **整个绑定换成它**（不隐式保留旧身份）；两个都给必须指向同一个 Agent，否则网关 `ok:false`；`unbind: true` 显式清空（与上面两个字段互斥）。

### Changed

- **`set_config` 的缺省落点不再硬编码 `global`**（`src/commands.ts`）：不传 `scope` 时由服务端按「合并视图解析这个键的那一层」判定（有 project 层就写 project，否则写本实例的 `config.yml`），响应里回报的 `scope` 就是真落到的那一层。`get_config` / `set_config` 改为读/写**目标 agent 自己的配置实例**，因此需要该 agent 已挂载（未挂载时 `ok:false`，错误文本 `agent not attached: …`）；只查 agentDir 文件的 `get_agent_prompt_sources` 不受影响。

## [1.1.1] - 2026-09-06

### Added

- **听记分帧上传命令类型**（`src/commands.ts`）: 新增 record_transcribe_begin / record_transcribe_chunk / record_transcribe_end 三条命令类型——长录音 base64 超 Bun WS 单帧 16MB 上限时前端分帧上传。

## [1.1.0] - 2026-09-05

### Added

- **模型控制中心协议契约**（`src/commands.ts`, `src/results/models.ts`, `src/results/providers.ts`, `src/results/config-scope.ts`）: v2 全量目录 DTO（`ModelCatalogDto`/`ModelCatalogEntryDto`，六态互斥 status + 目录元数据）；Provider 接入九命令与 `ProviderStatusDto`/`ProviderDependencyDto`/`ProviderDisconnectResultDto`（依赖检查走结果不走错误通道）；配置作用域 DTO（`ConfigScope`/`ConfigScopeDto`/`ConfigScopeKeyDto`/`ModelSelectionDto`）；`test_model`/`refresh_catalog`；`set_config` 支持 `scope`。所有响应不回显明文凭据，仅掩码。v1 `get_available_models`/`AvailableModelsDto` 保留不动（旧端兼容）。
