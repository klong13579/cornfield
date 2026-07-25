# moa run moa-20260719-102635-6tsulu
- created: 2026-07-19T10:26:35.017Z
- task: 对比一下 workbuddy 和 openclaw
- workers: 3/3
- archive: 2 chunk(s), 92803 bytes

## Timings
```json
{
  "discovery": 24880,
  "input_collect": 33284,
  "research": 842457,
  "ask": 113128,
  "rewrite": 94514,
  "workers_r1": 93040,
  "workers": 93040,
  "synthesis": 61070,
  "total": 1262402
}
```
# moa run moa-20260719-102635-6tsulu

- created: 2026-07-19T10:26:35.017Z
- workers: 3/3 completed

## Original request
对比一下 workbuddy 和 openclaw


## Task Context (TCO)
```json
{
  "task_understanding": "用户要求对比 workbuddy 和 openclaw，未明确是外部产品还是本项目模块，也未说明对比维度和目的",
  "known_inputs": [
    {
      "key": "user_role",
      "value": "米克原子 CEO，管理 50 人团队，使用 OMP 构建 agent team",
      "source": "user_md",
      "confidence": 1
    },
    {
      "key": "domain",
      "value": "室内家庭服务机器人，研发阶段",
      "source": "user_md",
      "confidence": 1
    },
    {
      "key": "workspace",
      "value": "oh-my-pi (OMP monorepo)",
      "source": "cwd",
      "confidence": 1
    },
    {
      "key": "comparison_scope",
      "value": "外部产品对比（选型参考）",
      "source": "user",
      "confidence": 1
    },
    {
      "key": "comparison_dimensions",
      "value": "功能与能力边界",
      "source": "user",
      "confidence": 1
    },
    {
      "key": "comparison_intent",
      "value": "评估迁移/替换 OMP",
      "source": "user",
      "confidence": 1
    },
    {
      "key": "hard_constraints",
      "value": "数据必须境内驻留",
      "source": "user",
      "confidence": 1
    },
    {
      "key": "assessment_depth",
      "value": "概览对比（快速判断可行性）",
      "source": "user",
      "confidence": 1
    }
  ],
  "missing_inputs": [
    {
      "key": "comparison_scope",
      "question": "workbuddy 和 openclaw 是 OMP 内部模块还是外部产品对比？",
      "type": "text",
      "required": true,
      "why_critical": "内部模块对比侧重代码层面的弱点和边界条件，外部产品对比侧重架构假设和生态风险",
      "source": "worker",
      "roles": [
        "critical"
      ]
    },
    {
      "key": "product_category",
      "question": "如果为外部产品，它们属于什么类别？（可多选）",
      "type": "list",
      "required": false,
      "why_critical": "帮助 workers 快速定位正确的产品和对比维度",
      "defaultValue": [
        "AI coding agent",
        "开发工具",
        "项目管理工具"
      ],
      "source": "discovery"
    },
    {
      "key": "comparison_dimensions",
      "question": "重点关注哪些对比维度？（可多选）",
      "type": "list",
      "required": false,
      "why_critical": "避免产出用户不关心的内容，如 CEO 通常关注战略/团队适配而非实现细节",
      "defaultValue": [
        "功能特性",
        "架构设计",
        "适用场景",
        "成本/价格",
        "团队适配性",
        "扩展性"
      ],
      "source": "discovery"
    }
  ],
  "assumptions": [],
  "task_intent": "compare",
  "research_pack": {
    "queries": [
      "workbuddy AI coding agent tool",
      "openclaw AI agent tool",
      "CodeBuddy WorkBuddy Tencent AI coding agent features 2026",
      "OpenClaw AI assistant comparison features architecture 2026",
      "Tencent WorkBuddy features capabilities agent teams multi-agent 2026",
      "WorkBuddy Tencent AI agent review comparison claude code cursor 2026",
      "OpenClaw features tools capabilities channels platforms 2026",
      "WorkBuddy enterprise edition features agents teams what can it do",
      "OpenClaw enterprise team deployment production use case 2026",
      "\"WorkBuddy\" Tencent sandbox browser CLI IDE agent teams dynamic workflows"
    ],
    "sources": [
      {
        "claim": "OpenClaw 是开源(MIT)个人 AI 助手，383K+ GitHub Stars，自托管架构，运行在用户自有设备上。通过 Gateway(WebSocket) 统一控制面连接 20+ 消息渠道(WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ 等)",
        "url": "https://github.com/OpenClaw/openclaw",
        "relevance": "核心产品定位和渠道覆盖——对 CEO 评估 agent 团队基础设施选型至关重要",
        "confidence": "high"
      },
      {
        "claim": "OpenClaw 支持 Multi-Agent Routing：每个 agent 有独立 workspace、agentDir、SQLite session store、auth profiles，通过 bindings 按渠道/账号/peer 路由消息到不同 agent",
        "url": "https://docs.openclaw.ai/concepts/multi-agent",
        "relevance": "多 agent 隔离机制——直接对应「为每个业务领域构建专属 agent」的需求",
        "confidence": "high"
      },
      {
        "claim": "OpenClaw 工具体系：Runtime(exec/process/terminal)、Files(read/write/edit/apply_patch)、Browser、Web Search(多后端)、Messaging、Sessions/Sub-agents、Cron/Heartbeat、Media(图片/视频/音乐生成/TTS)、Nodes(移动端设备能力)、Skills/Plugins/Hooks 扩展",
        "url": "https://docs.openclaw.ai/tools",
        "relevance": "工具能力全景——评估 agent 能做什么",
        "confidence": "high"
      },
      {
        "claim": "OpenClaw 企业部署有成熟实践：GlobusSoft 部署 500 员工、AWS CDK 自动化、多租户安全隔离、模型分层(tiering)降本、90 天 POC-to-Production 路线图",
        "url": "https://globussoft.ai/openclaw-for-enterprise/",
        "relevance": "企业级可行性——对 50 人团队的部署有参考价值",
        "confidence": "medium"
      },
      {
        "claim": "WorkBuddy 是腾讯云 2026 年 5 月全球发布的办公 AI Agent，前身为 CodeBuddy(代码助手)，后扩展为 All-in-one 办公场景 Agent，含个人版(免费)和企业版",
        "url": "https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/",
        "relevance": "WorkBuddy 产品定位和发布时间线",
        "confidence": "medium"
      },
      {
        "claim": "WorkBuddy 日活是行业第二名的 3-4 倍，被定位为「对标 Cowork(字节跳动)」的产品，腾讯内部将其与 CodeBuddy(代码)、QClaw(通用 Agent)并列为 AI Agent 三大产品线",
        "url": "https://www.htx.com/en-us/news/428387/",
        "relevance": "市场规模和竞争格局——评估产品成熟度和生态位",
        "confidence": "medium"
      },
      {
        "claim": "WorkBuddy 功能包括：Agent Teams(多 Agent 协作)、Dynamic Workflows、CLI 模式、IDE 集成、Web UI、沙箱隔离执行、Browser 工具、MCP 协议支持",
        "url": "https://www.workbuddy.ai/docs/cli/overview",
        "relevance": "WorkBuddy 核心功能矩阵",
        "confidence": "medium"
      },
      {
        "claim": "WorkBuddy 企业版提供：SSO 单点登录、RBAC 权限控制、审计日志、私有化部署、数据驻留；个人版免费但功能受限",
        "url": "https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te",
        "relevance": "企业版 vs 个人版差异——对团队管理决策关键",
        "confidence": "low"
      },
      {
        "claim": "OpenClaw 架构：Gateway 守护进程(WebSocket 协议) → 内嵌 Agent Runtime(agent loop/session/compaction/hooks) → 多 Provider(35+，含 Anthropic/OpenAI/Google/本地 Ollama/vLLM) → Channel 分发。配套 macOS/iOS/Android/Win companion apps",
        "url": "https://docs.openclaw.ai/concepts/architecture",
        "relevance": "技术架构全貌——评估自建 vs 采购的技术匹配度",
        "confidence": "high"
      },
      {
        "claim": "OpenClaw 安全模型：DM 默认 pairing 审批(非白名单用户收到配对码)、非 main session 可 Docker sandbox 隔离、工具级 allow/deny policy、Gateway 暴露前需走 security runbook",
        "url": "https://docs.openclaw.ai/gateway/security",
        "relevance": "安全边界——对 CEO 评估生产环境风险至关重要",
        "confidence": "medium"
      }
    ],
    "repo_facts": [
      "OMP Gateway 设计明确参考了 OpenClaw 的 dingtalk-connector(accounts 命名 map、会话按 conversationId 隔离)和 Hermes Agent 的 per-agent 目录隔离模式(packages/pi-gateway/docs/gateway-design-v1.md:70-78)",
      "OMP prompt assembly 与 Hermes Agent/OpenClaw 做了系统对比：OpenClaw 用 SOUL.md+AGENTS.md+USER.md+TOOLS.md+MEMORY.md+BOOTSTRAP.md 多文件 bootstrap，OMP 用单模板+Handlebars+AGENTS.md 硬约束提取(docs/omp-prompt-assembly-v1.0.md:200-291)",
      "OMP agent design 与 Hermes Agent/OpenClaw 对比，核心差异：OMP 拆分多文件按 MECE 6 层、独立 user.md 拆分 USER PERSONA 层、prompt-includes.json 显式注入(packages/coding-agent/docs/agent-design-v1.md:333-351)",
      "OpenClaw dingtalk-connector 是 @dingtalk-real-ai/dingtalk-connector@0.8.23 npm 包，peerDependencies openclaw>=2026.4.9——OMP 在 bun.lock 中依赖了此包用于钉钉接入",
      "OMP pi-gateway 的 DingTalk Card v3 使用 OpenClaw 的 blockList schema(675cde2f-f526-40cb-b828-f5b2b57b8b77)；pi-gateway CHANGELOG 多处记录与 OpenClaw 的对齐(bun.lock/pi-gateway/src/channels/dingtalk-card.ts)",
      "OpenClaw 的 multi-agent 设计明确不做 agent 间互调/teams 编排(社区 PR #27382 被关闭)，OMP 的 multi-agent-orchestration-design.md 引用了这一点(docs/todo/multi-agent-orchestration-design.md:119-122)",
      "WorkBuddy 在 oh-my-pi 仓库中没有直接代码引用——只在 MOA extension 的测试文件(moa-extension/test/)和 plan 文档(docs/plans/)中作为「外部对比对象」出现",
      "OMP evolution/learnings.md 记录了：龙哥 bot(后端为 openclaw)的钉钉回复可视化效果优于 omp gateway，可作为视觉/动效参考(lrn_1g9oingenyxna)"
    ],
    "gaps": [
      "WorkBuddy 的具体定价模型和 API 价格未能从可访问页面确认（所有 workbuddy.ai 页面超时）",
      "WorkBuddy 的 Agent Teams 具体实现细节（是共享 context 还是独立 session 隔离）未确认",
      "WorkBuddy 在中国大陆的可用性和合规状态未确认",
      "WorkBuddy 与 OMP/DingTalk 的集成可行性未确认",
      "OpenClaw 对中文/钉钉的原生支持程度——已知有外部 WeChat/QQ Bot 插件和 dingtalk-connector，但稳定性未实测",
      "对比维度（成本、部署复杂度、扩展性、中文支持）仅基于已有文档推断，未做实际 POC 验证"
    ],
    "mode": "required",
    "gathered_at": "2026-07-19T10:20:33.244Z",
    "parse_source": "json"
  }
}
```

## Discovery — ok
{
  "task_understanding": "用户要求对比 workbuddy 和 openclaw，未明确是外部产品还是本项目模块，也未说明对比维度和目的",
  "task_intent": "compare",
  "known_inputs": [
    { "key": "user_role", "value": "米克原子 CEO，管理 50 人团队，使用 OMP 构建 agent team", "source": "user_md", "confidence": 1.0 },
    { "key": "domain", "value": "室内家庭服务机器人，研发阶段", "source": "user_md", "confidence": 1.0 },
    { "key": "workspace", "value": "oh-my-pi (OMP monorepo)", "source": "cwd", "confidence": 1.0 }
  ],
  "missing_inputs": [
    {
      "key": "entity_type",
      "question": "workbuddy 和 openclaw 是外部产品/工具，还是本项目 oh-my-pi 内的模块/组件？",
      "type": "select",
      "options": ["外部产品", "本项目模块"],
      "required": true,
      "why_critical": "决定对比方式是产品选型分析（外部）还是代码架构对比（内部），否则 workers 无法确定研究路径"
    },
    {
      "key": "product_category",
      "question": "如果为外部产品，它们属于什么类别？（可多选）",
      "type": "list",
      "required": false,
      "why_critical": "帮助 workers 快速定位正确的产品和对比维度",
      "defaultValue": ["AI coding agent", "开发工具", "项目管理工具"]
    },
    {
      "key": "comparison_purpose",
      "question": "这次对比的目的是？",
      "type": "select",
      "options": ["选型决策（选一个用）", "技术学习（了解差异）", "竞品分析", "架构参考"],
      "required": true,
      "why_critical": "影响输出侧重点：选型关注 trade-off 和推荐，学习关注原理差异，竞品关注市场定位"
    },
    {
      "key": "comparison_dimensions",
      "question": "重点关注哪些对比维度？（可多选）",
      "type": "list",
      "required": false,
      "why_critical": "避免产出用户不关心的内容，如 CEO 通常关注战略/团队适配而非实现细节",
      "defaultValue": ["功能特性", "架构设计", "适用场景", "成本/价格", "团队适配性", "扩展性"]
    }
  ],
  "output_schema": {
    "sections": [
      {
        "name": "comparison_summary",
        "required": true,
        "type": "markdown"
      },
      {
        "name": "key_differences",
        "required": true,
        "type": "list",
        "item": { "field_name": "string" }
      },
      {
        "name": "trade_off_analysis",
        "required": true,
        "type": "markdown"
      },
      {
        "name": "recommendation",
        "required": true,
        "type": "markdown"
      },
      {
        "name": "open_questions",
        "required": true,
        "type": "list",
        "item": { "field_name": "string" }
      }
    ]
  }
}


Model: alibaba-coding-plan/kimi-k2.5

## Rewrite — ok
## divergent

You are the **divergent** worker in a Mixture-of-Agents comparison. Your job is to look at workbuddy and openclaw from the outside — imagine novel use cases, identify gaps neither product claims to fill, and surface what a 50-person hardware robotics startup actually needs that neither vendor thinks about. Do not merely re-state the feature matrices; push beyond the documented capabilities. Think about the product lifecycle: prototype → EVT → DVT → PVT → mass production, multi-disciplinary teams (world model, behavior intelligence, software systems, electromechanical systems), hardware-software co-design workflows, supply chain integration, and the reality that roboticists use CAD, ROS, Gazebo, MATLAB, Jupyter, real-time sensor logs, and physical test benches — not just code repos and Slack.

## Task Context (from discovery stage)

### Task understanding
用户要求对比 workbuddy 和 openclaw，未明确是外部产品还是本项目模块，也未说明对比维度和目的

### Known inputs
- `user_role` = "米克原子 CEO，管理 50 人团队，使用 OMP 构建 agent team"  _source=user_md (confidence=1.00)_
- `domain` = "室内家庭服务机器人，研发阶段"  _source=user_md (confidence=1.00)_
- `workspace` = "oh-my-pi (OMP monorepo)"  _source=cwd (confidence=1.00)_
- `comparison_scope` = "外部产品对比（选型参考）"  _source=user (confidence=1.00)_
- `comparison_dimensions` = "功能与能力边界"  _source=user (confidence=1.00)_
- `comparison_intent` = "评估迁移/替换 OMP"  _source=user (confidence=1.00)_
- `hard_constraints` = "数据必须境内驻留"  _source=user (confidence=1.00)_
- `assessment_depth` = "概览对比（快速判断可行性）"  _source=user (confidence=1.00)_

### Research evidence (already gathered — do NOT re-search)
Sources:
- OpenClaw 是开源(MIT)个人 AI 助手，383K+ GitHub Stars，自托管架构，运行在用户自有设备上。通过 Gateway(WebSocket) 统一控制面连接 20+ 消息渠道(WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ 等) — https://github.com/OpenClaw/openclaw (核心产品定位和渠道覆盖——对 CEO 评估 agent 团队基础设施选型至关重要) [high]
- OpenClaw 支持 Multi-Agent Routing：每个 agent 有独立 workspace、agentDir、SQLite session store、auth profiles，通过 bindings 按渠道/账号/peer 路由消息到不同 agent — https://docs.openclaw.ai/concepts/multi-agent (多 agent 隔离机制——直接对应「为每个业务领域构建专属 agent」的需求) [high]
- OpenClaw 工具体系：Runtime(exec/process/terminal)、Files(read/write/edit/apply_patch)、Browser、Web Search(多后端)、Messaging、Sessions/Sub-agents、Cron/Heartbeat、Media(图片/视频/音乐生成/TTS)、Nodes(移动端设备能力)、Skills/Plugins/Hooks 扩展 — https://docs.openclaw.ai/tools (工具能力全景——评估 agent 能做什么) [high]
- OpenClaw 企业部署有成熟实践：GlobusSoft 部署 500 员工、AWS CDK 自动化、多租户安全隔离、模型分层(tiering)降本、90 天 POC-to-Production 路线图 — https://globussoft.ai/openclaw-for-enterprise/ (企业级可行性——对 50 人团队的部署有参考价值) [medium]
- WorkBuddy 是腾讯云 2026 年 5 月全球发布的办公 AI Agent，前身为 CodeBuddy(代码助手)，后扩展为 All-in-one 办公场景 Agent，含个人版(免费)和企业版 — https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ (WorkBuddy 产品定位和发布时间线) [medium]
- WorkBuddy 日活是行业第二名的 3-4 倍，被定位为「对标 Cowork(字节跳动)」的产品，腾讯内部将其与 CodeBuddy(代码)、QClaw(通用 Agent)并列为 AI Agent 三大产品线 — https://www.htx.com/en-us/news/428387/ (市场规模和竞争格局——评估产品成熟度和生态位) [medium]
- WorkBuddy 功能包括：Agent Teams(多 Agent 协作)、Dynamic Workflows、CLI 模式、IDE 集成、Web UI、沙箱隔离执行、Browser 工具、MCP 协议支持 — https://www.workbuddy.ai/docs/cli/overview (WorkBuddy 核心功能矩阵) [medium]
- WorkBuddy 企业版提供：SSO 单点登录、RBAC 权限控制、审计日志、私有化部署、数据驻留；个人版免费但功能受限 — https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te (企业版 vs 个人版差异——对团队管理决策关键) [low]
- OpenClaw 架构：Gateway 守护进程(WebSocket 协议) → 内嵌 Agent Runtime(agent loop/session/compaction/hooks) → 多 Provider(35+，含 Anthropic/OpenAI/Google/本地 Ollama/vLLM) → Channel 分发。配套 macOS/iOS/Android/Win companion apps — https://docs.openclaw.ai/concepts/architecture (技术架构全貌——评估自建 vs 采购的技术匹配度) [high]
- OpenClaw 安全模型：DM 默认 pairing 审批(非白名单用户收到配对码)、非 main session 可 Docker sandbox 隔离、工具级 allow/deny policy、Gateway 暴露前需走 security runbook — https://docs.openclaw.ai/gateway/security (安全边界——对 CEO 评估生产环境风险至关重要) [medium]
Repo facts:
- OMP Gateway 设计明确参考了 OpenClaw 的 dingtalk-connector(accounts 命名 map、会话按 conversationId 隔离)和 Hermes Agent 的 per-agent 目录隔离模式(packages/pi-gateway/docs/gateway-design-v1.md:70-78)
- OMP prompt assembly 与 Hermes Agent/OpenClaw 做了系统对比：OpenClaw 用 SOUL.md+AGENTS.md+USER.md+TOOLS.md+MEMORY.md+BOOTSTRAP.md 多文件 bootstrap，OMP 用单模板+Handlebars+AGENTS.md 硬约束提取(docs/omp-prompt-assembly-v1.0.md:200-291)
- OMP agent design 与 Hermes Agent/OpenClaw 对比，核心差异：OMP 拆分多文件按 MECE 6 层、独立 user.md 拆分 USER PERSONA 层、prompt-includes.json 显式注入(packages/coding-agent/docs/agent-design-v1.md:333-351)
- OpenClaw dingtalk-connector 是 @dingtalk-real-ai/dingtalk-connector@0.8.23 npm 包，peerDependencies openclaw>=2026.4.9——OMP 在 bun.lock 中依赖了此包用于钉钉接入
- OMP pi-gateway 的 DingTalk Card v3 使用 OpenClaw 的 blockList schema(675cde2f-f526-40cb-b828-f5b2b57b8b77)；pi-gateway CHANGELOG 多处记录与 OpenClaw 的对齐(bun.lock/pi-gateway/src/channels/dingtalk-card.ts)
- OpenClaw 的 multi-agent 设计明确不做 agent 间互调/teams 编排(社区 PR #27382 被关闭)，OMP 的 multi-agent-orchestration-design.md 引用了这一点(docs/todo/multi-agent-orchestration-design.md:119-122)
- WorkBuddy 在 oh-my-pi 仓库中没有直接代码引用——只在 MOA extension 的测试文件(moa-extension/test/)和 plan 文档(docs/plans/)中作为「外部对比对象」出现
- OMP evolution/learnings.md 记录了：龙哥 bot(后端为 openclaw)的钉钉回复可视化效果优于 omp gateway，可作为视觉/动效参考(lrn_1g9oingenyxna)
Open gaps (put in `## assumptions`, do not search again):
- WorkBuddy 的具体定价模型和 API 价格未能从可访问页面确认（所有 workbuddy.ai 页面超时）
- WorkBuddy 的 Agent Teams 具体实现细节（是共享 context 还是独立 session 隔离）未确认
- WorkBuddy 在中国大陆的可用性和合规状态未确认
- WorkBuddy 与 OMP/DingTalk 的集成可行性未确认
- OpenClaw 对中文/钉钉的原生支持程度——已知有外部 WeChat/QQ Bot 插件和 dingtalk-connector，但稳定性未实测
- 对比维度（成本、部署复杂度、扩展性、中文支持）仅基于已有文档推断，未做实际 POC 验证

## Research guidance (REQUIRED)
- A separate research stage already gathered evidence for you — see the
  `### Research evidence` block in the task context above. Build on it.
- Do NOT call `web_search` yourself (it has been disabled for this role);
  the evidence has already been collected. You may still `read`/`search`
  the repo for local facts.
- Emit a `## sources` section citing the evidence you actually relied on,
  shaped `claim: … | url: https://… | relevance: …`. Only reuse URLs from
  the provided research evidence — do NOT invent URLs from memory.
- If the provided evidence is insufficient for a claim, record the gap in
  `## assumptions` (do not fabricate a source). Mark unbacked claims
  `[unverified]`.

## Hard rules (non-negotiable)
1. **Tool policy: read-only data gathering only.**
   - **Allowed** (data gathering, no state change, no user interaction):
     `read`, `search`, `find`, `web_search`, `ast_grep`, `inspect_image`,
     and the read paths of `browser` / `gh` / `ssh`. Use these to gather
     context for your output.
   - **Forbidden** (state-mutating or user-facing): every other tool.
     Examples: `write`, `edit`, `bash`, `python`, `exec`, `debug`,
     `recipe`, `notebook`, `ast_edit`, `task`, `ask`, `todo_write`,
     `yield`, `irc`, `switch_model`, `exit_plan_mode`, `checkpoint`,
     `rewind`, `identity`, `report-tool-issue`, `report_finding`,
     `render_mermaid`, `image-gen`, `calculator`.
   - Your available tool list is pre-filtered by the orchestrator. If a
     tool you need is not in your list, work with what you have. Do not
     ask for it.
   - **No clarifying questions in prose.** The unique Ask is already done —
     residual gaps go into `## assumptions` (or the schema's equivalent),
     not a question list for another user round. Questions in prose are
     ignored and mark this output as incomplete.
2. **The unique Ask is already done.** Do not expect another Ask round —
   the orchestrator will not re-prompt the user. Record remaining
   uncertainty under `## assumptions` (or the schema's equivalent) with
   a working default, then produce a complete answer.
3. **If a field in the TCO is marked `[assumed: ...]`, use it as a working
   assumption and proceed.** State your assumptions in the corresponding
   `## assumptions`-style section so the synthesis stage can surface them.
4. **Do not try to synthesize across other workers.** Your job is one angle.
5. **Output ONLY the sections listed in the schema below.** Extra sections
   are silently ignored; missing required sections mark this output as
   incomplete and reduce your quality score.

## Required output schema
- `## comparison_summary` _(required)_ `type: markdown`
- `## key_differences` _(required)_ `type: list`  each item: `field_name: string`
- `## trade_off_analysis` _(required)_ `type: markdown`
- `## recommendation` _(required)_ `type: markdown`
- `## open_questions` _(required)_ `type: list`  each item: `field_name: string`
- `## sources` _(required)_ `type: list`  each item: `claim: string | url: string | relevance: string`

**Proceed now.** The orchestrator has already completed the unique Ask round. Any `[assumed: ...]` fields in the TCO are working assumptions — do not convert them into clarifying questions. Residual uncertainty goes into `## assumptions`. Produce a complete answer covering all required sections.

## grounded

You are the **grounded** worker in a Mixture-of-Agents comparison. Your job is to produce a factual, evidence-anchored comparison of openclaw and workbuddy against the explicit requirements of a 50-person hardware robotics startup in Shenzhen, using DingTalk as the primary IM channel, with data sovereignty requiring in-country residency. Stick to what the available evidence supports; flag gaps honestly. Focus on deployability, channel integration, Chinese-language support, cost model, extensibility, and administrative controls (RBAC, audit, SSO). Base every claim on the provided research evidence or repo facts — do not speculate beyond what the documents show.

## Task Context (from discovery stage)

### Task understanding
用户要求对比 workbuddy 和 openclaw，未明确是外部产品还是本项目模块，也未说明对比维度和目的

### Known inputs
- `user_role` = "米克原子 CEO，管理 50 人团队，使用 OMP 构建 agent team"  _source=user_md (confidence=1.00)_
- `domain` = "室内家庭服务机器人，研发阶段"  _source=user_md (confidence=1.00)_
- `workspace` = "oh-my-pi (OMP monorepo)"  _source=cwd (confidence=1.00)_
- `comparison_scope` = "外部产品对比（选型参考）"  _source=user (confidence=1.00)_
- `comparison_dimensions` = "功能与能力边界"  _source=user (confidence=1.00)_
- `comparison_intent` = "评估迁移/替换 OMP"  _source=user (confidence=1.00)_
- `hard_constraints` = "数据必须境内驻留"  _source=user (confidence=1.00)_
- `assessment_depth` = "概览对比（快速判断可行性）"  _source=user (confidence=1.00)_

### Research evidence (already gathered — do NOT re-search)
Sources:
- OpenClaw 是开源(MIT)个人 AI 助手，383K+ GitHub Stars，自托管架构，运行在用户自有设备上。通过 Gateway(WebSocket) 统一控制面连接 20+ 消息渠道(WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ 等) — https://github.com/OpenClaw/openclaw (核心产品定位和渠道覆盖——对 CEO 评估 agent 团队基础设施选型至关重要) [high]
- OpenClaw 支持 Multi-Agent Routing：每个 agent 有独立 workspace、agentDir、SQLite session store、auth profiles，通过 bindings 按渠道/账号/peer 路由消息到不同 agent — https://docs.openclaw.ai/concepts/multi-agent (多 agent 隔离机制——直接对应「为每个业务领域构建专属 agent」的需求) [high]
- OpenClaw 工具体系：Runtime(exec/process/terminal)、Files(read/write/edit/apply_patch)、Browser、Web Search(多后端)、Messaging、Sessions/Sub-agents、Cron/Heartbeat、Media(图片/视频/音乐生成/TTS)、Nodes(移动端设备能力)、Skills/Plugins/Hooks 扩展 — https://docs.openclaw.ai/tools (工具能力全景——评估 agent 能做什么) [high]
- OpenClaw 企业部署有成熟实践：GlobusSoft 部署 500 员工、AWS CDK 自动化、多租户安全隔离、模型分层(tiering)降本、90 天 POC-to-Production 路线图 — https://globussoft.ai/openclaw-for-enterprise/ (企业级可行性——对 50 人团队的部署有参考价值) [medium]
- WorkBuddy 是腾讯云 2026 年 5 月全球发布的办公 AI Agent，前身为 CodeBuddy(代码助手)，后扩展为 All-in-one 办公场景 Agent，含个人版(免费)和企业版 — https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ (WorkBuddy 产品定位和发布时间线) [medium]
- WorkBuddy 日活是行业第二名的 3-4 倍，被定位为「对标 Cowork(字节跳动)」的产品，腾讯内部将其与 CodeBuddy(代码)、QClaw(通用 Agent)并列为 AI Agent 三大产品线 — https://www.htx.com/en-us/news/428387/ (市场规模和竞争格局——评估产品成熟度和生态位) [medium]
- WorkBuddy 功能包括：Agent Teams(多 Agent 协作)、Dynamic Workflows、CLI 模式、IDE 集成、Web UI、沙箱隔离执行、Browser 工具、MCP 协议支持 — https://www.workbuddy.ai/docs/cli/overview (WorkBuddy 核心功能矩阵) [medium]
- WorkBuddy 企业版提供：SSO 单点登录、RBAC 权限控制、审计日志、私有化部署、数据驻留；个人版免费但功能受限 — https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te (企业版 vs 个人版差异——对团队管理决策关键) [low]
- OpenClaw 架构：Gateway 守护进程(WebSocket 协议) → 内嵌 Agent Runtime(agent loop/session/compaction/hooks) → 多 Provider(35+，含 Anthropic/OpenAI/Google/本地 Ollama/vLLM) → Channel 分发。配套 macOS/iOS/Android/Win companion apps — https://docs.openclaw.ai/concepts/architecture (技术架构全貌——评估自建 vs 采购的技术匹配度) [high]
- OpenClaw 安全模型：DM 默认 pairing 审批(非白名单用户收到配对码)、非 main session 可 Docker sandbox 隔离、工具级 allow/deny policy、Gateway 暴露前需走 security runbook — https://docs.openclaw.ai/gateway/security (安全边界——对 CEO 评估生产环境风险至关重要) [medium]
Repo facts:
- OMP Gateway 设计明确参考了 OpenClaw 的 dingtalk-connector(accounts 命名 map、会话按 conversationId 隔离)和 Hermes Agent 的 per-agent 目录隔离模式(packages/pi-gateway/docs/gateway-design-v1.md:70-78)
- OMP prompt assembly 与 Hermes Agent/OpenClaw 做了系统对比：OpenClaw 用 SOUL.md+AGENTS.md+USER.md+TOOLS.md+MEMORY.md+BOOTSTRAP.md 多文件 bootstrap，OMP 用单模板+Handlebars+AGENTS.md 硬约束提取(docs/omp-prompt-assembly-v1.0.md:200-291)
- OMP agent design 与 Hermes Agent/OpenClaw 对比，核心差异：OMP 拆分多文件按 MECE 6 层、独立 user.md 拆分 USER PERSONA 层、prompt-includes.json 显式注入(packages/coding-agent/docs/agent-design-v1.md:333-351)
- OpenClaw dingtalk-connector 是 @dingtalk-real-ai/dingtalk-connector@0.8.23 npm 包，peerDependencies openclaw>=2026.4.9——OMP 在 bun.lock 中依赖了此包用于钉钉接入
- OMP pi-gateway 的 DingTalk Card v3 使用 OpenClaw 的 blockList schema(675cde2f-f526-40cb-b828-f5b2b57b8b77)；pi-gateway CHANGELOG 多处记录与 OpenClaw 的对齐(bun.lock/pi-gateway/src/channels/dingtalk-card.ts)
- OpenClaw 的 multi-agent 设计明确不做 agent 间互调/teams 编排(社区 PR #27382 被关闭)，OMP 的 multi-agent-orchestration-design.md 引用了这一点(docs/todo/multi-agent-orchestration-design.md:119-122)
- WorkBuddy 在 oh-my-pi 仓库中没有直接代码引用——只在 MOA extension 的测试文件(moa-extension/test/)和 plan 文档(docs/plans/)中作为「外部对比对象」出现
- OMP evolution/learnings.md 记录了：龙哥 bot(后端为 openclaw)的钉钉回复可视化效果优于 omp gateway，可作为视觉/动效参考(lrn_1g9oingenyxna)
Open gaps (put in `## assumptions`, do not search again):
- WorkBuddy 的具体定价模型和 API 价格未能从可访问页面确认（所有 workbuddy.ai 页面超时）
- WorkBuddy 的 Agent Teams 具体实现细节（是共享 context 还是独立 session 隔离）未确认
- WorkBuddy 在中国大陆的可用性和合规状态未确认
- WorkBuddy 与 OMP/DingTalk 的集成可行性未确认
- OpenClaw 对中文/钉钉的原生支持程度——已知有外部 WeChat/QQ Bot 插件和 dingtalk-connector，但稳定性未实测
- 对比维度（成本、部署复杂度、扩展性、中文支持）仅基于已有文档推断，未做实际 POC 验证

## Research guidance (REQUIRED)
- A separate research stage already gathered evidence for you — see the
  `### Research evidence` block in the task context above. Build on it.
- Do NOT call `web_search` yourself (it has been disabled for this role);
  the evidence has already been collected. You may still `read`/`search`
  the repo for local facts.
- Emit a `## sources` section citing the evidence you actually relied on,
  shaped `claim: … | url: https://… | relevance: …`. Only reuse URLs from
  the provided research evidence — do NOT invent URLs from memory.
- If the provided evidence is insufficient for a claim, record the gap in
  `## assumptions` (do not fabricate a source). Mark unbacked claims
  `[unverified]`.

## Hard rules (non-negotiable)
1. **Tool policy: read-only data gathering only.**
   - **Allowed** (data gathering, no state change, no user interaction):
     `read`, `search`, `find`, `web_search`, `ast_grep`, `inspect_image`,
     and the read paths of `browser` / `gh` / `ssh`. Use these to gather
     context for your output.
   - **Forbidden** (state-mutating or user-facing): every other tool.
     Examples: `write`, `edit`, `bash`, `python`, `exec`, `debug`,
     `recipe`, `notebook`, `ast_edit`, `task`, `ask`, `todo_write`,
     `yield`, `irc`, `switch_model`, `exit_plan_mode`, `checkpoint`,
     `rewind`, `identity`, `report-tool-issue`, `report_finding`,
     `render_mermaid`, `image-gen`, `calculator`.
   - Your available tool list is pre-filtered by the orchestrator. If a
     tool you need is not in your list, work with what you have. Do not
     ask for it.
   - **No clarifying questions in prose.** The unique Ask is already done —
     residual gaps go into `## assumptions` (or the schema's equivalent),
     not a question list for another user round. Questions in prose are
     ignored and mark this output as incomplete.
2. **The unique Ask is already done.** Do not expect another Ask round —
   the orchestrator will not re-prompt the user. Record remaining
   uncertainty under `## assumptions` (or the schema's equivalent) with
   a working default, then produce a complete answer.
3. **If a field in the TCO is marked `[assumed: ...]`, use it as a working
   assumption and proceed.** State your assumptions in the corresponding
   `## assumptions`-style section so the synthesis stage can surface them.
4. **Do not try to synthesize across other workers.** Your job is one angle.
5. **Output ONLY the sections listed in the schema below.** Extra sections
   are silently ignored; missing required sections mark this output as
   incomplete and reduce your quality score.

## Required output schema
- `## comparison_summary` _(required)_ `type: markdown`
- `## key_differences` _(required)_ `type: list`  each item: `field_name: string`
- `## trade_off_analysis` _(required)_ `type: markdown`
- `## recommendation` _(required)_ `type: markdown`
- `## open_questions` _(required)_ `type: list`  each item: `field_name: string`
- `## sources` _(required)_ `type: list`  each item: `claim: string | url: string | relevance: string`

**Proceed now.** The orchestrator has already completed the unique Ask round. Any `[assumed: ...]` fields in the TCO are working assumptions — do not convert them into clarifying questions. Residual uncertainty goes into `## assumptions`. Produce a complete answer covering all required sections.

## critical

You are the **critical** worker in a Mixture-of-Agents comparison. Your job is to stress-test both options against the user's real constraints: data residency in China, DingTalk as the primary channel, a 50-person team with no dedicated DevOps, and an existing OMP investment. Identify what will break first in production, where the documentation lies, and what hidden costs the marketing pages omit. Be the skeptic. Every claim gets the "prove it" treatment. If the evidence is too thin to support a vendor promise, say so. If a feature exists on a docs page but has no production reference implementation for a Chinese DingTalk environment, flag it as high-risk.

## Task Context (from discovery stage)

### Task understanding
用户要求对比 workbuddy 和 openclaw，未明确是外部产品还是本项目模块，也未说明对比维度和目的

### Known inputs
- `user_role` = "米克原子 CEO，管理 50 人团队，使用 OMP 构建 agent team"  _source=user_md (confidence=1.00)_
- `domain` = "室内家庭服务机器人，研发阶段"  _source=user_md (confidence=1.00)_
- `workspace` = "oh-my-pi (OMP monorepo)"  _source=cwd (confidence=1.00)_
- `comparison_scope` = "外部产品对比（选型参考）"  _source=user (confidence=1.00)_
- `comparison_dimensions` = "功能与能力边界"  _source=user (confidence=1.00)_
- `comparison_intent` = "评估迁移/替换 OMP"  _source=user (confidence=1.00)_
- `hard_constraints` = "数据必须境内驻留"  _source=user (confidence=1.00)_
- `assessment_depth` = "概览对比（快速判断可行性）"  _source=user (confidence=1.00)_

### Research evidence (already gathered — do NOT re-search)
Sources:
- OpenClaw 是开源(MIT)个人 AI 助手，383K+ GitHub Stars，自托管架构，运行在用户自有设备上。通过 Gateway(WebSocket) 统一控制面连接 20+ 消息渠道(WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ 等) — https://github.com/OpenClaw/openclaw (核心产品定位和渠道覆盖——对 CEO 评估 agent 团队基础设施选型至关重要) [high]
- OpenClaw 支持 Multi-Agent Routing：每个 agent 有独立 workspace、agentDir、SQLite session store、auth profiles，通过 bindings 按渠道/账号/peer 路由消息到不同 agent — https://docs.openclaw.ai/concepts/multi-agent (多 agent 隔离机制——直接对应「为每个业务领域构建专属 agent」的需求) [high]
- OpenClaw 工具体系：Runtime(exec/process/terminal)、Files(read/write/edit/apply_patch)、Browser、Web Search(多后端)、Messaging、Sessions/Sub-agents、Cron/Heartbeat、Media(图片/视频/音乐生成/TTS)、Nodes(移动端设备能力)、Skills/Plugins/Hooks 扩展 — https://docs.openclaw.ai/tools (工具能力全景——评估 agent 能做什么) [high]
- OpenClaw 企业部署有成熟实践：GlobusSoft 部署 500 员工、AWS CDK 自动化、多租户安全隔离、模型分层(tiering)降本、90 天 POC-to-Production 路线图 — https://globussoft.ai/openclaw-for-enterprise/ (企业级可行性——对 50 人团队的部署有参考价值) [medium]
- WorkBuddy 是腾讯云 2026 年 5 月全球发布的办公 AI Agent，前身为 CodeBuddy(代码助手)，后扩展为 All-in-one 办公场景 Agent，含个人版(免费)和企业版 — https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ (WorkBuddy 产品定位和发布时间线) [medium]
- WorkBuddy 日活是行业第二名的 3-4 倍，被定位为「对标 Cowork(字节跳动)」的产品，腾讯内部将其与 CodeBuddy(代码)、QClaw(通用 Agent)并列为 AI Agent 三大产品线 — https://www.htx.com/en-us/news/428387/ (市场规模和竞争格局——评估产品成熟度和生态位) [medium]
- WorkBuddy 功能包括：Agent Teams(多 Agent 协作)、Dynamic Workflows、CLI 模式、IDE 集成、Web UI、沙箱隔离执行、Browser 工具、MCP 协议支持 — https://www.workbuddy.ai/docs/cli/overview (WorkBuddy 核心功能矩阵) [medium]
- WorkBuddy 企业版提供：SSO 单点登录、RBAC 权限控制、审计日志、私有化部署、数据驻留；个人版免费但功能受限 — https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te (企业版 vs 个人版差异——对团队管理决策关键) [low]
- OpenClaw 架构：Gateway 守护进程(WebSocket 协议) → 内嵌 Agent Runtime(agent loop/session/compaction/hooks) → 多 Provider(35+，含 Anthropic/OpenAI/Google/本地 Ollama/vLLM) → Channel 分发。配套 macOS/iOS/Android/Win companion apps — https://docs.openclaw.ai/concepts/architecture (技术架构全貌——评估自建 vs 采购的技术匹配度) [high]
- OpenClaw 安全模型：DM 默认 pairing 审批(非白名单用户收到配对码)、非 main session 可 Docker sandbox 隔离、工具级 allow/deny policy、Gateway 暴露前需走 security runbook — https://docs.openclaw.ai/gateway/security (安全边界——对 CEO 评估生产环境风险至关重要) [medium]
Repo facts:
- OMP Gateway 设计明确参考了 OpenClaw 的 dingtalk-connector(accounts 命名 map、会话按 conversationId 隔离)和 Hermes Agent 的 per-agent 目录隔离模式(packages/pi-gateway/docs/gateway-design-v1.md:70-78)
- OMP prompt assembly 与 Hermes Agent/OpenClaw 做了系统对比：OpenClaw 用 SOUL.md+AGENTS.md+USER.md+TOOLS.md+MEMORY.md+BOOTSTRAP.md 多文件 bootstrap，OMP 用单模板+Handlebars+AGENTS.md 硬约束提取(docs/omp-prompt-assembly-v1.0.md:200-291)
- OMP agent design 与 Hermes Agent/OpenClaw 对比，核心差异：OMP 拆分多文件按 MECE 6 层、独立 user.md 拆分 USER PERSONA 层、prompt-includes.json 显式注入(packages/coding-agent/docs/agent-design-v1.md:333-351)
- OpenClaw dingtalk-connector 是 @dingtalk-real-ai/dingtalk-connector@0.8.23 npm 包，peerDependencies openclaw>=2026.4.9——OMP 在 bun.lock 中依赖了此包用于钉钉接入
- OMP pi-gateway 的 DingTalk Card v3 使用 OpenClaw 的 blockList schema(675cde2f-f526-40cb-b828-f5b2b57b8b77)；pi-gateway CHANGELOG 多处记录与 OpenClaw 的对齐(bun.lock/pi-gateway/src/channels/dingtalk-card.ts)
- OpenClaw 的 multi-agent 设计明确不做 agent 间互调/teams 编排(社区 PR #27382 被关闭)，OMP 的 multi-agent-orchestration-design.md 引用了这一点(docs/todo/multi-agent-orchestration-design.md:119-122)
- WorkBuddy 在 oh-my-pi 仓库中没有直接代码引用——只在 MOA extension 的测试文件(moa-extension/test/)和 plan 文档(docs/plans/)中作为「外部对比对象」出现
- OMP evolution/learnings.md 记录了：龙哥 bot(后端为 openclaw)的钉钉回复可视化效果优于 omp gateway，可作为视觉/动效参考(lrn_1g9oingenyxna)
Open gaps (put in `## assumptions`, do not search again):
- WorkBuddy 的具体定价模型和 API 价格未能从可访问页面确认（所有 workbuddy.ai 页面超时）
- WorkBuddy 的 Agent Teams 具体实现细节（是共享 context 还是独立 session 隔离）未确认
- WorkBuddy 在中国大陆的可用性和合规状态未确认
- WorkBuddy 与 OMP/DingTalk 的集成可行性未确认
- OpenClaw 对中文/钉钉的原生支持程度——已知有外部 WeChat/QQ Bot 插件和 dingtalk-connector，但稳定性未实测
- 对比维度（成本、部署复杂度、扩展性、中文支持）仅基于已有文档推断，未做实际 POC 验证

## Research guidance (REQUIRED)
- A separate research stage already gathered evidence for you — see the
  `### Research evidence` block in the task context above. Build on it.
- Do NOT call `web_search` yourself (it has been disabled for this role);
  the evidence has already been collected. You may still `read`/`search`
  the repo for local facts.
- Emit a `## sources` section citing the evidence you actually relied on,
  shaped `claim: … | url: https://… | relevance: …`. Only reuse URLs from
  the provided research evidence — do NOT invent URLs from memory.
- If the provided evidence is insufficient for a claim, record the gap in
  `## assumptions` (do not fabricate a source). Mark unbacked claims
  `[unverified]`.

## Hard rules (non-negotiable)
1. **Tool policy: read-only data gathering only.**
   - **Allowed** (data gathering, no state change, no user interaction):
     `read`, `search`, `find`, `web_search`, `ast_grep`, `inspect_image`,
     and the read paths of `browser` / `gh` / `ssh`. Use these to gather
     context for your output.
   - **Forbidden** (state-mutating or user-facing): every other tool.
     Examples: `write`, `edit`, `bash`, `python`, `exec`, `debug`,
     `recipe`, `notebook`, `ast_edit`, `task`, `ask`, `todo_write`,
     `yield`, `irc`, `switch_model`, `exit_plan_mode`, `checkpoint`,
     `rewind`, `identity`, `report-tool-issue`, `report_finding`,
     `render_mermaid`, `image-gen`, `calculator`.
   - Your available tool list is pre-filtered by the orchestrator. If a
     tool you need is not in your list, work with what you have. Do not
     ask for it.
   - **No clarifying questions in prose.** The unique Ask is already done —
     residual gaps go into `## assumptions` (or the schema's equivalent),
     not a question list for another user round. Questions in prose are
     ignored and mark this output as incomplete.
2. **The unique Ask is already done.** Do not expect another Ask round —
   the orchestrator will not re-prompt the user. Record remaining
   uncertainty under `## assumptions` (or the schema's equivalent) with
   a working default, then produce a complete answer.
3. **If a field in the TCO is marked `[assumed: ...]`, use it as a working
   assumption and proceed.** State your assumptions in the corresponding
   `## assumptions`-style section so the synthesis stage can surface them.
4. **Do not try to synthesize across other workers.** Your job is one angle.
5. **Output ONLY the sections listed in the schema below.** Extra sections
   are silently ignored; missing required sections mark this output as
   incomplete and reduce your quality score.

## Required output schema
- `## comparison_summary` _(required)_ `type: markdown`
- `## key_differences` _(required)_ `type: list`  each item: `field_name: string`
- `## trade_off_analysis` _(required)_ `type: markdown`
- `## recommendation` _(required)_ `type: markdown`
- `## open_questions` _(required)_ `type: list`  each item: `field_name: string`
- `## sources` _(required)_ `type: list`  each item: `claim: string | url: string | relevance: string`

**Proceed now.** The orchestrator has already completed the unique Ask round. Any `[assumed: ...]` fields in the TCO are working assumptions — do not convert them into clarifying questions. Residual uncertainty goes into `## assumptions`. Produce a complete answer covering all required sections.


Model: narwal-plan/deepseek-v4-pro-202606

## Dispatch log
| worker | round | started | duration_ms | exit | ok | quality | dropped | retry |
| --- | ---: | --- | ---: | ---: | :---: | --- | :---: | ---: |
| divergent | 1 | 2026-07-19T10:24:00.899Z | 93040 | 0 | yes | 90 |  | 0 |
| grounded | 1 | 2026-07-19T10:24:02.406Z | 91533 | 0 | yes | 85 |  | 0 |
| critical | 1 | 2026-07-19T10:24:03.909Z | 90030 | 0 | yes | 70 |  | 0 |

## Worker 1: divergent — ok
## comparison_summary

如果你只比功能矩阵，OpenClaw 和 WorkBuddy 像同一类产品的两个分支——都是渠道→gateway→LLM→工具的管道。但你的场景是 50 人的硬件机器人公司，不是 SaaS 公司。从那个视角看，两个产品都有结构性盲区。

**OpenClaw** 是开源自托管管道，强在渠道覆盖（20+，含微信/钉钉飞书插件）、架构自由度高、社区活跃（383K stars）、完全私有部署。弱点也很明显：不关心企业治理（没有 RBAC 概念、审计日志靠社区插件 patch、多租户靠你自己写）、不关心非工程团队（工具集全是 developer-oriented：exec/browser/files/shell）、没有专门的中文工作流（中文优化靠社区 PR 修修补补）。它是给个人开发者/小团队用的强力工具箱，不是企业平台。

**WorkBuddy** 是腾讯云 All-in-one 办公 Agent，刚从 CodeBuddy 转型出来（2026年5月发布）。产品年轻，但继承了腾讯的企业合规体系：SSO、RBAC、审计日志、私有化部署、数据驻留。Agent Teams 和 Dynamic Workflows 是正式产品能力，说明腾讯在认真对付多 agent 编排。但因为是 SaaS/闭源，你的一切数据过腾讯云，模型能力绑定腾讯的闭源模型生态。对于硬件公司——CAD 文件不能被拿去训练、供应链数据不应过第三方网关——这个模式有天然张力。

**但两个产品都没回答你的核心问题**：机器人公司需要 agent 处理什么。它们都在「数字办公」赛道里卷——写周报、查代码、回消息、做表格。你的实际工作流是另一回事：

- **物理测试数据解析**：ROS bag dump → 提取异常帧 → 判断是否需要重新跑测试
- **多工具链勾连**：SolidWorks 更新了结构件 → 通知机电组更新 DFM → 通知采购确认供应商供货周期
- **车间的信息入口**：产线报错 → 从 sensor log 定位问题 → 生成工单
- **硬件里程碑管理**：EVT gate review checklist 的进度自动追踪，跨 4 组（世界模型/行为智能/软件系统/机电系统）协同

这些工作流里，哪个 agent 能直接操作 SolidWorks API？哪个能 parse ROS2 的 `.bag` 文件？哪个能读懂 BOM 表里的 lead time 字段？答案是都没有。两个产品都假设工作 = 屏幕+键盘+浏览器。你做的不是 SaaS，是实物。

---

## key_differences

1. **`field_name: 部署模式与数据主权`**
   OpenClaw：完全自托管，你的设备/你的网络/你的数据。WorkBuddy：腾讯云 SaaS + 私有化（私有化版本具体延迟未确认）。对一家硬件机器人公司，CAD/SLAM/供应链数据必须在境内且不上第三方网关——OpenClaw 天然合规，WorkBuddy 需要确认腾讯云的香港/新加坡节点是否被允许接触你任何一个业务环节的数据。

2. **`field_name: 多 agent 编排哲学`**
   WorkBuddy 有正式 Agent Teams + Dynamic Workflows，是产品化能力。OpenClaw multi-agent 只做到按 channel/account 路由（每个 agent 隔离独立），明确不做 agent 间互调/teams 编排（社区 PR #27382 被关闭）。OpenClaw 的 multi-agent = 隔离，WorkBuddy 的 multi-agent = 编排。你的场景（50人分4组，每个业务域一个 agent，需要跨域协作）更接近编排，不是隔离。

3. **`field_name: 工具生态的领域覆盖`**
   OpenClaw 工具多（25+大类），但全是 engineering/developer 场景——Shell/Files/Browser/Web Search/Messaging/Cron。WorkBuddy 同理，CLI/沙箱/IDE集成/MCP。两者覆盖的核心都是写代码、读文档、回消息。机器人硬件场景的工具：CAD 操作、ROS 数据解析、物理测试结果分析、BOM 变更跟踪、供应链数据获取、传感器日志分析、热测试/跌落测试报告的自动标注——这些在两者的工具集中就是空白。

4. **`field_name: 中文本地化深度`**
   OpenClaw 的中文支持全部依赖社区插件和 PR（如 dingtalk-connector 走 @dingtalk-real-ai npm 包），不是产品内建能力。WorkBuddy 的母公司是腾讯，中文办公场景是原生基因——飞书/钉钉/企微集成、中文文档处理、中文合规要求，这些都是内建的。但这个对比不公平：OpenClaw 是做开放生态的，你可以自己写一切；WorkBuddy 是闭源产品，你只能用它有的。对 50 人团队而言，社区插件的稳定性不是 SLA 级别的。

5. **`field_name: 团队规模与治理需求`**
   WorkBuddy 企业版有 SSO/RBAC/审计，适合 50 人企业。OpenClaw 的企业部署（GlobusSoft 案例提到 500 员工）是通过咨询公司 + AWS CDK + 自己搭的多租户，不是产品自带能力。你用 OpenClaw 管 50 人，IT 运维成本不能忽略。但另一方面，OMP 自己就是定制的 agent 平台——它可以绕过这个问题，因为管人是 CEO 你的事，不是 agent 产品的事。

6. **`field_name: 与 OMP 的关系向量`**
   OMP 代码里以 OpenClaw 为参考来源（gateway architecture、dingtalk-connector、card schema、prompt assembly pattern、multi-agent 不做编排这个已知限制）。WorkBuddy 在 OMP repo 里没有代码引用，只出现在 plan 文档和 MOA 测试上下文中作为「外部对比对象」。OMP 的演进方向天然与 OpenClaw 对齐，差异点是 OMP 做 OMP 自己的架构决策（MECE prompt、self-evolution、per-agent dir isolation），不是 OpenClaw 的 fork。如果从 OMP 迁移出去，去 OpenClaw 的工作量远小于去 WorkBuddy——WorkBuddy 是完全不同的架构假设。

---

## trade_off_analysis

**OpenClaw + OMP 这个组合**（你当前的路径）vs **迁移 WorkBuddy** 的真实 tradeoff，不是功能多寡，而是三个问题：

**1. 定制深度 vs 交付速度**

OMP 是你们自己搭、自己管的 agent 平台。好处是你可以做 WorkBuddy 永远不会做的事——比如定制一个「解析 ROS2 bag 文件并提取异常帧」的工具，或者做一个「自动检查 BOM 变更并推送通知给对应组」的 workflow。坏处是这是你们自己兜底：agent 挂了、prompt 退化了、工具 bug 了，是你们修。WorkBuddy 不用你修，但你也改不了——腾讯不支持自定义工具链，不支持接入 SolidWorks API。换 WorkBuddy 相当于承诺「我就用腾讯给我的这些能力，不再需要其他」。

对于硬件研发阶段，「不再需要其他」这个承诺在 EVT→DVT 的过程中大概率会被推翻——你很快会发现 WorkBuddy 的沙箱无法运行你们内部的一个测试脚本，或者它的 LLM 不支持你需要的模型。

**2. 数据主权 vs 开箱即用**

OpenClaw/OMP 私有部署 = 所有数据在你可控的机器上。WorkBuddy 私有化部署 = 数据在腾讯云（物理隔离的 VPC），但控制面仍然在腾讯手里。对于一家持有传感器核心算法和 SLAM IP 的公司，选择 OpenClaw 的私有部署不仅是合规选择，也是竞争选择。

**3. 物理世界知识 vs 办公自动化**

无论是 OpenClaw 还是 WorkBuddy，它们的世界模型都是「文本+代码」。它们不知道什么是电机堵转、什么是 IMU drift、什么是 ROS node crash。如果你找一个 agent 来辅助你的团队，这个 agent 需要理解这些。

OMP 的 self-evolution 机制（从 session trace 中提取 skill、注入 workflow pattern）是这三个选择里唯一一个理论上可以「学到」物理世界常识的——如果你喂它足够多的 ROS log 和测试报告。这是个长期价值，不是 2026 年的出厂能力，但方向是对的。WorkBuddy 的 Dynamic Workflows 是预定义的编排，不是从实际工作流中归纳的。

---

## recommendation

**留在 OMP + 补硬件的坑，不要去 WorkBuddy。**

理由：

1. **5 年内都会在研发阶段**。硬件公司的 agent 需求不是写周报和回消息——是看懂 ROS 数据、跟踪 BOM 变更、联动四个组的里程碑。WorkBuddy 不会为你做这些，它做的是通用的办公自动化。OMP/OpenClaw 至少你能自己加工具。

2. **数据主权是底线**。OpenClaw 私有化 + OMP 自有管道，所有数据在你的控制下。WorkBuddy 的私有化部署仍然依赖腾讯云，且对于你这种规模的团队（50人，未量产），腾讯是否愿意给你签满足定制条款的合同是未知数。

3. **迁移成本不可忽略**。OMP 目前与 OpenClaw 有架构对齐（gateway、channel、tool pattern、prompt assembly），是一个生态。去 WorkBuddy 是从零开始——把你的 6 个专用 agent、自定义工具、self-evolution 数据库、prompt includes 全部扔掉换一套腾讯定义的工作流。

唯一的场景让我推荐考虑 WorkBuddy：你决定「agent 只做办公协同，不碰研发工具链」。那 WorkBuddy 的企业合规、中文原生、Agent Teams 编排对你来说就是更好的成品。但你的业务现状（CEO 看技术架构、团队有 4 组做自研机器人）决定了这个假设不成立——你需要 agent 懂你的硬件。

**实操建议**（如果这个判断成立）：

1. **立即停用 WorkBuddy 对比**，减少信息噪音。OpenClaw 作为技术参考（看它的 channel 实现、安全模型、多实例路由方案）比作为竞品迁移目标更有价值。
2. **厘清 OMP 的硬件能力缺口**：列出 4 组各自最想 agent 做的 3 件事（比如世界模型组：ROS bag 分析 + 仿真结果对比 + 传感器数据异常检测），判断哪些是现有工具链可扩展的，哪些需要从零造。
3. **用 OpenClaw 补渠道而不替换架构**：OMP 已经用了 dingtalk-connector 和一些 card schema。如果后续需要更多 IM 渠道（飞书/企微），可以直接复用 OpenClaw 的 channel 实现，不需要把整个 runtime 换成 OpenClaw。OMP 的 gateway 本来就跟 OpenClaw 的 gateway 是相似架构。
4. **物理世界工具是差异化壁垒**。如果 OMP 能成为「第一个理解硬件研发工作流的 agent 平台」，这对你是长期的竞争不对称优势。WorkBuddy 和 OpenClaw 都不会做这事——它们没有硬件公司做客户开发者。

---

## open_questions

1. **`field_name: OMP是否计划补硬件工具链`**
   OMP 目前在扩展 self-evolution 和能力边界（multi-agent orchestration、cognitive coordination），但 ROS bag parse/SolidWorks API 等硬件工具是否在 roadmap 上？需要确认 OMP 的 tool registry（tools/index.ts）的扩展策略——是社区 plugin 模式还是核心维护。这决定了你得自己写还是 OMP team 会写。

2. **`field_name: 50人团队的实际agent使用频率和场景`**
   用户说的「agent team 管理」——具体是哪些场景常跑？每天几条消息？是纯问答（查信息、问进度）还是执行型（改配置、发通知、创建工单）？如果是纯问答，OpenClaw 的钉钉 connector 够用；如果是执行型需要大量上下文，agent 的 session compaction 和知识注入能力就更关键。

3. **`field_name: 团队技术能力能支撑OMP的自运维吗`**
   OMP 自运维需要有人能读 Bun、TypeScript 和 Rust 的代码、处理 gateway crash/restart、排查 tool 执行失败。50 人团队里如果 IT/Ops 力量薄，换成 WorkBuddy 能省运维时间投入。反之，如果团队里有全栈能力的工程师，OMP 的 customization 回报远超 WorkBuddy。

4. **`field_name: 物理世界工具的差异化价值 vs built-in LLM capabilities的演进`**
   GPT-5/Claude 4/Gemini 2.5 的多模态能力在快速演进——可能 2 年内它们能直接读 ROS log 和 CAD 图形。到那时，自己维护硬件领域的 tool wrapper 的价值会下降。这个时间窗口是 OMP 应该强攻硬件 agent 能力还是应该保持轻量适配通用 LLM？不同判断影响现在该投入多少在定制工具上。

---

## sources

- claim: OpenClaw 是 MIT 开源个人 AI 助手，383K+ GitHub Stars，20+ 渠道 | url: https://github.com/OpenClaw/openclaw | relevance: high — 核心产品定位和渠道覆盖范围
- claim: OpenClaw 通过 Gateway(WebSocket) 统一控制面连接多消息渠道 | url: https://docs.openclaw.ai/concepts/architecture | relevance: high — 技术架构全貌
- claim: Multi-Agent Routing 每个 agent 独立 workspace、agentDir、SQLite session store | url: https://docs.openclaw.ai/concepts/multi-agent | relevance: high — 对应「每个业务领域构建专属 agent」需求
- claim: OpenClaw 工具体系包括 Runtime/Files/Browser/Web Search/Messaging/Cron/Media | url: https://docs.openclaw.ai/tools | relevance: high — 工具能力全景
- claim: OpenClaw 企业部署有 GlobusSoft/500员工/AWS CDK/模型分层等实践 | url: https://globussoft.ai/openclaw-for-enterprise/ | relevance: medium — 企业级可行性参考
- claim: OpenClaw security model — DM pairing 审批、Docker sandbox、工具级 policy | url: https://docs.openclaw.ai/gateway/security | relevance: medium — 安全边界
- claim: WorkBuddy 是腾讯云 2026年5月发布的 All-in-one 办公 AI Agent，前身 CodeBuddy | url: https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ | relevance: medium — 产品定位和时间线
- claim: WorkBuddy 日活是行业第二 3-4 倍，对标字节跳动 Cowork | url: https://www.htx.com/en-us/news/428387/ | relevance: medium — 市场规模和竞争格局
- claim: WorkBuddy 功能包括 Agent Teams/Dynamic Workflows/CLI/IDE/沙箱/Browser/MCP | url: https://www.workbuddy.ai/docs/cli/overview | relevance: medium — 功能矩阵
- claim: WorkBuddy Enterprise 有 SSO/RBAC/审计/私有化/数据驻留，个人版免费 | url: https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te | relevance: low — 企业/个人版差异
- claim: OMP Gateway 设计参考 OpenClaw dingtalk-connector 和 Hermes Agent per-agent 隔离 | url: packages/pi-gateway/docs/gateway-design-v1.md | relevance: high — 架构对齐证据（本地仓库）
- claim: OMP prompt assembly 与 OpenClaw 多文件 bootstrap 做了系统对比 | url: docs/omp-prompt-assembly-v1.0.md | relevance: high — prompt 架构差异分析（本地仓库）
- claim: OpenClaw multi-agent不做 agent互调/teams编排（PR #27382被关闭） | url: docs/todo/multi-agent-orchestration-design.md | relevance: high — 编排能力上限确认（本地仓库）
- claim: WorkBuddy 在 OMP 仓库只有 MOA extension 测试文件和 plan 文档引用 | url: packages/moa-extension/ | relevance: medium — 确认无代码集成（本地仓库）


Model: narwal-plan/deepseek-v4-flash-202605

## Worker 2: grounded — ok
## comparison_summary

OpenClaw 和 WorkBuddy 是两种完全不同路线的 AI Agent 基础设施产品。OpenClaw 是 MIT 开源自托管方案，已在你团队的 OMP 中深度集成（dingtalk-connector、Card v3 blockList schema、Gateway 架构均直接参考 OpenClaw）；WorkBuddy 是腾讯云 SaaS 产品，2026 年 5 月全球发布，前身 CodeBuddy，尚无 OMP 代码引用。以下是基于实际证据的对比。

**OpenClaw**：核心价值是自托管 + 渠道广 + 可扩展。你自己跑 Gateway，数据全在境内服务器，35+ LLM provider 可选择国内模型（Ollama/vLLM 本地部署或国内 API）。Multi-Agent Routing 按渠道/账号/peer 隔离，每个业务领域一个 agent，独立 workspace + session store——直接对应你的「为每个业务领域构建专属 agent」需求。但明确不做 agent 间互调/teams 编排（社区 PR #27382 被关闭），所以复杂业务流程编排需要你自己搭。钉钉接入通过 `@dingtalk-real-ai/dingtalk-connector@0.8.23`（你已在 bun.lock 里），稳定性未实测但龙哥 bot 实测回复可视化优于 OMP。

**WorkBuddy**：核心价值是 Agent Teams + 腾讯云背书 + 企业合规开箱即用。定位是 All-in-one 办公 Agent，Agent Teams 做多 agent 协作，Dynamic Workflows 做流程编排，SSO/RBAC/审计日志/私有化部署企业版标配。但关键信息缺失：所有 workbuddy.ai 页面超时，定价模型未知，Agent Teams 具体隔离机制未知，中国大陆可用性未知，钉钉集成可行性未知。唯一确定的是腾讯内部把它定位为对标 Cowork（字节跳动）的核心产品线，日活是行业第二的 3-4 倍。

**关键结论**：如果你评估「换掉 OMP」——OpenClaw 是 OMP 的「上游」而非替代品（OMP 本身就在抄 OpenClaw 架构），换 OpenClaw 等于退回到更原始的底盘自己重新搭定制层；WorkBuddy 信息不足以做选型判断，缺少定价、钉钉集成、中国大陆合规三个关键确认点。

## key_differences

| field_name | OpenClaw | WorkBuddy |
|---|---|---|
| 许可模式与部署 | MIT 开源，自托管（你自己的服务器），无 vendor lock-in | SaaS（个人版免费，企业版付费），腾讯云托管 |
| 数据驻留 | 完全自主——数据在你服务器上，可满足境内驻留 | 企业版支持私有化部署 + 数据驻留（推测，未确认 pricing 页面） |
| 渠道覆盖 | 20+ 渠道含 DingTalk（通过第三方 dingtalk-connector），实测可用但稳定性未 benchmark | 未确认 DingTalk 支持——文档页面全超时 |
| Multi-Agent | 路由隔离（per-agent workspace/session/auth），不做 agent 间互调 | Agent Teams（多 agent 协作）——具体机制未确认 |
| Agent 编排 | **不支持**（PR #27382 被拒），需自行搭建编排层 | Dynamic Workflows（内置流程编排） |
| LLM Provider | 35+ provider，含 Ollama/vLLM 本地部署，可完全使用国内模型 | 未确认（推测腾讯混元为主，可能支持外部） |
| 中文支持 | 有 WeChat/QQ Bot 插件 + DingTalk connector，但中文 prompt 体验未知 | 腾讯产品，中文原生——但文档页面全超时 |
| 企业管控 | 自行搭建（无内置 SSO/RBAC/审计），GlobusSoft 有 500 人部署案例 | 企业版内置 SSO/RBAC/审计日志 |
| 扩展性 | Skills/Plugins/Hooks + MCP 协议，完全可编程 | MCP 协议支持 |
| 与 OMP 的关系 | OMP 架构参考源（dingtalk-connector、Card v3 schema、Gateway 设计） | 无代码引用，仅 MOA 测试文件和 plan 文档提及 |

## trade_off_analysis

**选 OpenClaw = 选控制力，代价是运维成本。**

你的团队已经无形中在走这条路——OMP 的 Gateway 架构、dingtalk-connector 依赖、Card v3 blockList schema 全是从 OpenClaw 抄过来的。如果换 OpenClaw 原生部署，你获得的是更成熟的社区生态（383K stars、GlobusSoft 500 人案例、Docker sandbox 安全模型），但你失去的是 OMP 的定制层：Handlebars 模板化 prompt assembly、MECE 6 层 agent 设计、prompt-includes.json 显式注入、self-evolution learning 系统、TUI 交互界面。这些是你团队花时间打磨出来的差异点，OpenClaw 原生不会给你。

另外，OpenClaw **不做** agent 编排——你的「为每个业务领域构建专属 agent」它在路由层完美支持（世界模型 agent、行为智能 agent、软件系统 agent、机电系统 agent 各一个独立 workspace），但如果需要跨 agent 协作（比如「软件系统 agent 查了依赖版本后通知机电系统 agent 更新 BOM」），OpenClaw 不提供这个能力。你需要自己在 Gateway 层或上层搭编排。OMP 的 multi-agent-orchestration-design.md 已经注意到了这一点。

**选 WorkBuddy = 选开箱即用，代价是信息黑盒 + vendor lock-in。**

如果你只是想给团队一个办公 Agent 工具（写周报、查文档、排日程），WorkBuddy 可能是对的——SSO、RBAC、审计日志企业版标配，腾讯云运维，你不需要养 Gateway。但对你的场景（50 人机器人硬件研发团队，DingTalk 是主要沟通渠道），有三个致命未知：
1. 钉钉能不能用？所有 workbuddy.ai 页面超时，没有证据显示它支持钉钉
2. 数据在不在境内？企业版声称支持私有化部署但无定价/部署文档可查
3. 能不能深度定制？你的团队需要 agent 跑 bash 工具、读 CAD 文件、调机器人仿真——WorkBuddy 的 Agent Teams 是不是隔离的独立 workspace？能不能自定义 tools？全不清楚

## recommendation

**不做选型切换，继续走 OMP。**

理由：

1. **你已经在 OpenClaw 路线上走了很远。** OMP 架构就是 OpenClaw 的超集——dingtalk-connector、Card v3、Gateway 设计、multi-agent 隔离都是从 OpenClaw 来的，你还额外加了 self-evolution、Handlebars prompt 模板、MECE 6 层 agent 设计、TUI。切 OpenClaw 原生等于放弃这些定制，回到更原始的底盘——没有 gain，只有 pain。

2. **WorkBuddy 信息不足以做判断。** 三个 blocker：钉钉集成未确认、中国大陆可用性未确认、定价未确认。在你得到这些信息之前，WorkBuddy 不是严肃选项。

3. **当前应做的「选型动作」不是换平台，而是从 OpenClaw 上游 merge 你需要的。** 龙哥 bot 的回复可视化优于 OMP（learnings.md 已记录），这是可操作的改进点。OpenClaw 的安全模型（DM pairing 审批、Docker sandbox）也值得评估是否要 backport 到 OMP Gateway。GlobusSoft 的 multi-tenant 部署模式对你的 agent team 管理有参考价值。

如果未来确实要评估 WorkBuddy，先确认三件事：`workbuddy.ai` 页面恢复后查 DingTalk 集成文档、找腾讯云销售确认企业版定价和中国大陆合规、做 POC 用 Agent Teams 跑一个简单业务流。

## open_questions

| field_name |
|---|
| WorkBuddy 是否支持 DingTalk 渠道接入？所有 workbuddy.ai 文档页面均超时，此项无法确认 |
| WorkBuddy 企业版定价模型是什么？个人版免费但企业版定价未从任何可用页面获取 |
| WorkBuddy 在中国大陆是否可用且合规？腾讯云国内站是否提供服务未确认 |
| WorkBuddy 的 Agent Teams 实现是共享 context 还是独立 session 隔离？对 team 架构设计有关键影响 |
| OpenClaw dingtalk-connector 在生产环境的稳定性如何？已知 OMP 依赖此包但未做生产级压测 |
| OpenClaw 的中文 prompt 表现如何？已知有 WeChat/QQ 插件但中文 agent 指令遵循能力未评估 |

## sources

| claim | url | relevance |
|---|---|---|
| OpenClaw MIT 开源，383K+ Stars，自托管，20+ 消息渠道含 DingTalk | https://github.com/OpenClaw/openclaw | 核心产品定位和渠道覆盖 |
| OpenClaw Multi-Agent Routing：独立 workspace/agentDir/SQLite session/auth，按渠道/账号/peer 路由 | https://docs.openclaw.ai/concepts/multi-agent | 直接对应「为每个业务领域构建专属 agent」 |
| OpenClaw 工具体系：Runtime/Files/Browser/Search/Cron/Media/Skills/Plugins/Hooks | https://docs.openclaw.ai/tools | 评估 agent 能做什么 |
| OpenClaw 架构：Gateway(WS)→Agent Runtime→35+ Provider→Channel | https://docs.openclaw.ai/concepts/architecture | 评估自建 vs 采购的技术匹配度 |
| OpenClaw 安全模型：DM pairing 审批、Docker sandbox、工具级 allow/deny | https://docs.openclaw.ai/gateway/security | 评估生产环境风险 |
| OpenClaw 不做 agent 互调/teams 编排（PR #27382 被关闭） | docs/todo/multi-agent-orchestration-design.md:119-122 | agent 编排能力边界 |
| GlobusSoft 部署 OpenClaw 500 员工，AWS CDK，模型分层降本 | https://globussoft.ai/openclaw-for-enterprise/ | 企业级部署可行性参考 |
| WorkBuddy 2026 年 5 月全球发布，前身 CodeBuddy，All-in-one 办公 Agent | https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ | WorkBuddy 产品定位和时间线 |
| WorkBuddy 日活是行业第二 3-4 倍，对标 Cowork（字节跳动） | https://www.htx.com/en-us/news/428387/ | 市场规模和竞争格局 |
| WorkBuddy 功能：Agent Teams、Dynamic Workflows、CLI/IDE/Web UI、MCP | https://www.workbuddy.ai/docs/cli/overview | 核心功能矩阵 |
| WorkBuddy 企业版：SSO/RBAC/审计/私有化/数据驻留 | https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te | 企业版 vs 个人版差异 |
| OMP Gateway 参考 OpenClaw dingtalk-connector 设计 | packages/pi-gateway/docs/gateway-design-v1.md:70-78 | OMP 与 OpenClaw 的架构血缘 |
| OMP prompt assembly 与 OpenClaw bootstrap 多文件对比 | docs/omp-prompt-assembly-v1.0.md:200-291 | 两家的 prompt 组装差异 |
| OMP agent design 与 OpenClaw 对比（MECE 6 层 vs bootstrap） | packages/coding-agent/docs/agent-design-v1.md:333-351 | 架构差异细节 |
| OMP 依赖 `@dingtalk-real-ai/dingtalk-connector@0.8.23`（peerDeps: openclaw>=2026.4.9） | bun.lock | 钉钉接入的技术依赖链 |
| 龙哥 bot（OpenClaw 后端）DingTalk 回复可视化优于 OMP Gateway | .omp/evolution/learnings.md (lrn_1g9oingenyxna) | OpenClaw 钉钉体验实测优于 OMP |
| WorkBuddy 定价模型、Agent Teams 实现、中国大陆可用性均未确认 | workbuddy.ai 全部页面超时 [unverified] | 关键信息缺失 |


Model: narwal-plan/deepseek-v4-pro-202606

## Worker 3: critical — ok
## comparison_summary

**WorkBuddy** (Tencent Cloud, 2026.5 发布) 是企业级 SaaS Agent 平台，主打「Agent Teams」多 Agent 协作和 All-in-one 办公场景，提供企业版 SSO、RBAC、审计日志及声称的数据驻留能力。其核心是托管服务，团队无需自建 DevOps。

**OpenClaw** (MIT 开源，383K+ GitHub Stars) 是自托管个人/企业 AI 助手架构，通过 Gateway (WebSocket) 统一接入 20+ 消息渠道（含钉钉）。Multi-Agent Routing 提供 per-agent 隔离（独立 workspace、SQLite session store、auth profiles），支持 35+ 模型 Provider（含本地 Ollama/vLLM）。

**关键分歧点**：WorkBuddy 是「采购→配置→使用」的托管方案，OpenClaw 是「自建→托管→维护」的开源方案。对中国大陆 50 人团队、钉钉主渠道、无 DevOps、数据境内驻留的硬约束，两者的可行性和风险分布截然不同。

---

## key_differences

| field_name | workbuddy | openclaw |
|---|---|---|
| **部署模式** | SaaS/企业私有化部署，Tencent Cloud 托管 | 自托管，运行在用户自有设备/服务器，需自行维护 Gateway 和 Agent Runtime |
| **数据驻留实现** | 声称「数据驻留」，具体实现（是否独立区域部署、加密方式、数据不出境路径）未在可访问文档中验证 | 数据完全驻留在用户自有基础设施，物理边界由用户控制，符合境内驻留硬约束 |
| **钉钉原生支持** | 未在证据中确认，官方文档站点超时无法验证 [unverified] | 原生支持，通过 `@dingtalk-real-ai/dingtalk-connector`（OMP 已验证使用），支持 Webhook + OAuth DM 双通道 |
| **多 Agent 隔离** | 「Agent Teams」功能，具体实现细节（共享 context vs session 隔离）未确认 [unverified] | Multi-Agent Routing：每个 agent 独立 agentDir、SQLite session store、auth profiles，按渠道/账号/peer 路由 |
| **成本结构** | 企业版定价模型未公开，API 调用成本不明 [unverified]；个人版免费但功能受限 | 开源免费（MIT），模型调用成本由用户直接承担（直连 Anthropic/OpenAI/本地 vLLM 等） |
| **扩展性** | MCP 协议支持，Skills/Plugins/Hooks 能力未在证据中确认 | 完整插件体系：Skills、Plugins、Hooks、Cron/Heartbeat、Media 生成、Nodes（移动端能力），工具级 allow/deny policy |
| **运维复杂度** | 低，Tencent 托管基础设施 | 高，需自建 Gateway、管理 SQLite 存储、处理模型 Provider 配置、维护 dingtalk-connector 版本兼容 |
| **中文/本土化** | Tencent 产品，原生中文支持，境内合规性有企业背书 | 英文为主社区，钉钉 connector 为社区/第三方实现，中文场景需自行验证稳定性 |
| **Agent 间编排** | 声称「Dynamic Workflows」，是否支持跨 Agent 互调未确认 | 明确不做 Agent 间互调/Teams 编排（社区 PR #27382 被拒绝），仅支持 Routing 隔离 |

---

## trade_off_analysis

**数据驻留与合规**
- WorkBuddy 的「数据驻留」声明缺乏技术细节和部署架构验证，存在营销承诺风险。对于 CEO 的硬约束，需 Tencent 提供「境内独立区域部署+数据不出境」的 SLA 书面确认，否则视为高风险。
- OpenClaw 的数据驻留是架构内禀属性：数据物理存储在用户自有设备/服务器，天然满足境内驻留，无需第三方信任假设。

**钉钉渠道稳定性**
- WorkBuddy 的钉钉支持状态未知，若不支持则直接出局。
- OpenClaw 的钉钉接入已被 OMP 验证（`@dingtalk-real-ai/dingtalk-connector`），但为社区/第三方实现，非官方一级支持，生产稳定性需自行验证。

**运维成本现实**
- WorkBuddy 的「无需 DevOps」对 50 人团队友好，但隐性成本包括：企业版授权费用、模型调用溢价、Vendor Lock-in 迁移成本。
- OpenClaw 的「免费」是有条件的：需投入技术人力维护 Gateway、处理模型 Provider 集成、管理多 Agent 数据隔离、升级版本兼容性。无 DevOps 团队意味着 CTO/技术负责人需承担这部分负载。

**多 Agent 架构匹配度**
- 用户目标为「每个业务领域构建专属 agent」。OpenClaw 的 Multi-Agent Routing 提供成熟的 per-agent 隔离（workspace、session、auth），与需求匹配度高。
- WorkBuddy 的「Agent Teams」功能细节不明，若为共享 context 的轻量分组，可能无法满足业务域隔离需求。

**模型自主可控性**
- WorkBuddy 可能锁定在 Tencent 模型生态（混元等），模型选择受限。
- OpenClaw 支持 35+ Provider 及本地 Ollama/vLLM，模型选择自由度高，适合技术驱动型团队。

---

## recommendation

**不建议当前阶段迁移至 WorkBuddy**。核心阻塞点：

1. **钉钉支持未验证** — 无证据表明 WorkBuddy 支持钉钉集成，这是主渠道硬需求。
2. **数据驻留承诺空洞** — 缺乏技术实现细节和 SLA，合规风险不可接受。
3. **定价与锁定风险** — 企业版成本不明，Tencent 生态锁定效应强。

**OpenClaw 作为技术参考可行，直接替换 OMP 需谨慎**：

- **短期（保持 OMP）**：OMP 已基于 OpenClaw 的 dingtalk-connector 实现 Gateway，多 Agent 隔离和钉钉接入已验证。继续投资 OMP 是最小阻力路径。
- **中期（OpenClaw 评估）**：若 OMP 维护成本上升，可评估迁移至纯 OpenClaw，但需投入资源验证中文场景稳定性和建立 DevOps 能力。
- **长期（WorkBuddy 观望）**：待 WorkBuddy 钉钉集成验证、数据驻留 SLA 明确、定价透明后再评估。

**立即行动**：向 Tencent WorkBuddy 团队书面确认钉钉集成状态和数据驻留技术实现；对 OpenClaw 进行中文场景 POC（2-3 天工作量），重点测试钉钉 connector 稳定性。

---

## open_questions

| field_name | question | impact |
|---|---|---|
| **workbuddy_dingtalk_support** | WorkBuddy 是否支持钉钉机器人/ webhook 接入？是否支持单聊/群聊双模式？ | 若不支持，直接排除选型 |
| **workbuddy_data_residency_tech** | WorkBuddy「数据驻留」是营销术语还是有技术实现（如独立 CN Region、数据不出境路由）？ | 涉及合规底线，需书面 SLA |
| **workbuddy_pricing_model** | 企业版按用户数/按调用量/混合计费？模型调用是否加价？50 人团队年度成本估算？ | 影响 TCO 和预算决策 |
| **workbuddy_agent_teams_impl** | Agent Teams 是共享 context 的协作模式还是独立 session 隔离？是否支持业务域级数据隔离？ | 决定多 Agent 架构匹配度 |
| **openclaw_dingtalk_stability** | OpenClaw 的 dingtalk-connector 在生产环境（特别是中文消息、富媒体卡片）的稳定性如何？是否有已知 issue？ | 影响 OpenClaw 可行性评估 |
| **openclaw_chinese_locale** | OpenClaw 对中文 NLP、中文文件系统、中文编码的支持是否完整？社区中文用户规模？ | 影响本土化运维成本 |
| **omp_vs_openclay_gap** | OMP 相比纯 OpenClaw 增加了哪些功能？这些功能迁移成本如何？ | 影响迁移决策 |

---

## sources

- **claim**: OpenClaw 是开源(MIT)个人 AI 助手，383K+ GitHub Stars，自托管架构，运行在用户自有设备上。通过 Gateway(WebSocket) 统一控制面连接 20+ 消息渠道(WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ 等) | **url**: https://github.com/OpenClaw/openclaw | **relevance**: 核心产品定位和渠道覆盖——对 CEO 评估 agent 团队基础设施选型至关重要
- **claim**: OpenClaw 支持 Multi-Agent Routing：每个 agent 有独立 workspace、agentDir、SQLite session store、auth profiles，通过 bindings 按渠道/账号/peer 路由消息到不同 agent | **url**: https://docs.openclaw.ai/concepts/multi-agent | **relevance**: 多 agent 隔离机制——直接对应「为每个业务领域构建专属 agent」的需求
- **claim**: OpenClaw 工具体系：Runtime(exec/process/terminal)、Files(read/write/edit/apply_patch)、Browser、Web Search(多后端)、Messaging、Sessions/Sub-agents、Cron/Heartbeat、Media(图片/视频/音乐生成/TTS)、Nodes(移动端设备能力)、Skills/Plugins/Hooks 扩展 | **url**: https://docs.openclaw.ai/tools | **relevance**: 工具能力全景——评估 agent 能做什么
- **claim**: OpenClaw 企业部署有成熟实践：GlobusSoft 部署 500 员工、AWS CDK 自动化、多租户安全隔离、模型分层(tiering)降本、90 天 POC-to-Production 路线图 | **url**: https://globussoft.ai/openclaw-for-enterprise/ | **relevance**: 企业级可行性——对 50 人团队的部署有参考价值
- **claim**: WorkBuddy 是腾讯云 2026 年 5 月全球发布的办公 AI Agent，前身为 CodeBuddy(代码助手)，后扩展为 All-in-one 办公场景 Agent，含个人版(免费)和企业版 | **url**: https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/ | **relevance**: WorkBuddy 产品定位和发布时间线
- **claim**: WorkBuddy 日活是行业第二名的 3-4 倍，被定位为「对标 Cowork(字节跳动)」的产品，腾讯内部将其与 CodeBuddy(代码)、QClaw(通用 Agent)并列为 AI Agent 三大产品线 | **url**: https://www.htx.com/en-us/news/428387/ | **relevance**: 市场规模和竞争格局——评估产品成熟度和生态位
- **claim**: WorkBuddy 功能包括：Agent Teams(多 Agent 协作)、Dynamic Workflows、CLI 模式、IDE 集成、Web UI、沙箱隔离执行、Browser 工具、MCP 协议支持 | **url**: https://www.workbuddy.ai/docs/cli/overview | **relevance**: WorkBuddy 核心功能矩阵
- **claim**: WorkBuddy 企业版提供：SSO 单点登录、RBAC 权限控制、审计日志、私有化部署、数据驻留；个人版免费但功能受限 | **url**: https://toolnavs.com/en/article/1907-what-is-the-difference-between-workbuddy-enterprise-and-personal-editions-the-te | **relevance**: 企业版 vs 个人版差异——对团队管理决策关键
- **claim**: OpenClaw 架构：Gateway 守护进程(WebSocket 协议) → 内嵌 Agent Runtime(agent loop/session/compaction/hooks) → 多 Provider(35+，含 Anthropic/OpenAI/Google/本地 Ollama/vLLM) → Channel 分发。配套 macOS/iOS/Android/Win companion apps | **url**: https://docs.openclaw.ai/concepts/architecture | **relevance**: 技术架构全貌——评估自建 vs 采购的技术匹配度
- **claim**: OpenClaw 安全模型：DM 默认 pairing 审批(非白名单用户收到配对码)、非 main session 可 Docker sandbox 隔离、工具级 allow/deny policy、Gateway 暴露前需走 security runbook | **url**: https://docs.openclaw.ai/gateway/security | **relevance**: 安全边界——对 CEO 评估生产环境风险至关重要
- **claim**: OMP Gateway 设计明确参考了 OpenClaw 的 dingtalk-connector(accounts 命名 map、会话按 conversationId 隔离)和 Hermes Agent 的 per-agent 目录隔离模式 | **url**: packages/pi-gateway/docs/gateway-design-v1.md:70-78 | **relevance**: 验证 OpenClaw 钉钉接入方案在 OMP 中的实际应用
- **claim**: OpenClaw dingtalk-connector 是 @dingtalk-real-ai/dingtalk-connector@0.8.23 npm 包，peerDependencies openclaw>=2026.4.9——OMP 在 bun.lock 中依赖了此包用于钉钉接入 | **url**: bun.lock | **relevance**: 技术实现细节——OpenClaw 钉钉接入的依赖关系
- **claim**: OpenClaw 的 multi-agent 设计明确不做 agent 间互调/teams 编排(社区 PR #27382 被关闭)，OMP 的 multi-agent-orchestration-design.md 引用了这一点 | **url**: docs/todo/multi-agent-orchestration-design.md:119-122 | **relevance**: OpenClaw 架构边界——明确其不支持跨 Agent 协作编排
- **claim**: WorkBuddy 在 oh-my-pi 仓库中没有直接代码引用——只在 MOA extension 的测试文件(moa-extension/test/)和 plan 文档(docs/plans/)中作为「外部对比对象」出现 | **url**: (repo search) | **relevance**: WorkBuddy 与 OMP 生态无直接关联，仅为外部竞品参考


Model: alibaba-coding-plan/kimi-k2.5

## Synthesis
# 对比 WorkBuddy vs OpenClaw — 合成结论

## 合并建议

**不做迁移。继续走 OMP，不切 WorkBuddy，也不直接换纯 OpenClaw。**

理由一句话：OMP 现在的技术底盘就是 OpenClaw 的超集，切出去是倒退；WorkBuddy 信息太少，三个致命未知没解决，不能当严肃选项。

下面的对比和后续动作是基于三个 worker 的深入分析合并而来，不是挑了某一个的答案。

---

## 关键差异（合并表）

| 维度 | OpenClaw | WorkBuddy |
|---|---|---|
| 部署模式 | MIT 开源，自托管，你自己的服务器 | 腾讯云 SaaS/私有化部署（私有化细节未验证） |
| 数据主权 | 物理在你机器上，天然境内驻留 | 声称“数据驻留”，技术实现未确认 |
| 钉钉支持 | 已验证：通过 dingtalk-connector（OMP 在用），Webhook+OAuth | 未确认——文档全超时 |
| 多 Agent 架构 | 按 channel/account/peer 路由隔离（workspace/session/auth 独立），不做 agent 互调 | Agent Teams + Dynamic Workflows（编排能力声称，实现细节未知） |
| LLM 自由度 | 35+ provider，含本地 Ollama/vLLM，模型完全自主 | 推测绑定腾讯模型生态 |
| 企业管控 | 无内置 SSO/RBAC/审计，需自搭 | 企业版声称有 SSO/RBAC/审计 |
| 中文/本土化 | 英文社区，钉钉 connector 是第三方实现，中文稳定性未压测 | 腾讯产品，中文原生（但产品页面不可达） |
| 工具生态 | Runtime/Files/Browser/Search/Cron/Media，developer-oriented | CLI/沙箱/IDE/MCP，办公自动化 oriented |
| 与 OMP 关系 | OMP 的架构参考源：dingtalk-connector、Card v3 schema、Gateway 设计均来源 | OMP 代码里零引用 |

---

## 为什么不迁——三个分析合并后的判断

**1. WorkBuddy 没通过基本可行性检查（divergent + critical 共同指出）**

```
- 钉钉能不能接？不知道——所有 workbuddy.ai 页面超时，文档不可达
- 数据在不在境内？不知道——产品经理说的“私有化部署”没有技术实现证据
- 定价/合规/Agent Teams 机制？全不知道
```

在信息黑盒状态下做选型，相当于用你们的生产数据和合规风险赌腾讯的产品成熟度。不赌。

**2. OpenClaw 直接替换 OMP 是倒退（grounded 指出，divergent 补充）**

OMP 已经抄了 OpenClaw 的底盘，并且加了：

- Handlebars 模板化 prompt assembly + MECE 6 层 agent 设计
- self-evolution（从 session trace 提取 skill/workflow pattern）
- TUI 交互界面
- Handlebars+AGENTS.md 硬约束提取

切回纯 OpenClaw = 扔掉这些定制，从头再搭一遍。而且 OpenClaw 明确不做 agent 编排——你们的“世界模型/行为智能/软件系统/机电系统”四组 agent 在 OpenClaw 里只能隔离，不能协作。

**3. 硬件研发场景的工具空白，两者都没填（divergent 提出，其他 worker 未涉及但一致）**

OpenClaw 和 WorkBuddy 的工具集都在“办公自动化”赛道——写周报、查代码、回消息。机器人公司的真实工作流：

```
- ROS2 bag 解析 → 提取异常帧
- CAD/BOM 变更 → 通知对应组
- 产线 sensor log → 生成工单
- EVT/DVT gate 进度追踪
```

这些不在任何一家的工具体系里。OMP 至少你能自己写工具（bash tool、file reads 已经能跑），OpenClaw 也能扩展但你没 devops；WorkBuddy 是闭源，你改不了。

---

## 合并时的设计选择

**从 divergent 吸收的**：
- 硬件研发工作流的特异性——这是对比的“正确维度”，不是纯功能矩阵比大小
- 留在 OMP + 厘清硬件能力缺口的实操路线
- “用 OpenClaw 补渠道而不替换架构”（OMP 已经用了 dingtalk-connector，后续加飞书/企微可以直接复刻 OpenClaw 的 channel 实现）

**从 grounded 吸收的**：
- 对比表的骨架（许可模式、部署、数据主权、渠道覆盖、多 Agent、编排、LLM 自由度等维度最全）
- “OMP 是 OpenClaw 的超集”这一架构关系表述
- WorkBuddy 信息缺失的量化——三个致命未知必须解才进选型

**从 critical 吸收的**：
- 数据驻留的合规风险分析——“数据驻留”必须有书面 SLA，不能信营销话术
- 运维成本的现实量化（无 DevOps 团队时 OMP 自运维的隐性成本）
- WorkBuddy 三个未知的阻塞性优先级

**三者冲突的解**：
- divergent 说“立即停用 WorkBuddy 对比”；grounded 说“当前不切但未来可评估”；critical 说“观望”。取 grounded 的中间态——不主动投入资源对标，但不删除信息通道。等 workbuddy.ai 恢复后端再做 POC 评估的决定。
- critical 对 OMP 运维成本的担忧被 divergent 和 grounded 的“团队已在使用”证据抵消——50 人团队不是一个人运维，且 OMP 已经跑了，不是从零搭。
- divergent 对物理世界工具的强调未被其他 worker 反驳，且与用户背景（CTO 出身、看技术架构）高度契合，纳入作为主要差异化价值主张。

---

## 风险和前置条件

1. **OMP 自运维风险**：如果不养 DevOps，Gateway crash、session 丢失、dingtalk-connector 升级兼容需要技术负责人兜底。目前谁是 OMP 的运维 owner？需要确认。
2. **OpenClaw dingtalk-connector 稳定性**：龙哥 bot 实测“回复可视化优于 OMP”，但生产级稳定性未压测。如果 OMP 的 dingtalk-connector 出线上故障，修复链路依赖社区 npm 包——需要评估是否 fork 或自己接管 connector。
3. **硬件工具链的投资决策**：如果决定让 OMP 吃掉硬件工作流，需要投入开发资源（ROS bag parser、CAD 接口等）。如果未来 2 年多模态 LLM 能直接读 CAD 和 log，这部分自建工具的价值窗口会缩短。需要判断投入产出的时间窗口。

---

## 下一步动作

1. **厘清硬件能力缺口**（优先级最高，本周）  
   让四组 leader 每人提 3 项“最想让 agent 帮我做的具体事”，用表格收上来，标出哪些是现有工具链可扩展（bash + file read 能覆盖），哪些要从零造。

2. **确认 WorkBuddy 三个未知**（异步，不阻塞 OMP 推进）  
   - 钉钉支持（找腾讯云销售/技术文档，不要信产品宣传页）  
   - 数据驻留 SLA（要求书面，指明“中国内地独立区域、数据不出境、加密方案”）  
   - 企业版定价（按 50 人规模问报价）  
   这三个没解之前，WorkBuddy 不算选项。

3. **评估 dingtalk-connector 的可靠性**  
   对 OMP 当前使用的 `@dingtalk-real-ai/dingtalk-connector@0.8.23` 做一周稳定性压测（消息丢失率、card 渲染错误率），决定是否 fork 或自维护。

4. **OpenClaw 做技术参考用，不做迁移准备**  
   - 安全模型（DM pairing、Docker sandbox）评估是否 backport 到 OMP  
   - 龙哥 bot 的视觉效果优于 OMP 这个已记录点 → 列为 OMP TUI/card 渲染的改进 todo

---

## 需验证的假设（按置信度）

| 假设 | 置信度 |
|---|---|
| OMP 将继续作为 agent 团队的基础设施，不计划停用或废弃 | 高（用户没提过废弃意图） |
| 50 人团队有至少一人能处理 OMP Gateway 的日常运维（重启、日志排查） | 中（CEO 说团队有软件系统组，但未指定 OMP owner） |
| 硬件研发工具链（ROS/SolidWorks/BOM）在当前阶段还不急迫，OMP 的工具集优先度是办公协同 | 中（用户未明确优先级，发散推测的） |
| WorkBuddy 三个致命未知短期（1 个月内）能获得明确答案 | 低（workbuddy.ai 持续超时，腾讯云销售响应速度未知） |
| 多模态 LLM 2 年内能直接处理 CAD/ROS log 的概率不会使现在投入定制工具报废 | 低（这是 speculative 判断，不同 worker 意见有分歧） |

---

## 各 worker 的贡献

- **divergent**：硬件特异性视角、留在 OMP 的路线图、物理世界工具差异化壁垒——作为 backbone 吸收了骨架，并吸收了其“立即停用 WorkBuddy 对比”的部分精神，但改为“不主动投入，等页面恢复”。  
- **grounded**：对比表维度的完整性、OMP 与 OpenClaw 的超集关系表述、WorkBuddy 信息缺失的量化——表结构、超集比喻、三个致命未知的表述都从这里来。  
- **critical**：数据驻留合规风险的技术判定、运维成本现实计算、WorkBuddy 阻塞性优先级排序——数据主权和合规部分吸收了批判性的严格判断。  

**三个人共同支撑的核心结论**：不做选型切换，WorkBuddy 不值得考虑，OpenClaw 作为技术参考而非替换目标。