import { ArrowRight, Bot, CalendarDays, Cpu, History, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Orb } from "../../components/Orb";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Home 欢迎页（FR-9，EmptyState：Greeting → Suggestions → Composer → 最近 Agent）。
 * - 问候语名字：fs_read 当前 agent 的 user.md（declarative persona）解析，不再硬编码
 * - suggestions 错峰入场（120ms + index*70ms）
 * - Composer 直达会话工作台（?q= 带话）
 * - 环境摘要（get_state）+ 最近 agent（server_snapshot 风格）由会话 store 提供
 */

const SUGGESTIONS = [
	{ icon: CalendarDays, label: "检查今天的定时任务", to: "/tasks" },
	{ icon: History, label: "最近会话回顾", to: "/records" },
	{ icon: Mic, label: "语音记录一条指令", to: "/voice" },
	{ icon: Cpu, label: "切换模型", to: "/models" },
	{ icon: Bot, label: "打开 Agent 管理", to: "/agents" },
];

const FACE_COLORS = ["#5e6ad2", "#3a7d5d", "#b8823a"];

function timeGreeting(): string {
	const h = new Date().getHours();
	if (h < 6) return "夜深了";
	if (h < 12) return "早上好";
	if (h < 14) return "中午好";
	if (h < 18) return "下午好";
	return "晚上好";
}

export function HomeView(): React.JSX.Element {
	const navigate = useNavigate();
	const view = useSession();
	const store = useSessionStore();
	const [query, setQuery] = useState("");
	const [userName, setUserName] = useState<string | null>(null);

	useEffect(() => {
		// 问候名：依次尝试各 agent 的 user.md（declarative persona）解析 name；
		// default（serve cwd）常无 user.md，fallback 到有声明的 agent（hr/me 等同源）。
		let cancelled = false;
		if (view.connected) {
			const candidates = ["default", ...view.agents.map(a => a.id)];
			void (async () => {
				for (const agentId of candidates) {
					if (cancelled) return;
					try {
						const { text } = await store.fsRead(agentId, "user.md");
						const m = text.match(/^## basics[\s\S]*?\n- name\s*:\s*(.+)$/m);
						if (m?.[1]?.trim()) {
							setUserName(m[1].trim());
							return;
						}
					} catch {
						// 该 agent 无 user.md，试下一个
					}
				}
			})();
		}
		return () => {
			cancelled = true;
		};
	}, [store, view.connected, view.agents]);

	useEffect(() => {
		// Composer 直达工作台；焦点置于主输入
		const t = setTimeout(() => document.querySelector<HTMLInputElement>("#home-composer")?.focus(), 420);
		return () => clearTimeout(t);
	}, []);

	const send = () => {
		const q = query.trim();
		navigate(`/workspace${q ? `?q=${encodeURIComponent(q)}` : ""}`);
	};

	const recent = view.agents.slice(0, 3);

	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center gap-7 overflow-y-auto px-8 py-12">
			<div className="flex w-full max-w-[640px] flex-col items-center gap-7">
				{/* Greeting */}
				<div className="rise-in flex flex-col items-center text-center">
					<div className="flex items-center justify-center gap-3.5">
						<Orb state="composing" size={56} className="shrink-0" />
						<h1 className="text-[32px] font-semibold leading-snug tracking-[-0.8px] text-ink">
							{timeGreeting()}
							{userName ? `，${userName}` : ""}
						</h1>
					</div>
					<div className="mt-2 flex items-center justify-center gap-2 text-[14px] text-ink-subtle">
						<span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_6px_rgba(24,154,92,0.4)]" />
						{view.env
							? `${view.env.repos} · ${view.env.branch} · ${view.env.activeAgentCount} agent 运行中 · ${view.env.pendingCronCount} 定时任务待执行`
							: view.connected
								? "本地 serve"
								: "未连接"}
					</div>
					{!view.connected && (
						<div className="mt-3 flex items-center justify-center gap-3 text-[12px] text-ink-faint">
							<button
								type="button"
								onClick={() => void store.connect()}
								className="rounded border border-hairline bg-surface-2 px-3 py-1.5 text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
							>
								重试
							</button>
							<Link to="/settings" className="text-ink-muted underline-offset-2 hover:underline">
								去设置
							</Link>
						</div>
					)}
				</div>

				{/* Suggestions：错峰入场 */}
				<div className="flex flex-wrap items-center justify-center gap-2.5">
					{SUGGESTIONS.map((s, i) => (
						<Link
							key={s.label}
							to={s.to}
							className="rise-in flex cursor-pointer items-center gap-[7px] rounded-full border border-hairline bg-surface-2 px-4 py-2 text-[13px] text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-hairline-strong hover:text-ink active:scale-[0.97] active:translate-y-0"
							style={{ animationDelay: `${120 + i * 70}ms` }}
						>
							<s.icon size={14} strokeWidth={1.5} className="text-ink-subtle" />
							{s.label}
						</Link>
					))}
				</div>

				{/* Composer */}
				<div
					className="rise-in flex w-full max-w-[560px] items-end gap-2.5 rounded-[24px] border border-hairline bg-surface-2 py-2 pr-2 pl-4.5 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]"
					style={{ animationDelay: "360ms" }}
				>
					<input
						id="home-composer"
						value={query}
						onChange={e => setQuery(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") send();
						}}
						placeholder="给研发助手发一条指令…"
						className="flex-1 border-none bg-transparent py-1.5 text-[14px] text-ink outline-none placeholder:text-ink-faint"
					/>
					<button
						type="button"
						onClick={send}
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-all duration-150 hover:bg-accent-hover active:scale-90"
						aria-label="发送"
					>
						<ArrowRight size={16} strokeWidth={1.5} />
					</button>
				</div>
				<div
					className="rise-in flex w-full max-w-[560px] justify-center gap-4 text-[11px] text-ink-faint"
					style={{ animationDelay: "440ms" }}
				>
					<span>
						<span className="kbd">Enter</span> 发送直达会话工作台
					</span>
				</div>

				{/* 最近活跃 */}
				{recent.length > 0 && (
					<div className="rise-in w-full max-w-[560px]" style={{ animationDelay: "520ms" }}>
						<div className="mb-2.5 text-center text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							最近活跃
						</div>
						<div className="flex gap-2.5">
							{/* 最近活跃 agent：点击进入该 agent 会话（attach + switch） */}
							{recent.map((agent, i) => (
								<button
									type="button"
									key={agent.id}
									className="flex min-w-[160px] cursor-pointer items-center gap-2.5 rounded-xl border border-hairline bg-surface p-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-hairline-strong active:scale-[0.98] active:translate-y-0"
									onClick={() => {
										store.attach(agent.id);
										store.switchSession(agent.id);
										navigate("/workspace");
									}}
								>
									<span
										className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
										style={{ background: FACE_COLORS[i % FACE_COLORS.length] }}
									>
										{agent.face}
									</span>
									<span className="min-w-0">
										<span className="block text-[13px] font-medium text-ink">{agent.name}</span>
										<span className="block truncate text-[11px] text-ink-faint">
											{agent.lastAction ?? "—"}
										</span>
									</span>
									<span
										className={`ml-auto h-[7px] w-[7px] shrink-0 rounded-full ${agent.status === "online" ? "bg-success shadow-[0_0_6px_rgba(24,154,92,0.4)]" : "bg-warning shadow-[0_0_6px_rgba(185,124,30,0.4)] animate-pulse"}`}
									/>
								</button>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
