# Hermes Agent — Gateway / Agent / Cron / Channel / SystemPrompt 架构研究

> 研究对象：hermes-agent 项目中 gateway、agent、cron、channel、systemPrompt 五个功能模块的整体架构、关联性与业务流。
> 基于 hermes-agent 源码，2026-06-23。

---

## 目录

1. [模块总览与关联地图](#1-模块总览与关联地图)
2. [配置加载体系](#2-配置加载体系)
3. [System Prompt 分层架构](#3-system-prompt-分层架构)
4. [Gateway 消息处理流](#4-gateway-消息处理流)
5. [Channel Context 注入机制](#5-channel-context-注入机制)
6. [Cron Job 完整业务流](#6-cron-job-完整业务流)
7. [跨模块关联性矩阵](#7-跨模块关联性矩阵)
8. [关键设计决策与 trade-off](#8-关键设计决策与-trade-off)

---

## 1. 模块总览与关联地图

### 1.1 模块职责

| 模块 | 核心文件 | 职责 |
|---|---|---|
| **Gateway** | `gateway/run.py`, `gateway/config.py`, `gateway/session.py` | 长驻进程，管理多平台 adapter 生命周期，路由消息到/从 agent，调度 cron tick |
| **Agent** | `run_agent.py`, `agent/prompt_builder.py` | AIAgent 类——核心对话循环，system prompt 组装，工具调用，LLM API 交互 |
| **Cron** | `cron/scheduler.py`, `cron/jobs.py`, `tools/cronjob_tools.py` | 定时任务存储、调度、执行、投递；无头 agent 工厂 |
| **Channel** | `gateway/platforms/base.py`, `gateway/platforms/*.py`, `gateway/channel_directory.py` | 平台 adapter 抽象层，per-channel prompt 解析，频道目录管理 |
| **SystemPrompt** | `agent/prompt_builder.py`, `run_agent.py._build_system_prompt()` | 分层组装 system prompt，缓存层与临时层分离，保证 prompt cache 稳定性 |

### 1.2 全局业务流

```
                         ┌─────────────────────────────────────────────┐
                         │              Gateway 进程 (长驻)               │
                         │                                             │
  用户消息 ──────────────▶│  Platform Adapter (Telegram/Discord/...)     │
                         │    │ 解析消息 → MessageEvent                  │
                         │    │ resolve_channel_prompt() → channel_prompt│
                         │    ▼                                        │
                         │  GatewayRunner._handle_message()             │
                         │    │ build_session_context() → context_prompt │
                         │    ▼                                        │
                         │  run_sync() → AIAgent                        │
                         │    │ combined_ephemeral = context_prompt      │
                         │    │   + channel_prompt                      │
                         │    │   + _ephemeral_system_prompt             │
                         │    ▼                                        │
                         │  AIAgent.run_conversation()                  │
                         │    │ _build_system_prompt() [缓存层, 一次性]   │
                         │    │ effective_system = cached + ephemeral   │
                         │    │ → LLM API                                │
                         │    ▼                                        │
                         │  工具调用 (cronjob/create_job, send_message…) │
                         │                                             │
                         │  ┌── 后台线程 (daemon) ──────────────────┐    │
                         │  │ _start_cron_ticker (每 60s)           │    │
                         │  │   → tick()                            │    │
                         │  │     → get_due_jobs()                  │    │
                         │  │     → advance_next_run() [先推进]      │    │
                         │  │     → run_job() [独立 headless agent]  │    │
                         │  │     → _deliver_result() [投递]         │    │
                         │  │     → mark_job_run() [状态更新]        │    │
                         │  └──────────────────────────────────────┘    │
                         └─────────────────────────────────────────────┘
```

### 1.3 三种 Agent 创建路径对比

| 维度 | Gateway Agent | Cron Agent | CLI Agent |
|---|---|---|---|
| **入口** | `run_sync()` L8608 | `run_job()` L736 | `cli.py` |
| **platform** | `"telegram"` 等 | `"cron"` | `"cli"` |
| **skip_context_files** | False | True | False |
| **skip_memory** | False | True | False |
| **ephemeral_system_prompt** | 三段拼接（context + channel + 人格） | 无 | 无 |
| **disabled_toolsets** | 视配置 | `["cronjob", "messaging", "clarify"]` | 视配置 |
| **session_id** | gateway session key | `cron_{job_id}_{timestamp}` | CLI session |
| **agent cache** | 有（per-session 复用） | 无（每次新建） | 无 |

---

## 2. 配置加载体系

### 2.1 三套独立的 Config Loader

AGENTS.md 明确指出存在三套独立的配置加载器，各自服务不同入口：

| Loader | 使用场景 | 位置 |
|---|---|---|
| `load_cli_config()` | CLI 交互模式 | `cli.py` |
| `load_config()` | `hermes tools`、`hermes setup` | `hermes_cli/config.py` |
| 直接 YAML load | Gateway 进程 | `gateway/run.py` 顶部 |

此外，cron 的 `run_job()` 有**第四套**独立的 config 读取逻辑——直接 `yaml.safe_load` config.yaml，不调用上述任何 loader。

### 2.2 Gateway 启动时的配置优先级

`gateway/run.py` L83-137 分两步加载配置：

**第一步：加载 .env（override=True）**

```python
# gateway/run.py L83-88
load_hermes_dotenv(hermes_home=_hermes_home, ...)
```

`load_hermes_dotenv`（`hermes_cli/env_loader.py` L92-123）的行为：
- `~/.hermes/.env` 以 `override=True` 加载——**覆盖 shell 中已导出的同名变量**
- 项目根目录 `.env` 作为开发回退，仅在用户 `.env` 不存在时 override，否则只填空
- 加载后执行 `_sanitize_loaded_credentials()`，清除凭证类环境变量（`_API_KEY`、`_TOKEN` 等）中的非 ASCII 字符

**第二步：读 config.yaml（仅填空，terminal/auxiliary 除外）**

```python
# gateway/run.py L102-104 — 顶层简单值：只在 .env 没设时写入
for _key, _val in _cfg.items():
    if isinstance(_val, (str, int, float, bool)) and _key not in os.environ:
        os.environ[_key] = str(_val)
```

```python
# gateway/run.py L131-137 — terminal.* 嵌套配置：无条件覆盖
for _cfg_key, _env_var in _terminal_env_map.items():
    if _cfg_key in _terminal_cfg:
        os.environ[_env_var] = str(_val)  # 不检查是否已存在
```

**优先级矩阵：**

| 配置类别 | 优先级（高 → 低） | 决定行 |
|---|---|---|
| `.env` 中的顶层值（如 `HERMES_MODEL`） | .env > config.yaml 顶层 > shell 导出 | L103 `and _key not in os.environ` |
| `terminal.*` 嵌套值 | config.yaml > .env（无条件覆盖） | L137 直接赋值 |
| `auxiliary.*` 嵌套值 | config.yaml > .env（无条件覆盖） | L142-160 同理 |

**设计意图**：`.env` 管凭证（API key、bot token）——敏感、频繁变更，所以 .env 说了算。`terminal.*` 和 `auxiliary.*` 是结构化配置——应在 config.yaml 管理，所以 config.yaml 说了算。

### 2.3 每条消息重读 .env（热更新凭证）

```python
# gateway/run.py L8468-8471 (run_sync 内部)
# Re-read .env and config for fresh credentials (gateway is long-lived,
# keys may change without restart).
load_dotenv(_env_path, override=True, encoding="utf-8")
```

**原因**：gateway 是长驻进程（可能跑数天不重启），用户可能通过 `hermes auth add` 或编辑 `.env` 更换了 API key。不重读会导致 401。

**为什么不破坏 prompt caching**：

重读 .env 更新的是 `os.environ`，然后 `_resolve_session_agent_runtime()`（L8478）从中重新解析 `api_key` 等放进 `runtime_kwargs`。这条路径不碰 system prompt 内容。

- **system prompt**（缓存层）由 `_build_system_prompt()` 构建，存在 `self._cached_system_prompt`，内容是 agent 身份、memory、skills、context files——不含 API key。
- **凭证 / runtime kwargs**（不缓存）在每次 `client.chat.completions.create()` 调用时从 `self.api_key` 取值。

**微妙风险**：如果 .env 改的是影响 system prompt 内容的变量（如 `HERMES_MODEL`，因为部分 guidance 按 model 注入），`_agent_config_signature()`（L8584）签名会变 → agent cache miss → 新 AIAgent 重建 system prompt → 对 Anthropic 来说前缀文本变了 → cache break。这是设计上的 trade-off：热更新优先于缓存效率。

### 2.4 Cron 的独立配置读取

`cron/scheduler.py` L615-760 的 `run_job()` 不复用 gateway 的 config 对象，而是自己从文件读：

**原因一：cron agent 的配置上下文与 gateway agent 不同**

| 参数 | gateway agent | cron agent |
|---|---|---|
| `skip_context_files` | False | True（"Don't inject SOUL.md/AGENTS.md from scheduler cwd"） |
| `skip_memory` | False | True（"Cron system prompts would corrupt user representations"） |
| `platform` | "telegram" 等 | "cron" |
| `disabled_toolsets` | 视配置 | `["cronjob", "messaging", "clarify"]` |

**原因二：cron 支持独立运行模式**

`tick()` 可被 `hermes cron daemon` 或 system cron 独立调用，此时没有 gateway 上下文。所以它不能依赖 gateway 已加载的 config 对象，必须自举。

**原因三：per-job 配置覆盖**

cron job 本身可带 `model`、`provider`、`base_url` 字段，job 级配置优先于全局。这个逻辑写在 `run_job` 内，与 gateway 的 session 级 override 是完全不同的路径。

```python
# scheduler.py L630
model = job.get("model") or os.getenv("HERMES_MODEL") or ""
```

---

## 3. System Prompt 分层架构

### 3.1 两层分离设计

system prompt 在 hermes 里分为两层：

- **缓存层**（`_cached_system_prompt`）：session 内构建一次，跨 turn 不变，保证 Anthropic prompt cache 前缀稳定。
- **临时层**（`ephemeral_system_prompt`）：每次 API 调用时拼接，不进 session DB，不影响 cache 前缀。

```
effective_system = _cached_system_prompt + "\n\n" + ephemeral_system_prompt
                                     ↑                      ↑
                              缓存层（稳定）          临时层（可变）
```

### 3.2 缓存层：`_build_system_prompt()`

`run_agent.py` L3345-3510，按 7 个顺序拼接 `prompt_parts`：

```
┌─ 1. Agent 身份 ──────────────────────────────────────────────┐
│  SOUL.md（如果存在且 skip_context_files=False）               │
│  或 DEFAULT_AGENT_IDENTITY（硬编码 fallback）                 │
└──────────────────────────────────────────────────────────────┘
┌─ 2. 工具使用引导 ────────────────────────────────────────────┐
│  MEMORY_GUIDANCE         （如果 memory 工具已加载）            │
│  SESSION_SEARCH_GUIDANCE  （如果 session_search 工具已加载）   │
│  SKILLS_GUIDANCE          （如果 skill_manage 工具已加载）     │
└──────────────────────────────────────────────────────────────┘
┌─ 3. Nous 订阅引导 ───────────────────────────────────────────┐
│  build_nous_subscription_prompt(valid_tool_names)             │
└──────────────────────────────────────────────────────────────┘
┌─ 4. 工具调用强制 + 模型专属指令 ─────────────────────────────┐
│  TOOL_USE_ENFORCEMENT_GUIDANCE  （按 model 名匹配）            │
│  GOOGLE_MODEL_OPERATIONAL_GUIDANCE  (Gemini/Gemma)           │
│  OPENAI_MODEL_EXECUTION_GUIDANCE    (GPT/Codex)              │
└──────────────────────────────────────────────────────────────┘
┌─ 5. 外部传入的 system_message ───────────────────────────────┐
│  gateway/CLI 传入的固定 prompt（如有）                        │
└──────────────────────────────────────────────────────────────┘
┌─ 6. 持久记忆 ────────────────────────────────────────────────┐
│  MEMORY.md 快照（如果 _memory_enabled）                       │
│  USER.md 快照（如果 _user_profile_enabled）                   │
│  外部 memory provider block（如果 _memory_manager 存在）       │
└──────────────────────────────────────────────────────────────┘
┌─ 7. 技能 + 上下文文件 + 环境 ────────────────────────────────┐
│  build_skills_system_prompt()  （技能清单）                    │
│  build_context_files_prompt()  （AGENTS.md/.cursorrules）     │
│  timestamp + session_id + model                               │
│  build_environment_hints()     （WSL/Termux 等）              │
│  PLATFORM_HINTS[platform]      （平台格式提示）                │
└──────────────────────────────────────────────────────────────┘
```

**关键约束**：`ephemeral_system_prompt` 被明确排除在缓存层之外。

```python
# run_agent.py L3423-3424
# Note: ephemeral_system_prompt is NOT included here. It's injected at
# API-call time only so it stays out of the cached/stored system prompt.
```

结果存到 `self._cached_system_prompt`，整个 session 内不重建（除非 context compression 触发）。

### 3.3 临时层：API 调用时拼接

```python
# run_agent.py L8729-8737
effective_system = active_system_prompt or ""          # ← 缓存层
if self.ephemeral_system_prompt:                        # ← 临时层
    effective_system = (effective_system + "\n\n" + self.ephemeral_system_prompt).strip()
# NOTE: Plugin context from pre_llm_call hooks is injected into the
# user message (see injection block above), NOT the system prompt.
# This is intentional — system prompt modifications break the prompt
# cache prefix.  The system prompt is reserved for Hermes internals.
if effective_system:
    api_messages = [{"role": "system", "content": effective_system}] + api_messages
```

注释（L8734-8735）再次强调设计意图："system prompt modifications break the prompt cache prefix. The system prompt is reserved for Hermes internals."

### 3.4 Cron 路径的 System Prompt

cron 完全不走临时层。`run_job()` 创建 AIAgent 时：

- `skip_context_files=True` → 缓存层跳过 SOUL.md、AGENTS.md
- `skip_memory=True` → 缓存层跳过 MEMORY.md、USER.md
- `platform="cron"` → `PLATFORM_HINTS["cron"]` 不存在，无平台格式提示
- **不传 `ephemeral_system_prompt`** → 临时层为空

cron agent 的 system prompt = `DEFAULT_AGENT_IDENTITY` + `tool_guidance` + `timestamp`，极其精简。

---

## 4. Gateway 消息处理流

### 4.1 消息进入：Adapter 层

每个平台 adapter 继承 `BasePlatformAdapter`（`gateway/platforms/base.py` L844），负责：

1. 连接和认证平台
2. 接收消息，解析为统一的 `MessageEvent`
3. 发送回复/媒体

`MessageEvent`（L660-696）是所有 adapter 产出的统一数据结构：

```python
@dataclass
class MessageEvent:
    text: str                                    # 消息文本
    message_type: MessageType = MessageType.TEXT
    source: SessionSource = None                 # 来源信息（platform, chat_id, user_id...）
    raw_message: Any = None                      # 原始平台数据
    message_id: Optional[str] = None
    media_urls: List[str] = field(...)           # 本地文件路径
    media_types: List[str] = field(...)
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None          # 被回复消息的文本
    auto_skill: Optional[str | list[str]] = None # 频道/话题绑定的技能
    channel_prompt: Optional[str] = None         # ← per-channel 临时 prompt
    internal: bool = False                       # 合成事件标志（跳过授权检查）
    timestamp: datetime = field(default_factory=datetime.now)
```

### 4.2 消息处理：GatewayRunner

`GatewayRunner`（`run.py` L539）是 gateway 的核心控制器，管理：

- `self.adapters: Dict[Platform, BasePlatformAdapter]` — 所有已连接的 adapter
- `self.session_store: SessionStore` — 会话持久化
- `self._agent_cache: Dict[str, tuple]` — per-session AIAgent 缓存（保持 prompt cache）
- `self._session_model_overrides` — per-session `/model` 命令覆盖
- `self._ephemeral_system_prompt` — 全局人格 prompt

**消息处理主流程**（`_handle_message` L3455+）：

```
1. 解析 source（SessionSource: platform, chat_id, user_id, chat_type）
2. 获取或创建 session（session_key → session_entry）
3. build_session_context(source, config, session_entry) → SessionContext
4. _set_session_env(context) → 设置 contextvars（并发安全）
5. 读取 privacy.redact_pii 配置
6. build_session_context_prompt(context, redact_pii) → context_prompt
7. 处理 auto-reset notice（如果 session 刚过期）
8. 调用 _run_agent(message, context_prompt, channel_prompt, ...)
```

### 4.3 Agent 执行：run_sync()

`run_sync()`（L8439+）在同步线程中执行：

```
1. combined_ephemeral = context_prompt                    ← ① session context
2. combined_ephemeral += channel_prompt                   ← ② per-channel prompt
3. combined_ephemeral += self._ephemeral_system_prompt    ← ③ 全局人格
4. 重读 .env（热更新凭证）
5. _resolve_session_agent_runtime() → model + runtime_kwargs
6. _resolve_turn_agent_config() → smart routing / fast mode
7. _agent_config_signature() → 签名
8. agent cache hit? → 复用 AIAgent（保持 prompt cache）
   cache miss? → AIAgent(ephemeral_system_prompt=combined_ephemeral, ...)
9. agent.run_conversation(message) → 最终回复
10. 回复通过 adapter.send() 发回用户
```

**Agent 缓存机制**（L8584-8604）：

```python
_sig = self._agent_config_signature(
    turn_route["model"],
    turn_route["runtime"],
    enabled_toolsets,
    combined_ephemeral,    # ← ephemeral 内容影响签名
)
# ...
cached = _cache.get(session_key)
if cached and cached[1] == _sig:
    agent = cached[0]      # 复用，保持 _cached_system_prompt 不变
```

签名包含 `combined_ephemeral`，所以 channel_prompt 变化或人格切换会导致 cache miss。但同一频道内多轮对话，三段 ephemeral 内容不变，签名稳定，cache hit。

---

## 5. Channel Context 注入机制

### 5.1 三段临时内容

gateway 路径的 `ephemeral_system_prompt` 不是单一来源，而是三段拼接（L8461-8466）：

```python
combined_ephemeral = context_prompt or ""                          # ①
event_channel_prompt = (channel_prompt or "").strip()
if event_channel_prompt:
    combined_ephemeral += "\n\n" + event_channel_prompt            # ②
if self._ephemeral_system_prompt:
    combined_ephemeral += "\n\n" + self._ephemeral_system_prompt   # ③
```

### 5.2 ① context_prompt — 会话级上下文

**来源**：`build_session_context_prompt()`（`gateway/session.py` L186），由 `build_session_context()` 生成 `SessionContext` 后构建。

**内容**：
- `**Source:** Telegram (DM with Alice)` — 消息来源描述
- `**Channel Topic:** xxx` — 群组话题（如有）
- `**User:** Alice` 或 "Multi-user thread" — 用户身份
  - 共享线程（非 DM + 有 thread_id）不固定用户名，改为标注"多用户线程"
- 平台行为提示：
  - Slack：无 Slack API 访问权限，不能搜索历史/管理频道
  - Discord：同上
- `**Connected Platforms:** local, telegram: Connected ✓`
- `**Home Channels:**` — 各平台默认投递目标
- `**Delivery options for scheduled tasks:**` — cron 投递选项列表

**PII 脱敏**（L199-206）：当 `redact_pii=True` 且平台在 `_PII_SAFE_PLATFORMS` 中时，手机号和 ID 被替换为确定性哈希。Discord 排除（因为 mention 需要 `<@user_id>` 真实 ID）。

**生命周期**：每条消息重新构建（L3461-3477），因 session 可能因 inactivity reset 变化。auto-reset 时在前面追加 `[System note: ...]`。

### 5.3 ② channel_prompt — 频道级配置

**来源**：`MessageEvent.channel_prompt` 字段（`base.py` L686-688），由每个 adapter 在解析消息时填充。

**解析逻辑**：`resolve_channel_prompt()`（`base.py` L814-841）

```python
def resolve_channel_prompt(config_extra, channel_id, parent_id=None):
    prompts = config_extra.get("channel_prompts") or {}
    for key in (channel_id, parent_id):      # 先精确匹配，再回退到父频道
        if not key:
            continue
        prompt = prompts.get(key)
        if prompt and str(prompt).strip():
            return prompt
    return None
```

**配置位置**：`config.yaml` 中平台配置的 `extra.channel_prompts` 字典：

```yaml
platforms:
  telegram:
    extra:
      channel_prompts:
        "123456789": "你是一个项目管理助手，只回答项目相关问题"
        "-1009876543210": "你是一个技术文档助手"
```

**各平台调用**：
- Telegram（`telegram.py` L2850）：先查 topic/thread ID，回退到 chat ID
- Discord（`discord.py` L2002）：channel_id + parent_id
- Slack（`slack.py` L1171）：channel_id
- Mattermost（`mattermost.py` L722）：channel_id

### 5.4 ③ _ephemeral_system_prompt — 全局人格

**来源**：`GatewayRunner._load_ephemeral_system_prompt()`（`run.py` L1135），从 `HERMES_EPHEMERAL_SYSTEM_PROMPT` 环境变量或 config.yaml 读取。

**运行时修改**：`/personality` 命令（L5061-5077）可清空或切换预设 prompt，立即生效——更新 `self._ephemeral_system_prompt`，下一条消息就用新值。

**作用域**：全局的，不分 channel，所有会话共享。

### 5.5 数据流图

```
消息进入
  │
  ▼
adapter (telegram.py / discord.py / ...)
  ├── 解析消息 → SessionSource (platform, chat_id, user_id, chat_type)
  ├── resolve_channel_prompt(config.extra, channel_id, parent_id) → channel_prompt
  └── 构造 MessageEvent { source, channel_prompt, text, media_urls, auto_skill }
  │
  ▼
GatewayRunner._handle_message (run.py L3455+)
  ├── build_session_context(source, config, session_entry) → SessionContext
  ├── build_session_context_prompt(context, redact_pii) → context_prompt     ← ①
  ├── 处理 auto-reset notice → 追加到 context_prompt
  └── _run_agent(..., channel_prompt=event.channel_prompt)
  │
  ▼
run_sync() (run.py L8461+)
  ├── combined_ephemeral = context_prompt                                    ← ①
  ├── combined_ephemeral += "\n\n" + channel_prompt                          ← ②
  ├── combined_ephemeral += "\n\n" + self._ephemeral_system_prompt           ← ③
  ├── _agent_config_signature(model, runtime, toolsets, combined_ephemeral)
  ├── cache hit? → 复用 AIAgent 实例（保持 _cached_system_prompt 不变）
  └── cache miss? → AIAgent(ephemeral_system_prompt=combined_ephemeral)
  │
  ▼
AIAgent._build_system_prompt()  [一次性，缓存到 _cached_system_prompt]
  └── SOUL.md + memory + skills + context_files + timestamp + platform_hints
      （不含 ephemeral_system_prompt）
  │
  ▼
AIAgent.run_conversation() [每次 API 调用]
  └── effective_system = _cached_system_prompt + "\n\n" + ephemeral_system_prompt
      → {"role": "system", "content": effective_system} + messages
      → LLM API
```

---

## 6. Cron Job 完整业务流

### 6.1 全景

```
用户发消息 "每天早上9点提醒我站会"
  │
  ▼
gateway agent 调 cronjob(action="create", prompt="提醒站会", schedule="0 9 * * *")
  │
  ▼
tools/cronjob_tools.py → cron.jobs.create_job() → 写入 ~/.hermes/cron/jobs.json
  │
  ▼
gateway 后台线程 _start_cron_ticker 每 60s 调一次 tick()
  │
  ▼
tick() → get_due_jobs() → 发现 job 到期
  │
  ▼
advance_next_run(job)   ← 先推进 next_run_at（防崩溃重复执行）
run_job(job)            ← 构建独立 headless AIAgent 执行
  │
  ▼
save_job_output()       ← 保存到 ~/.hermes/cron/output/{job_id}/{timestamp}.md
_deliver_result()       ← 投递到目标平台
mark_job_run()          ← 更新 job 状态、计算下次运行、检查 repeat 限制
```

### 6.2 阶段一：Job 创建（agent → tool → storage）

用户通过 gateway 或 CLI 跟 agent 对话，agent 调用 `cronjob` 工具（`cronjob_tools.py` L221）创建定时任务。

**origin 捕获**（L268 + L71-88）：

```python
job = create_job(
    ...
    origin=_origin_from_env(),   # ← 从 session contextvars 捕获来源
)
```

`_origin_from_env()` 从 session contextvars 读取当前会话的平台、chat_id、thread_id，存到 job 的 `origin` 字段。这是后面 delivery "回到来源频道"能力的基础。

**prompt 安全扫描**（L252-254 + L60-68）：

cron prompt 存入前过 `_scan_cron_prompt()`，检查：
- Invisible unicode（U+200B 零宽空格、U+202E RTL 覆盖等）
- 注入模式（ignore previous instructions、system prompt override 等）
- 数据外泄模式（curl/wget + KEY/TOKEN/SECRET、cat .env 等）
- 持久化后门（authorized_keys、/etc/sudoers、rm -rf /）

因为 cron 是无头执行，有完整工具权限，prompt 注入的破坏力远大于交互式会话。

**schedule 解析**（`jobs.py` L117-203 `parse_schedule()`）：

| 格式 | 类型 | 示例 |
|---|---|---|
| `"30m"` / `"2h"` / `"1d"` | once（从现在算延迟） | 30 分钟后执行一次 |
| `"every 30m"` / `"every 2h"` | interval（周期性） | 每 30 分钟执行 |
| `"0 9 * * *"` | cron（需 croniter） | 每天 9 点 |
| `"2026-02-03T14:00"` | once（指定时间点） | 2026-02-03 14:00 执行一次 |

解析结果为结构化 dict：`{"kind": "once|interval|cron", ...}`

**存储**（`jobs.py` L349-365）：

`save_jobs()` 用 atomic write（tmp file → `os.replace` + `fsync`），写完 chmod 0600。所有 job 存在 `~/.hermes/cron/jobs.json` 一个文件里。

**Job 结构**（`jobs.py` L432-461）：

```python
job = {
    "id": job_id,                    # 12 字符 hex
    "name": name,                    # 友好名称
    "prompt": prompt,                # 执行 prompt
    "skills": normalized_skills,     # 技能列表
    "model": model,                  # per-job model 覆盖
    "provider": provider,            # per-job provider 覆盖
    "base_url": base_url,            # per-job base_url 覆盖
    "script": script,                # 数据采集脚本路径
    "schedule": parsed_schedule,     # {"kind": ..., "display": ...}
    "repeat": {"times": repeat, "completed": 0},  # None=无限
    "enabled": True,
    "state": "scheduled",
    "next_run_at": compute_next_run(parsed_schedule),
    "last_run_at": None,
    "last_status": None,
    "last_error": None,
    "last_delivery_error": None,
    "deliver": deliver,              # "origin" | "local" | "telegram" | "telegram:12345"
    "origin": origin,                # {"platform": ..., "chat_id": ..., "thread_id": ...}
}
```

### 6.3 阶段二：Tick 调度（定时触发）

**触发源**（`run.py` L9773-9783）：

gateway 启动时起一个 daemon 线程：

```python
cron_thread = threading.Thread(
    target=_start_cron_ticker,
    args=(cron_stop,),
    kwargs={"adapters": runner.adapters, "loop": asyncio.get_running_loop()},
    daemon=True,
    name="cron-ticker",
)
```

线程每 60 秒调一次 `tick()`，同时顺带：
- 每 5 分钟刷新 channel directory（L9564-9569）
- 每 60 分钟清理 image/document cache（L9571-9583）

也可独立运行 `hermes cron daemon` 或手动 `hermes cron tick`。

**文件锁**（`scheduler.py` L921-935）：

`tick()` 先抢 `~/.hermes/cron/.tick.lock`（`fcntl.flock` 非阻塞）。抢不到直接返回 0——防止 gateway 内置 ticker 和独立 daemon 同时跑导致 job 重复执行。

**到期检查**（`jobs.py` L664-740 `get_due_jobs()`）：

1. 遍历所有 enabled job，比较 `next_run_at <= now`
2. 对周期性 job（cron/interval），如果过期超过 **grace window**，不执行，直接快进到下一次
3. 对一次性 job（once），如果 `next_run_at` 为空但有 `run_at` 且在 grace 窗口内（120s），恢复执行

**Grace window 计算**（`jobs.py` L252-281 `_compute_grace_seconds()`）：

```python
MIN_GRACE = 120      # 2 分钟
MAX_GRACE = 7200     # 2 小时

# interval: 周期的一半，clamp 到 [120, 7200]
# cron: 用 croniter 算两个连续执行间隔的一半
# 默认: 120s
```

示例：每 10 分钟的 job grace=300s（5 分钟）；每天的 job grace=7200s（2 小时）。

**先推进再执行**（`scheduler.py` L950-954）：

```python
# tick() 内，对每个到期 job：
advance_next_run(job["id"])           # 先推进 next_run_at
success, output, final_response, error = run_job(job)  # 再执行
```

`advance_next_run()`（`jobs.py` L636-661）只对 cron/interval 类型生效，一次性 job 不推进（保留 retry 能力）。

设计意图（L639-644 注释）：

> "Call this BEFORE run_job() so that if the process crashes mid-execution, the job won't re-fire on the next gateway restart. This converts the scheduler from at-least-once to at-most-once for recurring jobs — missing one run is far better than firing dozens of times in a crash loop."

### 6.4 阶段三：Job 执行（独立 headless AIAgent）

`run_job()`（`scheduler.py` L580-904）是最重的一环。

**3a. 构建 prompt**（`_build_job_prompt` L490-577）：

```
[SYSTEM: cron 执行引导]
  "你正在作为定时任务运行。你的最终回复会被自动投递——
   不要自己调 send_message。如果没有新内容，回复 [SILENT] 抑制投递。"
    +
[script 输出]（如果 job 配了 script，先执行数据采集脚本，输出注入 prompt）
    +
[skill 内容]（如果 job 配了 skills，加载完整 SKILL.md 内容）
    +
[prompt]（用户定义的执行指令）
```

**script 执行**（`_run_job_script` L409-487）：

- 脚本必须在 `~/.hermes/scripts/` 目录内（path traversal 防护）
- 用 `subprocess.run` 执行，有超时（默认 120s，可通过 `HERMES_CRON_SCRIPT_TIMEOUT` 或 config.yaml `cron.script_timeout_seconds` 配置）
- stdout/stderr 经过 `redact_sensitive_text()` 脱敏后注入 prompt

**3b. 注入 delivery 上下文到环境变量**（L608-628）：

```python
if origin:
    os.environ["HERMES_SESSION_PLATFORM"] = origin["platform"]
    os.environ["HERMES_SESSION_CHAT_ID"] = str(origin["chat_id"])

delivery_target = _resolve_delivery_target(job)
if delivery_target:
    os.environ["HERMES_CRON_AUTO_DELIVER_PLATFORM"] = delivery_target["platform"]
    os.environ["HERMES_CRON_AUTO_DELIVER_CHAT_ID"] = str(delivery_target["chat_id"])
    if delivery_target.get("thread_id"):
        os.environ["HERMES_CRON_AUTO_DELIVER_THREAD_ID"] = str(delivery_target["thread_id"])
```

这些环境变量的用途：
- 让 agent 的 `send_message` 工具知道当前会话的来源频道
- 让 `send_message` 检测"重复投递"——如果 agent 试图往同一目标发消息，`_maybe_skip_cron_duplicate_send()`（`send_message_tool.py` L290-318）会拦截

**3c. 创建 headless AIAgent**（L736-760）：

```python
agent = AIAgent(
    model=turn_route["model"],
    **turn_route["runtime"],
    max_iterations=max_iterations,
    reasoning_config=reasoning_config,
    prefill_messages=prefill_messages,
    fallback_model=fallback_model,
    credential_pool=credential_pool,
    disabled_toolsets=["cronjob", "messaging", "clarify"],
    quiet_mode=True,
    skip_context_files=True,   # 不注入 SOUL.md/AGENTS.md
    skip_memory=True,          # 不注入/不写入 user memory
    platform="cron",
    session_id=_cron_session_id,
    session_db=_session_db,
)
```

**3d. 线程池 + 不活跃超时**（L770-809）：

agent 跑在单线程线程池里，主线程每 5 秒轮询。如果 agent 不活跃超过 `HERMES_CRON_TIMEOUT`（默认 600s = 10 分钟），强制 `agent.interrupt()` 并 raise `TimeoutError`。

这是**不活跃超时**，不是总时长限制——只要 agent 在持续调工具/收到 stream token，就可以一直跑。

**3e. 清理**（L884-903）：

`finally` 块删除所有注入的环境变量（防泄漏到其他 job），关闭 session DB。

### 6.5 阶段四：投递

**投递决策**（`tick()` L962-977）：

```python
deliver_content = final_response if success else f"⚠️ Cron job failed:\n{error}"
should_deliver = bool(deliver_content)
if should_deliver and success and SILENT_MARKER in deliver_content.strip().upper():
    should_deliver = False  # agent 说了 [SILENT]，跳过投递
if should_deliver:
    delivery_error = _deliver_result(job, deliver_content, adapters=adapters, loop=loop)
```

**投递目标解析**（`_resolve_delivery_target` L79-160）：

三种模式：
- `deliver="local"` → 不投递，只存文件
- `deliver="origin"` → 投递到 job 创建时的来源频道
  - origin 缺失时（如 API 创建），fallback 到各平台 home channel（L96-108）
- `deliver="telegram"` → 投递到 Telegram home channel
- `deliver="telegram:12345"` → 投递到指定 chat_id
  - 支持人类可读名称解析（如 "Alice (dm)"），通过 `channel_directory.resolve_channel_name()`

**投递路径**（`_deliver_result` L201-368）：

```
                    ┌─ 优先：Live Adapter 路径 ──────────────────┐
                    │  条件：gateway 在运行（adapters + loop 都有） │
                    │  优势：支持 E2EE（如 Matrix 加密房间）         │
                    │  方式：asyncio.run_coroutine_threadsafe(     │
                    │         adapter.send(chat_id, text))          │
                    │  media：路由到 send_voice/send_image_file/    │
                    │         send_video/send_document              │
                    └────────────────┬──────────────────────────────┘
                                     │ 失败/不可用
                                     ▼
                    ┌─ Fallback：Standalone Send 路径 ───────────┐
                    │  方式：_send_to_platform() 在新 event loop   │
                    │  如果当前线程有 running loop，起临时线程池跑   │
                    │  不支持 E2EE                                  │
                    └──────────────────────────────────────────────┘
```

**内容包装**（L283-301）：

默认包装 cron 响应（可通过 `cron.wrap_response: false` 关闭）：

```
Cronjob Response: {task_name}
(job_id: {job_id})
-------------

{content}

To stop or manage this job, send me a new message (e.g. "stop reminder {task_name}").
```

**Media 提取**（L304-305）：

从 content 里提取 `MEDIA:` 标签，文本部分用 `send()` 发，文件部分路由到 adapter 的对应方法。

### 6.6 阶段五：状态更新

`mark_job_run()`（`jobs.py` L586-631）：

1. 更新 `last_run_at`、`last_status`（ok/error）、`last_error`、`last_delivery_error`
2. 递增 `repeat.completed`
3. 如果 `completed >= times` → **直接删除 job**（L614-618）
4. 否则 `compute_next_run()` 算下次运行时间
5. 如果没有下次了（一次性 job 跑完）→ `enabled=False, state="completed"`

`last_delivery_error` 与 `last_error` 分开跟踪——一个 job 可以成功执行（agent 产出输出）但投递失败（平台宕机）。

### 6.7 Schedule 计算

**`compute_next_run()`**（`jobs.py` L284-313）：

| kind | 逻辑 |
|---|---|
| once | 如果未运行过且在 grace 窗口内，返回 `run_at`；否则 None |
| interval | `last_run_at + interval`（首次为 `now + interval`） |
| cron | `croniter.get_next()` |

**`_ensure_aware()`**（L206-222）：处理时区——旧数据可能是 naive timestamp，按系统本地时区解释后转换到 Hermes 配置时区。保证跨时区变更后排序正确。

---

## 7. 跨模块关联性矩阵

| 交互点 | Cron 侧 | 对端模块 | 关系说明 |
|---|---|---|---|
| Job 创建 | `cronjob_tools.py` | `gateway/run.py` agent | agent 通过工具调用创建，origin 从 session contextvars 捕获 |
| 定时触发 | `scheduler.py tick()` | `gateway/run.py _start_cron_ticker` | gateway 起后台线程，传 adapters + loop 给 cron |
| Agent 执行 | `scheduler.py run_job()` | `run_agent.py AIAgent` | 创建独立 headless agent，跳过 memory/context_files |
| System prompt | 无 ephemeral | `agent/prompt_builder.py` | 只用 DEFAULT_AGENT_IDENTITY + tool_guidance |
| 消息投递 | `_deliver_result()` | `gateway/platforms/*.py` adapters | 优先 live adapter，fallback standalone send |
| 重复投递防护 | env var `HERMES_CRON_AUTO_DELIVER_*` | `tools/send_message_tool.py` | agent 调 send_message 时检测同目标，拦截 |
| 配置加载 | 自己读 config.yaml | `hermes_cli/config.py` | 独立路径，不复用 gateway 的 config 对象 |
| Session 隔离 | `skip_memory=True` | `tools/memory_tool.py` | 不读不写 user memory，防污染 |
| Channel directory | 无直接交互 | `gateway/channel_directory.py` | cron ticker 线程顺带刷新（L9564-9569） |
| Session reset | `cron_` 前缀跳过 | `gateway/run.py _flush_memories` | cron session 不触发 memory flush（L740-742） |
| Channel prompt | 无 | `gateway/platforms/base.py` | cron 不经过 adapter，无 channel_prompt |
| Context prompt | 无 | `gateway/session.py` | cron 不构建 SessionContext，无 context_prompt |
| 人格 prompt | 无 | `gateway/run.py _ephemeral_system_prompt` | cron 不传 ephemeral_system_prompt |

---

## 8. 关键设计决策与 trade-off

### 8.1 Prompt Cache 稳定性 vs 配置热更新

**决策**：每条消息重读 .env，允许热更新凭证。

**代价**：如果 .env 变更影响 system prompt 内容（如 model 名变化导致不同 guidance 注入），agent cache miss → 重建 system prompt → Anthropic cache break。

**理由**：gateway 是长驻进程，不重启换 key 是刚需。cache break 是偶发代价，热更新是持续收益。

### 8.2 Cron at-most-once vs at-least-once

**决策**：周期性 job 先推进 `next_run_at` 再执行（at-most-once）。

**代价**：如果 `run_job()` 崩溃，这次运行永久丢失。

**理由**：at-least-once 在崩溃恢复后会触发大量积压 job（crash loop），at-most-once 最多丢一次。注释原文："missing one run is far better than firing dozens of times in a crash loop."

一次性 job 例外——不推进，保留 retry 能力，因为一次性 job 丢了就没了。

### 8.3 Cron Agent 隔离 vs 复用

**决策**：cron 每次创建独立 headless agent，不复用 gateway 的 agent cache，不共享 memory。

**代价**：每次 `run_job` 从零构建 agent，system prompt 不缓存，token 开销更大。

**理由**：
- cron 是无头执行，不应受用户会话状态影响
- cron 不应往 user memory 写东西（"Cron system prompts would corrupt user representations"）
- cron 需要独立运行能力（`hermes cron daemon`），不能依赖 gateway 上下文
- cron 的 disabled_toolsets 与 gateway 不同（禁用 cronjob/messaging/clarify）

### 8.4 临时层不进缓存层

**决策**：`ephemeral_system_prompt` 在 API 调用时拼接，不进 `_cached_system_prompt`。

**代价**：每次 API 调用多一次字符串拼接。

**理由**：临时层内容可能每条消息变化（channel_prompt、context_prompt），如果进缓存层会导致频繁重建。分离后，缓存层前缀稳定 → Anthropic cache hit；临时层变化只影响 cache miss 的尾部。

### 8.5 Grace Window 快进策略

**决策**：周期性 job 过期超过 grace window 时不补执行，直接快进到下一次。

**代价**：gateway 宕机期间的所有错过的执行都不补。

**理由**：防止 gateway 重启后一次性触发大量积压 job。grace 按周期的一半计算（daily=2h, hourly=30m, 10min=5m），平衡了"偶尔迟到"和"大量积压"两个极端。

### 8.6 Live Adapter 优先投递

**决策**：cron 投递优先用 gateway 的 live adapter，失败再 fallback 到 standalone send。

**代价**：cron 依赖 gateway 运行才能用 live adapter。独立 daemon 模式只能用 standalone。

**理由**：live adapter 支持 E2EE（如 Matrix 加密房间），standalone HTTP 路径做不到。gateway 是最常见的运行模式，优先保证这条路径的完整性。

---

## 附录：关键文件索引

| 文件 | 行数 | 核心内容 |
|---|---|---|
| `gateway/run.py` | 9851 | GatewayRunner 类，消息处理，agent 缓存，cron ticker |
| `gateway/config.py` | 1179 | GatewayConfig, Platform enum, SessionResetPolicy |
| `gateway/session.py` | 1091 | SessionStore, build_session_context_prompt() |
| `gateway/platforms/base.py` | 2165 | BasePlatformAdapter, MessageEvent, resolve_channel_prompt() |
| `run_agent.py` | 11647 | AIAgent 类, _build_system_prompt(), run_conversation() |
| `agent/prompt_builder.py` | 1046 | DEFAULT_AGENT_IDENTITY, context file scanning, skills manifest |
| `cron/scheduler.py` | 1000 | tick(), run_job(), _deliver_result(), _build_job_prompt() |
| `cron/jobs.py` | 769 | create_job(), get_due_jobs(), mark_job_run(), compute_next_run() |
| `tools/cronjob_tools.py` | 511 | cronjob() 工具, prompt 安全扫描, origin 捕获 |
| `tools/send_message_tool.py` | 1259 | _send_to_platform(), cron 重复投递防护 |
| `hermes_cli/env_loader.py` | 124 | load_hermes_dotenv(), 凭证脱敏 |
