import type { HostToolDefinitionDto, ModelInfoDto, ToolSwitchDto, ToolSwitchesDto } from "@cornfield/wire";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GatewayAccountPatchDto, GatewayGroupInfo } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { FileExplorer } from "../workspace/FileExplorer";
import { KindBadge } from "./AgentsView";

/**
 * Agent 详情（FR-2）—— 6 tab：Skills / 模型 / 工具 / 画像 / 文件 / Prompts。
 * 数据源：Skills 读 .cornfield/skills 真实列表（fs_list+SKILL.md）、画像读 mission.md+user.md、
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

// 技能列表改为真实数据：fs_list 读 .cornfield/skills/ 目录（serve skillCount 同源）。
// 版本/描述从各 skill 的 SKILL.md frontmatter 解析（fs_read）。

const THINKING_LEVELS = ["off", "low", "medium", "high"];

export function AgentDetailView({ agentId, onClose }: { agentId: string; onClose: () => void }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [tab, setTab] = useState<TabId>("skills");
	const [models, setModels] = useState<ModelInfoDto[]>([]);
	const [selProvider, setSelProvider] = useState("anthropic");
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

	useEffect(() => {
		void store.fetchModels().then(result => setModels(result.models));
	}, [store]);

	const agent = view.agents.find(a => a.id === agentId);
	const name = agent?.name ?? (view.agents.length === 0 ? "等待 Agent 注册表" : "未知 Agent");
	const provider = agent?.model?.split("/")[0] ?? (view.model ?? "").split("/")[0] ?? "anthropic";
	const currentModel = agent?.model ?? view.model ?? "";
	const providers = Array.from(new Set(models.map(m => m.provider)));

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
						<span className="rounded bg-accent-dim px-2.5 py-1 font-mono text-[12px] text-ink">
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

				{tab === "skills" && <SkillsView agentId={agentId} />}

				{tab === "dingtalk" && <DingtalkView agentId={agentId} />}

				{tab === "model" && (
					<div>
						<h4 className="mb-3.5 section-title text-ink-faint">模型选择</h4>
						<div className="flex max-w-[420px] flex-col gap-2.5">
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Provider</span>
								<select
									value={selProvider}
									onChange={e => setSelProvider(e.target.value)}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{providers.length > 0 ? (
										providers.map(p => <option key={p}>{p}</option>)
									) : (
										<option>{provider}</option>
									)}
								</select>
							</label>
							<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
								<span className="w-[90px] shrink-0">Model</span>
								<select
									value={currentModel}
									onChange={e => {
										if (e.target.value) store.setModel(e.target.value, selProvider, agentId);
									}}
									className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{models
										.filter(m => m.provider === selProvider)
										.map(m => (
											<option key={m.id}>{m.id}</option>
										))}
									{models.length === 0 && <option>{currentModel || "—"}</option>}
								</select>
							</label>
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
							<h4 className="mb-3 section-title text-ink-faint">内核工具开关（写该 agent 的 config.yml）</h4>
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

				{tab === "files" && <FileExplorer agentId={agentId} />}

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

/** 内核工具开关（get_tool_switches 真读 + set_config 写回该 agent 的 config.yml）。 */
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
				开关状态来自该 agent 的 config.yml（未配置项显示内核默认）；切换立即写回配置文件，新建会话生效。
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Skills tab：真实技能列表（fs_list 读 .omp/skills/，SKILL.md frontmatter 解析）
// ─────────────────────────────────────────────────────────────────────

interface SkillInfo {
	name: string;
	desc?: string;
	version?: string;
}

/** 解析 skills/<name>/SKILL.md 的 frontmatter（name/description/version）。 */
function parseFrontmatter(text: string): { desc?: string; version?: string; name?: string } {
	const out: { desc?: string; version?: string; name?: string } = {};
	const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!m) return out;
	for (const line of m[1].split("\n")) {
		const mm = line.match(/^(name|description|version)\s*:\s*(.+)$/);
		if (mm) {
			const val = mm[2].trim().replace(/^["']|["']$/g, "");
			if (mm[1] === "description") out.desc = val;
			else if (mm[1] === "version") out.version = val;
			else out.name = val;
		}
	}
	return out;
}

function SkillsView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const view = useSession();
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!view.connected) return; // 连接就绪后再拉，避免 fs_list 在握手期失败
		const load = async (): Promise<void> => {
			try {
				const { entries } = await store.fsList(agentId, ".cornfield/skills");
				const dirs = entries.filter(e => e.type === "dir");
				const infos = await Promise.all(
					dirs.map(async d => {
						// 读 SKILL.md frontmatter（可能不在顶层而在一级子目录，容错）
						try {
							const { text } = await store.fsRead(agentId, `.cornfield/skills/${d.name}/SKILL.md`);
							const fm = parseFrontmatter(text);
							return { name: fm.name ?? d.name, desc: fm.desc, version: fm.version };
						} catch {
							// 无 SKILL.md（纯目录/素材）——仅列目录名
							return { name: d.name };
						}
					}),
				);
				if (!cancelled) setSkills(infos);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [agentId, store, view.connected]);

	if (error) {
		return <div className="px-1 py-3 text-[12px] text-danger">技能列表加载失败：{error}</div>;
	}
	if (!skills) {
		return (
			<div className="flex flex-col gap-2 px-1 py-3">
				{[0, 1, 2, 3].map(i => (
					<div key={i} className="skeleton h-6 w-full" />
				))}
			</div>
		);
	}
	if (skills.length === 0) {
		return (
			<div className="px-1 py-8 text-center text-[12px] text-ink-faint">
				该 agent 没有已安装技能（.cornfield/skills/ 为空）
			</div>
		);
	}

	return (
		<div>
			{skills.map(skill => (
				<div
					key={skill.name}
					className="flex items-baseline gap-3 border-b border-hairline px-1 py-3.5 transition-colors hover:bg-surface"
				>
					<span className="w-[220px] shrink-0 font-mono text-[13px] font-medium text-ink">{skill.name}</span>
					<span className="min-w-0 flex-1 text-[12px] text-ink-subtle">{skill.desc ?? "—"}</span>
					<span className="shrink-0 font-mono text-[12px] text-ink-faint">{skill.version ?? ""}</span>
					<button
						type="button"
						className="toggle shrink-0 on"
						aria-checked={true}
						role="switch"
						disabled
						title="技能启停即将支持"
					/>
				</div>
			))}
			<div className="mt-3 text-[11px] text-ink-faint">
				{skills.length} 个已安装技能（.cornfield/skills/ 真实列表）；启用/停用待 set_skill_enabled 协议。
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
// Prompts tab：聚合 agent 的各类 prompt 配置源
// ─────────────────────────────────────────────────────────────────────

const FS_MAX_READ_HINT = ">128KB 仅显示前段";

interface PromptSource {
	path: string;
	title: string;
	desc: string;
}

const PROMPT_SOURCES: PromptSource[] = [
	{ path: "mission.md", title: "mission.md", desc: "agent 使命/人格定义（工作方式与长期目标）" },
	{ path: "user.md", title: "user.md", desc: "用户身份声明（草稿/权威版本之一）" },
	{ path: ".omp/SYSTEM.md", title: ".omp/SYSTEM.md", desc: "Gateway Agent 系统提示词（IM 场景纪律）" },
	{ path: "AGENTS.md", title: "AGENTS.md", desc: "仓库级 agent 指南（项目规则/约定）" },
	{ path: "AGENTS-personal.md", title: "AGENTS-personal.md", desc: "个人版 agent 指南（若存在）" },
	{ path: "CONTEXT.md", title: "CONTEXT.md", desc: "长期上下文/背景注入" },
	{ path: "prompt-includes.json", title: "prompt-includes.json", desc: "系统提示注入清单（插件/技能白名单）" },
];

function PromptsView({ agentId }: { agentId: string }): React.JSX.Element {
	const store = useSessionStore();
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const open = async (path: string): Promise<void> => {
		setSelectedPath(path);
		setLoading(true);
		setError(null);
		// 文件不存在是常态（如 AGENTS-personal.md 可能没有）——失败标记为不可用而非报错
		try {
			const result = await store.fsRead(agentId, path);
			setContent(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setContent(null);
		}
		setLoading(false);
	};

	return (
		<div className="grid min-h-0 grid-cols-[minmax(220px,320px)_1fr] gap-4">
			<div className="rounded-lg border border-hairline bg-surface py-1">
				{PROMPT_SOURCES.map(s => (
					<button
						key={s.path}
						type="button"
						className={`flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${selectedPath === s.path ? "bg-accent-dim" : ""}`}
						onClick={() => void open(s.path)}
					>
						<span className="font-mono text-[12.5px] font-medium text-ink">{s.title}</span>
						<span className="text-[11px] leading-snug text-ink-faint">{s.desc}</span>
					</button>
				))}
			</div>
			<div className="min-h-0 overflow-auto rounded-lg border border-hairline bg-surface px-4 py-3">
				{loading && <div className="py-8 text-center text-[12px] text-ink-faint">加载中…</div>}
				{!loading && selectedPath && content && (
					<>
						<div className="mb-2 flex items-center gap-2">
							<span className="truncate font-mono text-[12px] font-medium text-ink">{selectedPath}</span>
							{content.truncated && <span className="badge fail">{FS_MAX_READ_HINT}</span>}
						</div>
						<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
							{content.text}
						</pre>
					</>
				)}
				{!loading && selectedPath && error && (
					<div className="py-8 text-center text-[12px] text-ink-faint">该文件不存在或不可读（{error}）</div>
				)}
				{!loading && !selectedPath && (
					<div className="py-10 text-center text-[12px] text-ink-faint">点击左侧浏览 agent 的各份 prompt 配置</div>
				)}
			</div>
		</div>
	);
}
