import { Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentInfoDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Agent 列表（FR-2）—— 数据源：server_snapshot → adapter 映射（view.agents）。
 * be-dev 多 Agent 注册表（serve 会话注册表 + switch_session）落地前，serve 不推送
 * server_snapshot，本页为空态 + 完整骨架（卡片渲染逻辑已就位，注册表一到即填）。
 * 交互：状态点 / 工作区分节 / CODING-WORKER 徽标 / 搜索 / 进会话与详情入口。
 */
export function AgentsView(): React.JSX.Element {
	const view = useSession();
	const navigate = useNavigate();
	const store = useSessionStore();
	const agents = view.agents;
	const [wsFilter, setWsFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [query, setQuery] = useState("");

	// serve 多 Agent 注册表就绪：挂载时拉一次 list_agents（server_snapshot 推送也会更新）
	useEffect(() => {
		void store.fetchAgents();
	}, [store]);

	const workspaces = useMemo(() => Array.from(new Set(agents.map(a => a.workspace))), [agents]);

	const filtered = agents.filter(agent => {
		if (wsFilter !== "all" && agent.workspace !== wsFilter) return false;
		if (statusFilter !== "all" && agent.status !== statusFilter) return false;
		if (query && !agent.name.toLowerCase().includes(query.toLowerCase())) return false;
		return true;
	});

	const running = agents.filter(a => a.status === "online" || a.status === "busy").length;

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[1100px]">
				<div className="mb-5 flex items-baseline gap-3.5">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">Agent</h1>
					<span className="text-[13px] text-ink-faint">
						{workspaces.length} 工作区 · {agents.length} agent · {running} 运行中
					</span>
				</div>

				{/* 筛选：工作区 seg + 状态 seg + 搜索 */}
				<div className="mb-6 flex flex-wrap items-center gap-2">
					<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
						{["all", ...workspaces].map(ws => (
							<button
								key={ws}
								type="button"
								className={`rounded px-3 py-1 text-[12px] transition-colors ${wsFilter === ws ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
								onClick={() => setWsFilter(ws)}
							>
								{ws === "all" ? "全部" : ws}
							</button>
						))}
					</div>
					<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
						{[
							["all", "全部状态"],
							["online", "运行中"],
							["busy", "执行中"],
							["idle", "空闲"],
							["stopped", "已停用"],
						].map(([key, label]) => (
							<button
								key={key}
								type="button"
								className={`rounded px-3 py-1 text-[12px] transition-colors ${statusFilter === key ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
								onClick={() => setStatusFilter(key)}
							>
								{label}
							</button>
						))}
					</div>
					<div className="ml-auto flex w-[200px] items-center gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-1.5 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
						<Search size={13} strokeWidth={1.5} className="shrink-0 text-ink-faint" />
						<input
							value={query}
							onChange={e => setQuery(e.target.value)}
							placeholder="搜索 Agent…"
							className="w-full border-none bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
						/>
					</div>
				</div>

				{agents.length === 0 && (
					<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong bg-surface px-6 py-16 text-center">
						<TerminalSquare size={28} strokeWidth={1.5} className="text-ink-faint" />
						<div className="text-[14px] text-ink-muted">尚无 Agent 数据</div>
						<div className="max-w-md text-[12px] text-ink-faint">
							be-dev 多 Agent 注册表（serve 会话注册表 + switch_session + server_snapshot 多 Agent
							列表）落地后，本页自动填充。当前单会话由 serve 提供。
						</div>
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
										onOpen={() => navigate(`/agents/${agent.id}`)}
										onSession={() => navigate("/workspace")}
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
	onOpen,
	onSession,
}: {
	agent: AgentInfoDto;
	onOpen: () => void;
	onSession: () => void;
}): React.JSX.Element {
	const dotClass =
		agent.status === "online"
			? "bg-success"
			: agent.status === "busy"
				? "bg-warning animate-pulse"
				: agent.status === "idle"
					? "bg-ink-faint"
					: "bg-ink-faint";
	const statusLabel =
		agent.status === "online"
			? "运行中"
			: agent.status === "busy"
				? "执行中"
				: agent.status === "idle"
					? "休眠"
					: "未挂载";

	return (
		<div className="cursor-pointer rounded-xl border border-hairline bg-surface p-4 transition-all duration-150 hover:-translate-y-px hover:border-hairline-strong">
			<div className="flex items-center gap-3">
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[12px] font-semibold text-ink">
					{agent.face}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[15px] font-medium text-ink">{agent.name}</span>
						<KindBadge kind={agent.kind} />
						{agent.dingtalkBound && <span className="badge done">钉钉</span>}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-subtle">
						<span className={`h-2 w-2 rounded-full ${dotClass}`} />
						{statusLabel}
					</div>
				</div>
			</div>
			<div className="mt-3 flex items-center gap-4 border-t border-hairline pt-2.5 text-[12px] text-ink-faint">
				{agent.model && <span className="truncate font-mono text-[11px] text-ink-subtle">{agent.model}</span>}
				{agent.skillsCount !== undefined && <span>{agent.skillsCount} 技能</span>}
				{agent.cronCount !== undefined && <span>{agent.cronCount} 定时任务</span>}
				{agent.lastAction && <span className="ml-auto truncate">{agent.lastAction}</span>}
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
			</div>
		</div>
	);
}

export function KindBadge({ kind }: { kind: "coding" | "worker" }): React.JSX.Element {
	if (kind === "coding") {
		return (
			<span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-px font-mono text-[9px] tracking-wide text-ink-subtle">
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
