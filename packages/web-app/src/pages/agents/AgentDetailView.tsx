import type {
	HostToolDefinitionDto,
	SkillScopeRowDto,
	SkillsResultDto,
	ToolSwitchDto,
	ToolSwitchesDto,
} from "@cornfield/wire";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentPromptSourceDto, GatewayAccountPatchDto, GatewayGroupInfo } from "../../lib/pi-client-api";
import { SCOPE_LABELS } from "../../lib/scope-display";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	SKILL_ACTIVATION_LABELS,
	SKILL_STATUS_LABELS,
	skillStatusClass,
	skillVersionText,
} from "../skills/skill-display";
import { FileExplorer } from "../workspace/FileExplorer";
import { KindBadge } from "./AgentsView";
import { ModelPicker } from "./ModelPicker";

/**
 * Agent 详情（FR-2）—— 7 tab：Skills / 钉钉 / 模型 / 工具 / 画像 / 文件 / Prompts。
 * 数据源：Skills 读 serve get_skills（与「技能」页同一份结果）、画像读 mission.md+user.md、
 * Prompts 读 get_agent_prompt_sources（agentDir 的 prompt 面，serve 侧单一真相）+ fs_read 读正文、
 * 模型接 get_available_models/set_model 真命令、画像实时建模待连接器路径（缺口 B5）。
 */

type TabId = "skills" | "dingtalk" | "model" | "tools" | "profile" | "files" | "prompts";

const TABS: { id: TabId; label: string }[] = [
	{ id: "skills", label: "Skills" },
	{ id: "dingtalk", label: "钉钉" },
	{ id: "model", label: "模型配置" },
	{ id: "tools", label: "工具开关" },
	{ id: "profile", label: "用户画像" },
	{ id: "files", label: "文件" },
	{ id: "prompts", label: "Prompts" },
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];

export function AgentDetailView({ agentId, onClose }: { agentId: string; onClose: () => void }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [tab, setTab] = useState<TabId>("skills");
	// C3：host tool 注册态（set_host_tools 真命令本地权威态；snapshot 无工具开关数据，wire 面未提供）
	const [hostTools, setHostToolsState] = useState<HostToolDefinitionDto[]>(() => store.getHostTools());
	const [newHostName, setNewHostName] = useState("");
	const [newHostDesc, setNewHostDesc] = useState("");

	const registerHostTool = () => {
		const name = newHostName.trim();
		if (!name) return;
		const next = [
			...hostTools.filter(t => t.name !== name),
			{ name, description: newHostDesc.trim() || `host tool ${name}`, parameters: {} },
		];
		setHostToolsState(next);
		store.setHostTools(next);
		setNewHostName("");
		setNewHostDesc("");
	};

	const unregisterHostTool = (name: string) => {
		const next = hostTools.filter(t => t.name !== name);
		setHostToolsState(next);
		store.setHostTools(next);
	};

	const agent = view.agents.find(a => a.id === agentId);
	const name = agent?.name ?? (view.agents.length === 0 ? "等待 Agent 注册表" : "未知 Agent");
	// 当前模型（裸 id，与「模型配置」tab 的 Provider/Model 两个下拉同源：AgentDetailView → ModelPicker）。
	const currentModel = agent?.model ?? view.model ?? "";

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-narrow">
				{/* 头部（编辑式排版，无装饰图形） */}
				<div className="mb-8">
					<div className="mb-2.5 flex items-center gap-2 text-[12px] text-ink-subtle">
						<span
							className={`h-2 w-2 rounded-full ${agent?.status === "busy" ? "bg-warning animate-pulse" : agent?.status === "idle" || agent?.status === "online" ? "bg-success" : "bg-ink-faint"}`}
						/>
						{agent ? `${statusText(agent.status)} · 最近活跃 ${agent.lastAction ?? "—"}` : "会话未注册"}
						{agent?.dingtalk?.enabled && (
							<span
								className="badge done"
								title={`钉钉机器人：${agent.dingtalk.robotName ?? agent.dingtalk.appKey ?? "未命名"}（gateway.json accounts）`}
							>
								钉钉已绑定{agent.dingtalk.robotName ? ` · ${agent.dingtalk.robotName}` : ""}
							</span>
						)}
						{agent?.dingtalk && !agent.dingtalk.enabled && (
							<span className="badge fail" title="gateway.json 中该账号已停用">
								钉钉已停用
							</span>
						)}
						<button
							type="button"
							onClick={onClose}
							aria-label="关闭详情"
							title="关闭详情"
							className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
						>
							<X size={16} strokeWidth={1.8} />
						</button>
					</div>
					<div className="flex items-baseline gap-4">
						<h1 className="text-[32px] font-semibold leading-snug tracking-[-0.8px] text-ink">{name}</h1>
						<span
							data-testid="agent-model-badge"
							className="rounded bg-accent-dim px-2.5 py-1 font-mono text-[12px] text-ink"
						>
							{currentModel}
						</span>
						{agent && <KindBadge kind={agent.kind} />}
					</div>
					<div className="mt-2 text-[15px] text-ink-subtle">
						{agent ? `${agent.workspace} · 最近活跃 ${agent.lastAction ?? "—"}` : "等待 Agent 注册表推送"}
					</div>
				</div>

				{/* 5 tabs */}
				<div className="mb-7 flex gap-0.5 border-b border-hairline">
					{TABS.map(t => (
						<button
							key={t.id}
							type="button"
							className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13px] font-medium transition-colors ${tab === t.id ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
							onClick={() => setTab(t.id)}
						>
							{t.label}
							{t.id === "skills" && agent?.skillsCount !== undefined && (
								<span className="ml-1 text-2xs text-ink-faint">{agent.skillsCount}</span>
							)}
						</button>
					))}
				</div>

				{tab === "skills" && <AgentSkillsTab agentId={agentId} />}

				{tab === "dingtalk" && <DingtalkView agentId={agentId} />}

				{tab === "model" && (
					<div>
						<h4 className="mb-3.5 section-title text-ink-faint">模型选择</h4>
						<div className="flex max-w-[420px] flex-col gap-2.5">
							{/* Provider / Model 两个下拉（含目录读取态）：真数据路径在 ModelPicker.tsx；key 换 agent 重挂。 */}
							<ModelPicker key={agentId} agentId={agentId} currentModel={currentModel} />
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Thinking</span>
								<select
									value={view.thinkingLevel ?? "off"}
									onChange={e => store.setThinkingLevel(e.target.value, agentId)}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{THINKING_LEVELS.map(l => (
										<option key={l}>{l}</option>
									))}
								</select>
							</label>
						</div>
						<div className="mt-4 text-[11px] text-ink-faint">context 与 token 用量待 get_session_stats 接入</div>
					</div>
				)}

				{tab === "tools" && (
					<div className="flex flex-col gap-8">
						<section>
							<h4 className="mb-3 section-title text-ink-faint">内核工具开关（写该 agent 生效的那层配置）</h4>
							<ToolSwitchesView agentId={agentId} />
						</section>
						<section>
							<h4 className="mb-3 section-title text-ink-faint">
								host 工具注册（前端声明，运行时生效，不落盘）
							</h4>
							{hostTools.length === 0 ? (
								<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
									尚未注册任何 host 工具。host tool 由前端声明（如浏览器/桌面能力），声明后 LLM 可调用，
									执行结果经 host_tool_result 帧回传（pi-client 裸帧能力待补）。
								</div>
							) : (
								<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
									{hostTools.map(t => (
										<div key={t.name} className="flex items-center gap-3 px-4 py-2.5">
											<span className="min-w-0 flex-1">
												<span className="block font-mono text-[13px] text-ink">{t.name}</span>
												<span className="block truncate text-[11px] text-ink-faint">{t.description}</span>
											</span>
											<button
												type="button"
												className="btn btn-secondary btn-sm shrink-0"
												onClick={() => unregisterHostTool(t.name)}
											>
												移除
											</button>
										</div>
									))}
								</div>
							)}
							<div className="mt-4 flex items-center gap-2">
								<input
									value={newHostName}
									onChange={e => setNewHostName(e.target.value)}
									placeholder="工具名（如 browser_capture）"
									className="min-w-0 flex-1 rounded border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
								/>
								<button type="button" className="btn btn-sm shrink-0" onClick={registerHostTool}>
									注册
								</button>
							</div>
							<div className="mt-3 text-[11px] text-ink-faint">
								set_host_tools 已实现：注册后 serve 推 host_tool_call 帧 → 前端执行 → host_tool_result
								回传（pi-client 裸帧发送待补）。
							</div>
						</section>
					</div>
				)}

				{tab === "profile" && <ProfileView agentId={agentId} />}

				{tab === "files" && (
					// Agent 详情页浏览的是**这个 Agent 自己根上的附件**：未绑 Project 的附件地址
					// 就是 Agent 名（T26 保证），所以 wire 身份与展示 Agent 在这里同值 —— 两个入参
					// 不是重复，是把“在哪个根里”与“是谁的”各自说清（工作台右栏两者不同）。
					<FileExplorer attachmentAddress={agentId} agentId={agentId} />
				)}

				{tab === "prompts" && <PromptsView agentId={agentId} />}

				<div className="mt-6">
					<button
						type="button"
						className="text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
						onClick={onClose}
					>
						← 返回 Agent 列表
					</button>
				</div>
			</div>
		</div>
	);
}

function statusText(status?: string): string {
	switch (status) {
		case "online":
			return "运行中";
		case "busy":
			return "执行中";
		case "idle":
			return "空闲";
		case "stopped":
			return "已停用";
		default:
			return "状态未知";
	}
}

// ─────────────────────────────────────────────────────────────────────
// 钉钉 tab：agent 绑定的机器人配置（gateway.json channels.dingtalk.accounts）
// 可编辑白名单：enabled/robotName/agentDir/deniedTools/hideThinkingBlock。
// 保存 → set_gateway_account → gateway 进程内 reload（热生效，不重启）。
// 凭证（appSecret/appKey）不可在此编辑 —— 走 `$ENV_VAR` 引用或 setup 向导。
// ─────────────────────────────────────────────────────────────────────

const DYNAMIC_TOOL_OPTIONS = [
	"ast_edit",
	"lsp",
	"debug",
	"notebook",
	"recipe",
	"irc",
	"github",
	"ssh",
	"inspect_image",
	"browser",
	"render_mermaid",
];

function DingtalkView({ agentId }: { agentId: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const agent = view.agents.find(a => a.id === agentId);
	const dt = agent?.dingtalk;
	// 草稿态（用户本次未保存的编辑）
	const [deniedDraft, setDeniedDraft] = useState<string[] | null>(null);
	const [robotNameDraft, setRobotNameDraft] = useState<string | null>(null);
	const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
	const [hideThinkingDraft, setHideThinkingDraft] = useState<boolean | null>(null);
	const [agentDirDraft, setAgentDirDraft] = useState<string | null>(null);
	// 已保存态（本地权威）：保存成功后写入，覆盖 serve 陈旧快照（dt 只在 serve 启动时读一次
	// gateway.json，disable 后不会自动刷新 —— 不回落到 dt 是「保存后 toggle 弹回」的修复）。
	const [savedDenied, setSavedDenied] = useState<string[] | null>(null);
	const [savedRobotName, setSavedRobotName] = useState<string | null>(null);
	const [savedEnabled, setSavedEnabled] = useState<boolean | null>(null);
	const [savedHideThinking, setSavedHideThinking] = useState<boolean | null>(null);
	const [savedAgentDir, setSavedAgentDir] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const [groups, setGroups] = useState<GatewayGroupInfo[] | null>(null);

	// 拉 gateway_status 取启停态 + 群列表；每 15s 刷新（群列表动态变化）。
	useEffect(() => {
		if (!view.connected) return;
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const s = await store.gatewayStatus();
				if (cancelled || s.stale) return;
				const account = s.accounts.find(a => a.accountId === agentId);
				if (account) {
					setSavedEnabled(true);
					setGroups((account.groups ?? []).filter(g => g.channelId === "dingtalk"));
				} else {
					setSavedEnabled(false);
					setGroups(null);
				}
			} catch {
				// gateway 未运行 → 保留 serve 快照兜底，不覆盖
			}
		};
		void load();
		const t = setInterval(() => {
			if (view.connected) void load();
		}, 15_000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, [agentId, store, view.connected]);

	if (!dt) {
		return (
			<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-8 text-center text-[12px] text-ink-faint">
				该 agent 未绑定钉钉机器人（~/.cornfield/gateway.json → channels.dingtalk.accounts 无对应账号）
			</div>
		);
	}

	// 显示值：草稿 > 已保存（本地权威）> serve 快照（初始兜底）
	const denied = deniedDraft ?? savedDenied ?? dt.deniedTools ?? [];
	const robotName = robotNameDraft ?? savedRobotName ?? dt.robotName ?? "";
	const enabled = enabledDraft ?? savedEnabled ?? dt.enabled ?? true;
	const hideThinking = hideThinkingDraft ?? savedHideThinking ?? dt.hideThinkingBlock ?? false;
	const agentDir = agentDirDraft ?? savedAgentDir ?? agent?.agentDir ?? "";

	/** 提交 patch（仅变更的字段）+ 触发 gateway 热生效。 */
	const save = async (): Promise<void> => {
		setSaving(true);
		setSaveMsg(null);
		const patch: GatewayAccountPatchDto = {};
		if (deniedDraft !== null) patch.deniedTools = deniedDraft;
		if (robotNameDraft !== null) patch.robotName = robotNameDraft;
		if (enabledDraft !== null) patch.enabled = enabledDraft;
		if (hideThinkingDraft !== null) patch.hideThinkingBlock = hideThinkingDraft;
		if (agentDirDraft !== null) patch.agentDir = agentDirDraft;
		try {
			const res = await store.setGatewayAccount(agentId, patch);
			// 成功后：草稿写入已保存态（本地权威，不回落到陈旧快照），清空草稿
			if (deniedDraft !== null) setSavedDenied(deniedDraft);
			if (robotNameDraft !== null) setSavedRobotName(robotNameDraft);
			if (enabledDraft !== null) setSavedEnabled(enabledDraft);
			if (hideThinkingDraft !== null) setSavedHideThinking(hideThinkingDraft);
			if (agentDirDraft !== null) setSavedAgentDir(agentDirDraft);
			setDeniedDraft(null);
			setRobotNameDraft(null);
			setEnabledDraft(null);
			setHideThinkingDraft(null);
			setAgentDirDraft(null);
			setSaveMsg({ ok: res.ok, text: res.ok ? "已保存并热生效（gateway 未重启）" : "保存失败" });
		} catch (err) {
			setSaveMsg({ ok: false, text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
		} finally {
			setSaving(false);
		}
	};

	const dirty =
		deniedDraft !== null ||
		robotNameDraft !== null ||
		enabledDraft !== null ||
		hideThinkingDraft !== null ||
		agentDirDraft !== null;
	const toggleDenied = (tool: string): void => {
		setDeniedDraft(prev => {
			const base = prev ?? savedDenied ?? dt.deniedTools ?? [];
			return base.includes(tool) ? base.filter(t => t !== tool) : [...base, tool];
		});
	};

	// 只读区：凭证信息（不可编辑）
	const readOnlyRows: [string, string][] = [
		["appKey", dt.appKey ?? "—"],
		["robotCode", dt.robotCode ?? "—"],
	];

	return (
		<div className="flex max-w-[640px] flex-col gap-6">
			<section>
				<h4 className="mb-2 section-title text-ink-faint">启停与身份</h4>
				<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
					<div className="flex items-center gap-3 px-4 py-2.5">
						<span className="w-[120px] shrink-0 text-[12px] text-ink-subtle">启用</span>
						<span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-ink">
							<button
								type="button"
								role="switch"
								aria-checked={enabled}
								className={`toggle shrink-0 ${enabled ? "on" : ""}`}
								onClick={() => setEnabledDraft(!enabled)}
							/>
							<span className="text-[11px] text-ink-faint">
								关闭后该账号钉钉断连 + bridge 停止（保存即热生效，不重启 gateway）
							</span>
						</span>
					</div>
					<div className="flex items-center gap-3 px-4 py-2.5">
						<label className="w-[120px] shrink-0 text-[12px] text-ink-subtle" htmlFor={`dt-robotname-${agentId}`}>
							机器人名
						</label>
						<input
							id={`dt-robotname-${agentId}`}
							value={robotName}
							onChange={e => setRobotNameDraft(e.target.value)}
							placeholder="M-HR"
							className="min-w-0 flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
						/>
					</div>
					<div className="flex items-center gap-3 px-4 py-2.5">
						<label className="w-[120px] shrink-0 text-[12px] text-ink-subtle" htmlFor={`dt-agentdir-${agentId}`}>
							agentDir
						</label>
						<input
							id={`dt-agentdir-${agentId}`}
							value={agentDir}
							onChange={e => setAgentDirDraft(e.target.value)}
							placeholder="/Users/.../OMP-workspace-test/mcode"
							className="min-w-0 flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
						/>
					</div>
					<div className="flex items-center gap-3 px-4 py-2.5">
						<span className="w-[120px] shrink-0 text-[12px] text-ink-subtle">隐藏思考块</span>
						<button
							type="button"
							role="switch"
							aria-checked={hideThinking}
							className={`toggle shrink-0 ${hideThinking ? "on" : ""}`}
							onClick={() => setHideThinkingDraft(!hideThinking)}
						/>
					</div>
					{readOnlyRows.map(([k, v]) => (
						<div key={k} className="flex items-center gap-3 px-4 py-2.5">
							<span className="w-[120px] shrink-0 text-[12px] text-ink-subtle">{k}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{v}</span>
						</div>
					))}
				</div>
			</section>

			{/* 所在群列表（来自 gateway sessions.db，按 channelId 过滤；未来可扩展飞书等通道） */}
			<section>
				<h4 className="mb-2 section-title text-ink-faint">
					所在群（钉钉）
					{groups !== null && <span className="ml-1 text-2xs text-ink-faint">{groups.length} 群</span>}
				</h4>
				{groups === null ? (
					<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
						gateway 未运行或该账号未连接
					</div>
				) : groups.length === 0 ? (
					<div className="rounded-lg border border-dashed border-hairline-strong bg-surface px-4 py-6 text-center text-[12px] text-ink-faint">
						暂无群会话——机器人收到群消息后自动补充
					</div>
				) : (
					<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
						{groups.map(g => (
							<div key={g.conversationId} className="flex items-center gap-3 px-4 py-2.5">
								<span className="min-w-0 flex-1">
									<span className="block text-[13px] text-ink">{g.title}</span>
									<span className="block truncate font-mono text-[11px] text-ink-faint">
										{g.conversationId}
									</span>
								</span>
								<span className="shrink-0 text-[11px] text-ink-faint">
									{new Date(g.lastActive).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
								</span>
							</div>
						))}
					</div>
				)}
				<div className="mt-2 text-[11px] text-ink-faint">
					仅显示机器人收到过消息的群；运行 cornfield-gateway robot-context probe 可主动探测全量群
				</div>
			</section>

			<section>
				<h4 className="mb-2 section-title text-ink-faint">工具黑名单（deniedTools，账号级）</h4>
				<div className="flex flex-wrap gap-1.5 rounded-lg border border-hairline bg-surface p-3">
					{DYNAMIC_TOOL_OPTIONS.map(tool => {
						const isDenied = denied.includes(tool);
						return (
							<button
								key={tool}
								type="button"
								onClick={() => toggleDenied(tool)}
								className={`cursor-pointer rounded px-2 py-1 font-mono text-[11px] transition-colors ${
									isDenied
										? "bg-danger-dim text-ink"
										: "border border-hairline bg-surface-2 text-ink-subtle hover:bg-surface"
								}`}
							>
								{tool}
							</button>
						);
					})}
				</div>
				<div className="mt-2 text-[11px] text-ink-faint">
					黑名单内的工具对 LLM 不可见（账号级；与内核 config.yml 工具开关是两个面）
				</div>
			</section>

			<section className="flex items-center gap-3">
				<button
					type="button"
					className="btn btn-sm shrink-0"
					onClick={() => void save()}
					disabled={saving || !dirty}
				>
					{saving ? "保存中…" : dirty ? "保存并生效" : "已同步"}
				</button>
				{saveMsg && (
					<span className={`text-[12px] ${saveMsg.ok ? "text-success" : "text-danger"}`}>{saveMsg.text}</span>
				)}
				{dirty && <span className="text-[11px] text-ink-faint">有未保存修改</span>}
			</section>

			<div className="mt-1 text-[11px] text-ink-faint">
				配置来源：~/.cornfield/gateway.json → channels.dingtalk.accounts（按 accountId 匹配 agent）。appSecret
				不展示、不可在此修改（凭证走 `$ENV_VAR` 引用或 setup 向导）。
			</div>
		</div>
	);
}

const PYTHON_MODES: Array<{ value: ToolSwitchesDto["pythonToolMode"]; label: string }> = [
	{ value: "both", label: "both — bash + Python 双模式" },
	{ value: "bash-only", label: "bash-only — 仅 shell" },
	{ value: "ipy-only", label: "ipy-only — 仅 Python" },
];

/** 内核工具开关（get_tool_switches 真读合并视图 + set_config 写回生效层）。 */
function ToolSwitchesView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [switches, setSwitches] = useState<ToolSwitchesDto | null>(null);
	const [saving, setSaving] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉，避免 get_tool_switches 在握手期失败
		const load = async (): Promise<void> => {
			try {
				const dto = await store.getToolSwitches(agentId);
				if (!cancelled) setSwitches(dto);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	const setEnabled = (tool: ToolSwitchDto, enabled: boolean): void => {
		// optimistic 更新；失败回滚
		setSwitches(prev =>
			prev ? { ...prev, tools: prev.tools.map(t => (t.tool === tool.tool ? { ...t, enabled } : t)) } : prev,
		);
		setSaving(tool.tool);
		void store
			.setConfig(agentId, tool.path, enabled)
			.then(() => setSaving(null))
			.catch(err => {
				setSwitches(prev =>
					prev
						? { ...prev, tools: prev.tools.map(t => (t.tool === tool.tool ? { ...t, enabled: !enabled } : t)) }
						: prev,
				);
				setSaving(null);
				setError(err instanceof Error ? err.message : String(err));
			});
	};

	const setPythonMode = (mode: ToolSwitchesDto["pythonToolMode"]): void => {
		setSwitches(prev => (prev ? { ...prev, pythonToolMode: mode } : prev));
		void store
			.setConfig(agentId, "python.toolMode", mode)
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
	};

	if (error) {
		return <div className="px-1 py-3 text-[12px] text-danger">工具开关加载失败：{error}</div>;
	}
	if (!switches) {
		return (
			<div className="flex flex-col gap-2 px-1 py-3">
				{[0, 1, 2, 3, 4].map(i => (
					<div key={i} className="skeleton h-6 w-full" />
				))}
			</div>
		);
	}

	return (
		<div>
			<div className="mb-3 flex items-center gap-3 text-[12px] text-ink-subtle">
				<span className="w-[130px] shrink-0">python 工具模式</span>
				<select
					value={switches.pythonToolMode}
					onChange={e => setPythonMode(e.target.value as ToolSwitchesDto["pythonToolMode"])}
					className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
				>
					{PYTHON_MODES.map(m => (
						<option key={m.value} value={m.value}>
							{m.label}
						</option>
					))}
				</select>
			</div>
			<div className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
				{switches.tools.map(t => (
					<div key={t.tool} className="flex items-center gap-3 px-4 py-2.5">
						<span className="min-w-0 flex-1">
							<span className="block font-mono text-[13px] text-ink">{t.tool}</span>
							<span className="block truncate text-[11px] text-ink-faint">
								{t.label} · {t.path}
							</span>
						</span>
						<button
							type="button"
							role="switch"
							aria-checked={t.enabled}
							disabled={saving === t.tool}
							className={`toggle shrink-0 ${t.enabled ? "on" : ""}`}
							onClick={() => setEnabled(t, !t.enabled)}
						/>
					</div>
				))}
			</div>
			<div className="mt-3 text-[11px] text-ink-faint">
				开关状态来自该 agent 的配置合并视图（未配置项显示内核默认）；切换写回生效层：有项目级 .cornfield/config.yml
				就写它，否则写该 agent 的 config.yml。新建会话生效。
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Skills tab：直接读 serve get_skills（与「技能」页同一个结果，不再自己扫目录/解析 frontmatter）。
// 五个事实都由 serve 给：scope（范围）/ source（来源）/ version（声明+指纹）/ activation（进没进会话）/
// errors（受阻与发现错误）。启停入口在「技能」页（同一份数据 + set_skill_enabled）。
// 展示词表（范围/激活/状态标签、版本与配色）两页共用 ./skills/skill-display。
// ─────────────────────────────────────────────────────────────────────

/**
 * 该 agent 的技能（get_skills 定向本 agent）。
 * 列表内容 = 本次会话加载的技能 + 停用名单 + 受阻/发现错误，都是 serve 的事实，不在前端重算。
 */
function AgentSkillsTab({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [data, setData] = useState<SkillsResultDto | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉，避免 get_skills 在握手期失败
		// 换 Agent / 重连先清空：留着上一个 Agent 的技能列表，就是在替它发言
		setData(null);
		setError(null);
		const load = async (): Promise<void> => {
			try {
				const result = await store.fetchSkills(agentId); // sessionId 定向本 agent
				if (!cancelled) {
					setData(result);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) {
					setData(null);
					setError(err instanceof Error ? err.message : String(err));
				}
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	if (!view.connected) {
		return <div className="px-1 py-8 text-center text-[12px] text-ink-faint">未连接——技能列表不可用</div>;
	}
	if (error) {
		return <div className="px-1 py-3 text-[12px] text-danger">技能列表加载失败：{error}</div>;
	}
	if (!data) {
		return (
			<div className="flex flex-col gap-2 px-1 py-3">
				{[0, 1, 2, 3].map(i => (
					<div key={i} className="skeleton h-6 w-full" />
				))}
			</div>
		);
	}

	// 需要人看见的问题：Project 归属未知 + 被挡住的技能 + 发现错误（与「技能」页同一套事实）
	const problems: Array<{ title: string; detail: string }> = [];
	if (data.scope.projectError) problems.push({ title: "Project 归属未知", detail: data.scope.projectError });
	for (const blocked of data.blocked) {
		problems.push({ title: `受阻：${blocked.name}`, detail: `${blocked.path} —— ${blocked.reason}` });
	}
	for (const err of data.errors) {
		problems.push({ title: "发现错误", detail: err.path ? `${err.path} —— ${err.message}` : err.message });
	}

	return (
		<div>
			{data.skills.length === 0 ? (
				<div className="px-1 py-8 text-center text-[12px] text-ink-faint">
					该 agent 本次会话未加载任何技能（停用名单 {data.disabled.length} 项）
				</div>
			) : (
				data.skills.map(row => <SkillLine key={`loaded:${row.name}`} row={row} />)
			)}

			{data.disabled.length > 0 && (
				<section className="mt-6">
					<h4 className="mb-3 section-title text-ink-faint">已停用（settings skills.ignoredSkills）</h4>
					{data.disabled.map(row => (
						<SkillLine key={`disabled:${row.name}`} row={row} dimmed />
					))}
				</section>
			)}

			{problems.length > 0 && (
				<section className="mt-6 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
					<div className="mb-1 text-[12px] font-semibold text-danger">发现错误 {problems.length} 项</div>
					{problems.map(problem => (
						<div key={`${problem.title}:${problem.detail}`} className="text-[11px] text-ink-subtle">
							<span className="font-medium text-ink">{problem.title}</span>：{problem.detail}
						</div>
					))}
				</section>
			)}

			<div className="mt-3 text-[11px] text-ink-faint">
				{data.skills.length} 个本次会话加载的技能 · 停用 {data.disabled.length} · 受阻/错误 {problems.length}
				—— 数据来自 get_skills（agentDir {data.scope.agentDir || "未知"}）；启用/停用在「技能」页操作。
			</div>
		</div>
	);
}

/** 一行技能：名字 + 描述 + 版本（声明或指纹）+ serve 给的五个事实。 */
function SkillLine({ row, dimmed }: { row: SkillScopeRowDto; dimmed?: boolean }): React.JSX.Element {
	return (
		<div
			className={`border-b border-hairline px-1 py-3 transition-colors hover:bg-surface ${dimmed ? "opacity-70" : ""}`}
		>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span
					className={`w-[200px] shrink-0 font-mono text-[13px] font-medium text-ink ${dimmed ? "line-through" : ""}`}
				>
					{row.name}
				</span>
				<span className="min-w-[200px] flex-1 text-[12px] text-ink-subtle">{row.description || "—"}</span>
				<span className="w-[110px] shrink-0 text-right font-mono text-[12px] text-ink-faint">
					{skillVersionText(row)}
				</span>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-faint">
				<span className="rounded bg-surface-2 px-1.5 py-0.5">{SCOPE_LABELS[row.scope]}</span>
				<span>
					{row.providerName ?? row.provider} · {row.source}
				</span>
				<span className={`rounded px-1.5 py-0.5 ${skillStatusClass(row.status)}`}>
					{SKILL_STATUS_LABELS[row.status]}
				</span>
				<span className="rounded bg-surface-2 px-1.5 py-0.5">{SKILL_ACTIVATION_LABELS[row.activation]}</span>
				<span className="max-w-[420px] truncate" title={row.path || "磁盘上找不到 SKILL.md"}>
					{row.path || "路径未知"}
				</span>
				{row.reason && <span className="max-w-[420px] truncate">原因：{row.reason}</span>}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// 用户画像 tab：真实数据源 agentDir/user.md（declarative persona）+
// mission.md（agent 职责）——fs_read 读取，替代原硬编码文案
// ─────────────────────────────────────────────────────────────────────

function ProfileView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [userMd, setUserMd] = useState<string | null>(null);
	const [missionMd, setMissionMd] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉
		const load = async (): Promise<void> => {
			try {
				const [u, m] = await Promise.all([
					store.fsRead(agentId, "user.md").catch(() => null),
					store.fsRead(agentId, "mission.md").catch(() => null),
				]);
				if (cancelled) return;
				setUserMd(u?.text ?? null);
				setMissionMd(m?.text ?? null);
				if (!u && !m) setError("该 agent 没有 user.md / mission.md（画像未配置）");
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	if (error && !userMd && !missionMd) {
		return <div className="px-1 py-6 text-[12px] text-ink-faint">{error}</div>;
	}

	return (
		<div className="flex flex-col gap-6">
			{missionMd && (
				<section>
					<h4 className="mb-2 section-title text-ink-faint">mission.md（agent 职责）</h4>
					<pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
						{missionMd}
					</pre>
				</section>
			)}
			{userMd && (
				<section>
					<h4 className="mb-2 section-title text-ink-faint">user.md（用户画像声明）</h4>
					<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
						{userMd}
					</pre>
				</section>
			)}
			<div className="text-[11px] text-ink-faint">
				画像数据来自 agentDir/user.md + mission.md（fs_read 真读）；钉钉对话实时建模待连接器只读路径（缺口 B5）。
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Prompts tab：agentDir 的 prompt 源（清单来自 serve，不再自己抄一份）
//
// 这份清单的真源是 `get_agent_prompt_sources`（serve 侧 `skeleton/agent-dir-files.ts` 的
// prompt 面）。这里曾经硬编码 7 项并且已经漂移：`.omp/SYSTEM.md` 是旧路径、
// `AGENTS-personal.md` / `CONTEXT.md` 全仓只有它提过；真正 always-on 的
// `TOOLS.md` / `TODO.md` / `knowledge/external-workspaces.md` 反而没有入口。
// 现在只渲染 serve 给的（`title` + `description`），正文按 `path` 用 fs_read 读。
//
// 三种「没有正文」不许互相顶替（与右栏 Artifacts/Changes 同一套写法）：
//   不存在 —— 清单里 `exists:false`：serve 逐项报的事实（缺的项就留在这份清单里，不裁掉）
//   读失败 —— 清单说存在，但 fs_read 报错（读的瞬间被删/超限/…）：原文照显，不写成「不存在」
//   未读   —— 还没点过任何一项，不是「这份文件是空的」
// 另有两态在清单层：未连接（没问过）与加载中，见 {@link PromptSourcesState}。
// ─────────────────────────────────────────────────────────────────────

const FS_MAX_READ_HINT = ">128KB 仅显示前段";

/**
 * 清单的读取状态。
 *
 * 「未连接」与「加载中」各自有名字：把「没问过」渲染成一份空清单，用户会据此以为这个
 * agentDir 什么都没有。
 */
type PromptSourcesState =
	| { status: "disconnected" }
	| { status: "loading" }
	| { status: "ready"; sources: AgentPromptSourceDto[] }
	| { status: "error"; error: string };

/**
 * 一次点开的读取结果 —— 同时是「选中的是哪一项」（单一事实，不与另一个 selectedPath 字段
 * 并行存在：两个字段说同一件事，迟早会不一致）。
 */
type PromptReadState =
	/** 清单已报它不存在：**不去读一个已知不存在的文件**，直接把那个事实说出来。 */
	| { path: string; kind: "missing" }
	| { path: string; kind: "loading" }
	| { path: string; kind: "text"; text: string; truncated: boolean }
	| { path: string; kind: "error"; error: string };

/** Prompts tab 的全部状态 + 它属于哪个 agent（换 agent 时整份作废，见 {@link currentPromptsLoad}）。 */
export interface PromptsLoad {
	agentId: string;
	sources: PromptSourcesState;
	read: PromptReadState | null;
}

function freshPromptsLoad(agentId: string): PromptsLoad {
	return { agentId, sources: { status: "loading" }, read: null };
}

/**
 * 「这份状态算不算本次 agent 的」：
 *
 * `agentId` 一变，手上那份（上一个 agent 的清单与正文）就不是本次的结果了 —— 而拉取是异步的，
 * 上一次的答复可能晚一步才回来。所以归属判定放在**渲染时**（不是等 effect 把状态清掉）：
 * 不是本次 agent 的，一律当作「还在加载」；上一次的答复回来时也不是无条件覆盖，
 * 而是先对一下 agentId。
 */
export function currentPromptsLoad(load: PromptsLoad, agentId: string): PromptsLoad {
	return load.agentId === agentId ? load : freshPromptsLoad(agentId);
}

function errorTextOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Prompts tab 的展示层（纯 props）。
 *
 * 纯 props 是为了能把「不存在 / 读失败 / 未读 / 未连接 / 加载中」五种画面静态渲染出来逐个
 * 钉住 —— 这几种「没有」在屏幕上长得像，混掉一个就是一个假结论。
 */
export function PromptSourcesView({
	sources,
	read,
	onOpen,
}: {
	sources: PromptSourcesState;
	/** 当前选中的项 + 它的读取结果（{@link PromptReadState}）。 */
	read: PromptReadState | null;
	onOpen: (source: AgentPromptSourceDto) => void;
}): React.JSX.Element {
	return (
		<div className="grid min-h-0 grid-cols-[minmax(220px,320px)_1fr] gap-4">
			<div className="rounded-lg border border-hairline bg-surface py-1">
				{sources.status === "disconnected" && (
					<div className="flex flex-col gap-1 px-3 py-6">
						<div className="text-[12px] text-ink-faint">未连接——读不到 prompt 源清单</div>
						<div className="text-[11px] leading-relaxed text-ink-subtle">
							连上 serve 后这里会列出这个 agentDir 的 prompt 源
						</div>
					</div>
				)}
				{sources.status === "loading" && <div className="px-3 py-6 text-[12px] text-ink-faint">加载中…</div>}
				{sources.status === "error" && (
					<div className="px-3 py-3 text-[12px] text-danger">清单读取失败：{sources.error}</div>
				)}
				{sources.status === "ready" && sources.sources.length === 0 && (
					<div className="px-3 py-6 text-[12px] text-ink-faint">serve 报这个 agentDir 一份 prompt 源都没有</div>
				)}
				{sources.status === "ready" &&
					sources.sources.map(s => (
						<button
							key={s.path}
							type="button"
							data-prompt-path={s.path}
							className={`flex w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${read?.path === s.path ? "bg-accent-dim" : ""}`}
							onClick={() => onOpen(s)}
						>
							<span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
								<span className="text-[12.5px] font-medium text-ink">{s.title}</span>
								<span className="font-mono text-[10.5px] text-ink-subtle">{s.path}</span>
								{!s.exists && <span className="badge fail">不存在</span>}
							</span>
							<span className="text-[11px] leading-snug text-ink-faint">{s.description}</span>
						</button>
					))}
			</div>
			<div className="min-h-0 overflow-auto rounded-lg border border-hairline bg-surface px-4 py-3">
				{read === null && (
					<div className="py-10 text-center text-[12px] text-ink-faint">点击左侧浏览 agent 的各份 prompt 配置</div>
				)}
				{read?.kind === "loading" && <div className="py-8 text-center text-[12px] text-ink-faint">加载中…</div>}
				{read?.kind === "missing" && (
					<div className="flex flex-col gap-1 py-8 text-center">
						<div className="font-mono text-[12px] text-ink-muted">{read.path}</div>
						<div className="text-[12px] text-ink-faint">该文件不存在（serve 报 exists=false）</div>
						<div className="px-6 text-[11px] leading-relaxed text-ink-subtle">
							它没有内容可读；「不存在」与「读了但没读到」不是一回事
						</div>
					</div>
				)}
				{read?.kind === "error" && (
					<div className="flex flex-col gap-1 py-8 text-center">
						<div className="font-mono text-[12px] text-ink-muted">{read.path}</div>
						<div className="text-[12px] text-danger">读取失败：{read.error}</div>
					</div>
				)}
				{read?.kind === "text" && (
					<>
						<div className="mb-2 flex items-center gap-2">
							<span className="truncate font-mono text-[12px] font-medium text-ink">{read.path}</span>
							{read.truncated && <span className="badge fail">{FS_MAX_READ_HINT}</span>}
						</div>
						<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
							{read.text}
						</pre>
					</>
				)}
			</div>
		</div>
	);
}

function PromptsView({ agentId }: { agentId: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [load, setLoad] = useState<PromptsLoad>(() => freshPromptsLoad(agentId));

	// 换 agent：整份作废（**渲染时**判定，不等 effect）—— 上一个 agent 的清单与正文都不许
	// 当成本次的结果渲染出去。
	const current = currentPromptsLoad(load, agentId);
	const sources: PromptSourcesState = view.connected ? current.sources : { status: "disconnected" };

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return;
		setLoad(freshPromptsLoad(agentId));
		store
			.fetchAgentPromptSources(agentId)
			.then(list => {
				if (cancelled) return;
				setLoad(prev =>
					prev.agentId === agentId ? { ...prev, sources: { status: "ready", sources: list } } : prev,
				);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setLoad(prev =>
					prev.agentId === agentId ? { ...prev, sources: { status: "error", error: errorTextOf(err) } } : prev,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	/** 点开一项：清单已报不存在的，直接说「不存在」，不去读一个已知不存在的文件。 */
	const open = (source: AgentPromptSourceDto): void => {
		setLoad(prev => ({
			...prev,
			read: source.exists ? { path: source.path, kind: "loading" } : { path: source.path, kind: "missing" },
		}));
		if (!source.exists) return;
		store
			.fsRead(agentId, source.path)
			.then(({ text, truncated }) => {
				// 回来时还停在同一项上才落：中途换了 agent / 点了别的项，这次答复已经不是它的了。
				setLoad(prev =>
					prev.agentId === agentId && prev.read?.path === source.path
						? { ...prev, read: { path: source.path, kind: "text", text, truncated } }
						: prev,
				);
			})
			.catch((err: unknown) => {
				setLoad(prev =>
					prev.agentId === agentId && prev.read?.path === source.path
						? { ...prev, read: { path: source.path, kind: "error", error: errorTextOf(err) } }
						: prev,
				);
			});
	};

	return <PromptSourcesView sources={sources} read={current.read} onOpen={open} />;
}
