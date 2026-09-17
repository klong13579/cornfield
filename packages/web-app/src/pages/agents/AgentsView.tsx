import type { AgentInfoDto } from "@cornfield/wire";
import { Plus, Search, Server, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GatewayStatusDto } from "../../lib/pi-client-api";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { type AgentDisplayStatus, type AgentStatusDisplay, agentStatusDisplay } from "./agent-status";
import {
	CreateAgentPanel,
	type CreateAgentPhase,
	type CreateAgentValues,
	EMPTY_CREATE_AGENT_VALUES,
	submitCreateAgent,
} from "./CreateAgentPanel";

const STATUS_FILTERS: readonly ["all" | AgentDisplayStatus, string][] = [
	["all", "全部状态"],
	["online", "运行中"],
	["busy", "执行中"],
	["idle", "空闲"],
	["unmounted", "未挂载"],
	["disabled", "已停用"],
];

/**
 * Agent 列表（FR-2）—— 数据源：server_snapshot → adapter 映射（view.agents）。
 * 数据源：server_snapshot → adapter 映射（view.agents），serve 启动即预挂载全部注册 agent。
 * 交互：状态点 / 工作区分节 / CODING-WORKER 徽标 / 搜索 / 进会话与详情入口 / 创建员工。
 *
 * 「创建员工」是本页唯一一个**写**动作：它调 `create_agent`（serve 侧就是 `cornfield agent init`），
 * 成功之后列表已经刷成 serve 的现状 —— 所以新建的那种成功直接进详情页，而「同名已存在、这次只
 * 补齐了缺的文件」那种成功留在面板上说清楚（`created` 这一位就是用来分开这两种成功的）。
 */
export function AgentsView(): React.JSX.Element {
	const view = useSession();
	const navigate = useNavigate();
	const store = useSessionStore();
	const agents = view.agents;
	const [wsFilter, setWsFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<"all" | AgentDisplayStatus>("all");
	const [query, setQuery] = useState("");

	// 「创建员工」面板：两个入口（筛选行右侧 / 空态里）开的是同一个，面板状态也归这里。
	const [createOpen, setCreateOpen] = useState(false);
	const [createValues, setCreateValues] = useState<CreateAgentValues>(EMPTY_CREATE_AGENT_VALUES);
	const [createPhase, setCreatePhase] = useState<CreateAgentPhase>({ kind: "idle" });
	// 提交在飞的时候两个入口都按不动：点它会把面板重置成空表单，而后台那次请求的结论
	// （跳详情 / 已在）随后才到 —— 屏上不该先擦掉一个还在进行中的动作。
	const createBusy = createPhase.kind === "submitting";

	// 删除入口（detach）：每个 agent 卡片的操作结果（成功/失败/忙态拦截）就地反馈。
	const [detachOutcomes, setDetachOutcomes] = useState<Record<string, { ok: boolean; text: string }>>({});

	const openCreate = (): void => {
		// 每次都从干净状态开：上一次的输入与结论不能当成这一次的前提。
		setCreateValues(EMPTY_CREATE_AGENT_VALUES);
		setCreatePhase({ kind: "idle" });
		setCreateOpen(true);
	};

	const submitCreate = async (): Promise<void> => {
		setCreatePhase({ kind: "submitting" });
		const outcome = await submitCreateAgent(store, createValues);
		if (!outcome.ok) {
			setCreatePhase({ kind: "failed", message: outcome.message });
			return;
		}
		if (outcome.agent.created) {
			// 新建：store 已经把列表刷成 serve 的现状（它就在里面），直接进它的详情页。
			setCreateOpen(false);
			navigate(`/agents/${outcome.agent.name}`);
			return;
		}
		// 同名 agentDir 本来就在（增量补齐）：也是成功，但不是「新建」，留在面板上说明白。
		setCreatePhase({ kind: "existing", agent: outcome.agent });
	};

	/**
	 * 卸载（detach）一个已挂载的 agent。忙态由 store 拦截（不发命令，返回 busy:true），
	 * 其它失败展示 serve 原文；成功后在卡片上留一条「已卸载」，列表状态随 store 刷新同步。
	 */
	const onDetach = async (agent: AgentInfoDto): Promise<void> => {
		const res = await store.detachAgent(agent.id);
		setDetachOutcomes(prev => ({
			...prev,
			[agent.id]: res.ok
				? { ok: true, text: "已卸载" }
				: { ok: false, text: res.busy ? `该 agent 正在执行任务（${agent.phase ?? "busy"}），无法卸载` : res.error },
		}));
	};

	// serve 多 Agent 注册表就绪：挂载时拉一次 list_agents（server_snapshot 推送也会更新）。
	// 与详情页各 tab 同款守卫：连接就绪（WS open）后再拉，不在握手期白发一条带堆栈的告警。
	useEffect(() => {
		if (!view.connected) return;
		void store.fetchAgents();
	}, [store, view.connected]);

	// gateway 运行状态（gateway_status → gateway.status.json，30s stale 刷新）
	const [gwStatus, setGwStatus] = useState<GatewayStatusDto | null>(null);
	const [gwError, setGwError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const s = await store.gatewayStatus();
				if (!cancelled) {
					setGwStatus(s);
					setGwError(null);
				}
			} catch (err) {
				if (!cancelled) setGwError(err instanceof Error ? err.message : String(err));
			}
		};
		if (view.connected) void load();
		const t = setInterval(() => {
			if (view.connected) void load();
		}, 15_000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, [store, view.connected]);

	const bridgeState = (account: string): string | undefined =>
		gwStatus?.accounts.find(a => a.accountId === account)?.bridgeState;

	const workspaces = useMemo(() => Array.from(new Set(agents.map(a => a.workspace))), [agents]);

	const filtered = agents.filter(agent => {
		if (wsFilter !== "all" && agent.workspace !== wsFilter) return false;
		if (statusFilter !== "all" && agentStatusDisplay(agent, gwStatus).key !== statusFilter) return false;
		if (query && !agent.name.toLowerCase().includes(query.toLowerCase())) return false;
		return true;
	});

	const running = agents.filter(a => a.status === "online" || a.status === "busy").length;

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-wide">
				<div className="mb-5 flex items-baseline gap-3.5">
					<h1 className="text-3xl font-semibold text-ink">Agent</h1>
					<span className="text-[13px] text-ink-faint">
						{workspaces.length} 工作区 · {agents.length} agent · {running} 运行中
					</span>
				</div>

				{/* gateway 运行状态条（gateway.status.json 只读转发；与 serve 视角互补） */}
				<div className="mb-6 flex items-center gap-2.5 rounded-lg border border-hairline bg-surface px-4 py-2.5">
					<Server size={14} strokeWidth={1.5} className="shrink-0 text-ink-subtle" />
					<span className="text-[12px] text-ink-subtle">
						gateway{gwStatus ? ` · pid ${gwStatus.pid ?? "?"}` : ""}
						{gwStatus?.stale ? " · 状态陈旧" : gwStatus ? " · 运行中" : ""}
					</span>
					{gwStatus?.scheduler && (
						<span className="badge done">调度器 {gwStatus.scheduler.taskCount ?? 0} 任务</span>
					)}
					{gwError && <span className="text-[12px] text-ink-faint">（{gwError}）</span>}
					<span className="ml-auto flex gap-1.5">
						{(gwStatus?.accounts ?? []).map(a => (
							<span
								key={a.accountId}
								className={`rounded-full px-2 py-0.5 text-[11px] ${a.bridgeState === "idle" ? "bg-surface-3 text-ink-subtle" : a.bridgeRunning ? "bg-accent-dim text-accent" : "bg-danger/10 text-danger"}`}
								title={`${a.accountId}: bridge=${a.bridgeRunning} state=${a.bridgeState ?? "?"} channel=${a.channelConnected ? "connected" : "offline"}`}
							>
								{a.accountId}
							</span>
						))}
					</span>
				</div>

				{/* 筛选：工作区 seg + 状态 seg + 搜索 */}
				<div className="mb-6 flex flex-wrap items-center gap-2">
					<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
						{["all", ...workspaces].map(ws => (
							<button
								key={ws}
								type="button"
								className={`rounded px-3 py-1 text-[12px] transition-colors ${wsFilter === ws ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
								onClick={() => setWsFilter(ws)}
							>
								{ws === "all" ? "全部" : ws}
							</button>
						))}
					</div>
					<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
						{STATUS_FILTERS.map(([key, label]) => (
							<button
								key={key}
								type="button"
								className={`rounded px-3 py-1 text-[12px] transition-colors ${statusFilter === key ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
								onClick={() => setStatusFilter(key)}
							>
								{label}
							</button>
						))}
					</div>
					<div className="ml-auto flex w-[200px] items-center gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-1.5 focus-within:border-hairline-strong">
						<Search size={13} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder="搜索 Agent…"
							className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
						/>
					</div>
					<button
						type="button"
						className="btn btn-sm flex shrink-0 items-center gap-1.5"
						onClick={openCreate}
						disabled={createBusy}
					>
						<Plus size={13} strokeWidth={2} />
						创建员工
					</button>
				</div>

				{createOpen && (
					<CreateAgentPanel
						values={createValues}
						phase={createPhase}
						onChange={patch => setCreateValues(prev => ({ ...prev, ...patch }))}
						onSubmit={() => void submitCreate()}
						onClose={() => setCreateOpen(false)}
						onOpenAgent={agentName => navigate(`/agents/${agentName}`)}
					/>
				)}

				{agents.length === 0 && (
					<div className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-hairline-strong bg-surface px-6 py-16 text-center">
						<TerminalSquare size={28} strokeWidth={1.5} className="text-ink-faint" />
						<div className="text-[14px] text-ink-muted">还没有 agent。</div>
						<div className="max-w-[420px] text-[12px] text-ink-faint">
							点下面的按钮建一个 —— 它会在 serve 上真的建出一个 agentDir（骨架文件 + registry
							登记），建好就出现在这里。
						</div>
						<button
							type="button"
							className="btn btn-sm flex items-center gap-1.5"
							onClick={openCreate}
							disabled={createBusy}
						>
							<Plus size={13} strokeWidth={2} />
							创建员工
						</button>
					</div>
				)}

				{workspaces.map(ws => {
					const group = filtered.filter(a => a.workspace === ws);
					if (group.length === 0) return null;
					return (
						<div key={ws} className="mb-8">
							<div className="mb-3 flex items-baseline gap-2.5">
								<span className="text-[15px] font-semibold tracking-[-0.2px] text-ink">{ws}</span>
								<span className="text-[12px] text-ink-faint">{group.length} agents</span>
								<span className="ml-2 h-px flex-1 bg-hairline" />
							</div>
							<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
								{group.map(agent => (
									<AgentCard
										key={agent.id}
										agent={agent}
										gatewayBridge={bridgeState(agent.id)}
										display={agentStatusDisplay(agent, gwStatus)}
										onOpen={() => navigate(`/agents/${agent.id}`)}
										onSession={() => {
											store.focusAgent(agent.id); // attach + 切 active，一处语义
											navigate("/workspace");
										}}
										onDetach={() => void onDetach(agent)}
										detachFeedback={detachOutcomes[agent.id] ?? null}
									/>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function AgentCard({
	agent,
	gatewayBridge,
	display,
	onOpen,
	onSession,
	onDetach,
	detachFeedback,
}: {
	agent: AgentInfoDto;
	/** gateway 侧 bridge 状态（gateway.status.json；无则 undefined）。 */
	gatewayBridge?: string;
	/** 状态结论（词 + 点色），父层用 {@link agentStatusDisplay} 统一算出。 */
	display: AgentStatusDisplay;
	onOpen: () => void;
	onSession: () => void;
	onDetach: () => void;
	/** 本次卸载操作的就地反馈（成功/失败/忙态拦截）；暂无操作时为 null。 */
	detachFeedback: { ok: boolean; text: string } | null;
}): React.JSX.Element {
	// 停用态优先：gateway 账号下线（或禁用）→ 红色「已停用」，覆盖 serve 快照的 idle/online。
	const { label, dotClass } = display;
	const stopped = display.key === "disabled";

	return (
		<div className="rounded-xl border border-hairline bg-surface p-4 transition-all duration-150 hover:-translate-y-px hover:border-hairline-strong active:scale-[0.98] active:translate-y-0">
			<div className="flex items-center gap-3">
				<span className="avatar">{agent.face}</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[15px] font-medium text-ink">{agent.name}</span>
						<KindBadge kind={agent.kind} />
						{agent.dingtalk?.enabled && (
							<span
								className="badge done"
								title={`钉钉机器人：${agent.dingtalk.robotName ?? agent.dingtalk.appKey ?? "未命名"} · 启用中`}
							>
								钉钉
							</span>
						)}
						{stopped && agent.dingtalk && (
							<span
								className="badge fail"
								title={`钉钉机器人：${agent.dingtalk.robotName ?? agent.dingtalk.appKey ?? "未命名"} · 已停用（gateway 账号 enabled=false）`}
							>
								钉钉已停用
							</span>
						)}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-subtle">
						<span className={`h-2 w-2 rounded-full ${dotClass}`} />
						{label}
						{gatewayBridge && <span className="text-[11px] text-ink-faint">· gateway {gatewayBridge}</span>}
					</div>
				</div>
			</div>
			<div className="mt-3 flex items-center gap-4 border-t border-hairline pt-2.5 text-[12px] text-ink-faint">
				{agent.model && <span className="truncate font-mono text-[11px] text-ink-subtle">{agent.model}</span>}
				{agent.skillsCount !== undefined && <span>{agent.skillsCount} 技能</span>}
			</div>
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					className="btn btn-sm flex-1"
					onClick={e => {
						e.stopPropagation();
						onSession();
					}}
				>
					会话
				</button>
				<button
					type="button"
					className="btn btn-secondary btn-sm flex-1"
					onClick={e => {
						e.stopPropagation();
						onOpen();
					}}
				>
					详情
				</button>
				{agent.attached && agent.id !== "default" && (
					<button
						type="button"
						className="btn btn-secondary btn-sm shrink-0"
						onClick={e => {
							e.stopPropagation();
							onDetach();
						}}
					>
						卸载
					</button>
				)}
			</div>
			{detachFeedback && (
				<div
					className={`mt-2 text-[11px] ${detachFeedback.ok ? "text-ink-faint" : "text-danger"}`}
					data-testid={`detach-feedback-${agent.id}`}
				>
					{detachFeedback.text}
				</div>
			)}
		</div>
	);
}

export function KindBadge({ kind }: { kind: "coding" | "worker" }): React.JSX.Element {
	if (kind === "coding") {
		return (
			<span className="badge neutral inline-flex items-center gap-1 font-mono text-[9px] tracking-wide">
				<TerminalSquare size={9} strokeWidth={2} />
				CODING
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 rounded border border-hairline-strong px-1.5 py-px font-mono text-[9px] tracking-wide text-ink-faint">
			WORKER
		</span>
	);
}
