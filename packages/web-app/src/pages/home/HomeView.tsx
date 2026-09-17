import { ArrowRight, Bot, CalendarDays, Cpu, History, Mic, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Orb } from "../../components/Orb";
import { ProjectSection } from "../../components/ProjectContext";
import { AgentSwitcher } from "../../layout/AgentSwitcher";
import { attributionTextOf, sessionAttributionOf } from "../../lib/project-read-model";
import { activeAgentIdOf, activeAgentOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { AGENT_SECTION_TITLE, composerPlaceholder, envSummaryText, shouldSubmitOnEnter } from "./home-logic";

/**
 * Home 欢迎页（FR-9，EmptyState：Greeting → 快速会话 → Suggestions → 已注册 Agent）。
 *
 * 快速会话不是「另一个聊天窗口」：它就是本连接当前焦点会话本身，只是把最近一轮搬到首页。
 * 发出去的消息由 serve 定向下拉的那个 Agent 服务，回复直接来自权威快照/流式帧 ——
 * 首页不造任何示例数据，也不在前端拼一条「模拟回复」。
 *
 * 切 Agent 是真实动作（attach + switch_session）：serve 侧焦点跟着切，随后推来那个 Agent
 * 的权威快照；切换瞬间转录被清空而不是留着上一个 Agent 的内容（见 store.#setActiveAgent）。
 */

const SUGGESTIONS = [
	{ icon: CalendarDays, label: "检查今天的定时任务", to: "/tasks" },
	{ icon: History, label: "最近会话回顾", to: "/records" },
	{ icon: Mic, label: "语音记录一条指令", to: "/voice" },
	{ icon: Cpu, label: "切换模型", to: "/models" },
	{ icon: Bot, label: "打开 Agent 管理", to: "/agents" },
];

// 人物配色
const FACE_COLORS = ["#e4e4e7", "#d4d4d8", "#ececee"];

const CONNECT_TIMEOUT_MS = 10_000;

function timeGreeting(): string {
	const h = new Date().getHours();
	if (h < 6) return "夜深了";
	if (h < 12) return "早上好";
	if (h < 14) return "中午好";
	if (h < 18) return "下午好";
	return "晚上好";
}

/** 取转录里最后一轮问答（首页只展示最近这一次往返，完整转录在会话工作台）。 */
function lastExchange(view: ReturnType<typeof useSession>): { user?: string; reply?: string; streaming: boolean } {
	const messages = view.messages;
	let user: string | undefined;
	let reply: string | undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			reply ??= msg.text;
			continue;
		}
		user ??= msg.text;
		if (reply !== undefined) break;
	}
	if (view.live?.text !== undefined) reply = view.live.text;
	return { user, reply, streaming: view.isStreaming };
}

export function HomeView(): React.JSX.Element {
	const navigate = useNavigate();
	const view = useSession();
	const store = useSessionStore();
	const [query, setQuery] = useState("");
	const [userName, setUserName] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [connecting, setConnecting] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);

	// 问候名与快速会话的对话区使用同一个焦点 Agent（不再逐个 agent 试读）
	const agentId = activeAgentIdOf(view);
	const agent = activeAgentOf(view);

	useEffect(() => {
		// 问候名：依次尝试各 agent 的 user.md（declarative persona）解析 name；
		// default（serve cwd）常无 user.md，fallback 到有声明的 agent（hr/me 等同源）。
		let cancelled = false;
		if (view.connected) {
			const candidates = ["default", ...view.agents.map(a => a.id)];
			void (async () => {
				for (const candidate of candidates) {
					if (cancelled) return;
					try {
						const { text } = await store.fsRead(candidate, "user.md");
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
		const t = setTimeout(() => inputRef.current?.focus(), 420);
		return () => clearTimeout(t);
	}, []);

	useEffect(() => {
		if (view.connected) {
			setConnectError(null);
			setConnecting(false);
		}
	}, [view.connected]);

	const exchange = useMemo(() => lastExchange(view), [view]);
	const project = useMemo(() => attributionTextOf(sessionAttributionOf(view)), [view]);
	const canSend = view.connected && !view.isStreaming && query.trim().length > 0;

	/** 切到某个 Agent：serve 侧焦点 + 权威快照一起过来（不是前端滤镜）。 */
	const selectAgent = (id: string): void => {
		store.focusAgent(id);
	};

	const send = (): void => {
		const text = query.trim();
		if (!text || !view.connected || view.isStreaming) return;
		// 焦点与目标不一致时必须先切：serve 只把某个 Agent 的流推给焦点在它上面的连接，
		// 否则消息发过去了，回复却不会来到这个页面。
		if (agentId && view.sessionId !== agentId) store.switchSession(agentId);
		store.prompt(text, agentId);
		setQuery("");
	};

	const agents = view.agents;

	/** 断连态重试：进行中反馈 + 失败原因上屏。connect 在传输层失败时可能不 settle，用超时兜底。 */
	const retry = async (): Promise<void> => {
		if (connecting) return;
		setConnecting(true);
		setConnectError(null);
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("连接超时：serve 未响应，请确认它已启动后重试")), CONNECT_TIMEOUT_MS);
		});
		try {
			await Promise.race([store.connect(), timeout]);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
		} finally {
			setConnecting(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center gap-7 overflow-y-auto px-8 py-12">
			<div className="flex w-full max-w-[760px] flex-col items-center gap-8">
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
						<span className="conn-dot" />
						{view.env ? envSummaryText(view.env) : view.connected ? "本地 serve" : "未连接"}
					</div>
					{!view.connected && (
						<div className="mt-3 flex flex-col items-center justify-center gap-2 text-[12px] text-ink-faint">
							<div className="flex items-center justify-center gap-3">
								<button
									type="button"
									onClick={() => void retry()}
									disabled={connecting}
									className="rounded border border-hairline bg-surface-2 px-3 py-1.5 text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-60"
								>
									{connecting ? "连接中…" : "重试"}
								</button>
								<Link to="/settings" className="text-ink-muted underline-offset-2 hover:underline">
									去设置
								</Link>
							</div>
							{connectError && <span className="text-danger">{connectError}</span>}
						</div>
					)}
				</div>

				{/* 快速会话：当前焦点 Agent 的最近一轮 + 直接发送 */}
				<section className="rise-in w-full rounded-xl border border-hairline bg-surface p-4 [animation-delay:80ms]">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							快速会话
						</span>
						<span className="flex-1" />
						{/* 与工作台顶栏同一件控件：切 Agent 的语义只有一处（store.focusAgent） */}
						<AgentSwitcher view={view} onSelect={selectAgent} />
					</div>

					{/* 上下文：Agent / 工作区 / 会话 分开显示，各自有各自的来源 */}
					<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-subtle">
						<span>
							Agent <b className="font-medium text-ink-muted">{agent?.name ?? "未选择"}</b>
						</span>
						<span className="text-ink-faint">/</span>
						<span title={project.title}>
							Project <b className="font-medium text-ink-muted">{project.label}</b>
						</span>
						<span className="text-ink-faint">/</span>
						<span>
							工作区{" "}
							<b className="font-medium text-ink-muted">{view.activeWorkspace ?? view.env?.repos ?? "—"}</b>
						</span>
						<span className="text-ink-faint">/</span>
						<span>
							会话 <b className="font-medium text-ink-muted">{view.sessionName ?? view.sessionId ?? "无"}</b>
						</span>
					</div>

					{/* 最近一轮（真实转录；没有就空态，不编一条回复出来） */}
					<div className="mt-3 min-h-[64px] rounded-lg border border-hairline bg-surface-2 px-3 py-2.5">
						{!view.connected ? (
							<p className="text-[12.5px] text-ink-faint">未连接 serve——连接后这里显示当前 Agent 的最近一轮。</p>
						) : !exchange.user && !exchange.reply ? (
							<p className="text-[12.5px] text-ink-faint">
								{agent
									? `还没有对话内容。在下面发一条，${agent.name} 的回复会出现在这里。`
									: "还没有可用 Agent——先去 Agent 管理创建或注册一个。"}
							</p>
						) : (
							<>
								{exchange.user && (
									<div className="mb-1.5 flex gap-2">
										<span className="mt-[3px] shrink-0 text-[10.5px] font-semibold text-ink-faint">你</span>
										<p className="min-w-0 flex-1 line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] text-ink-muted">
											{exchange.user}
										</p>
									</div>
								)}
								<div className="flex gap-2">
									<span className="mt-[3px] shrink-0 text-[10.5px] font-semibold text-ink-faint">
										{agent?.name ?? "Agent"}
									</span>
									<p className="min-w-0 flex-1 line-clamp-4 whitespace-pre-wrap break-words text-[12.5px] text-ink">
										{exchange.reply ?? (exchange.streaming ? "" : "（暂无回复）")}
										{exchange.streaming && <span className="caret ml-0.5 align-middle" />}
									</p>
								</div>
								<button type="button" className="link mt-2" onClick={() => navigate("/workspace")}>
									查看完整对话
								</button>
							</>
						)}
					</div>

					{/* Composer：直接发给当前 Agent（同一会话，不新建） */}
					<div className="mt-3 flex items-end gap-2.5 rounded-lg border border-hairline bg-surface-2 py-2 pr-2 pl-4 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
						<input
							id="home-composer"
							ref={inputRef}
							value={query}
							onChange={e => setQuery(e.target.value)}
							onKeyDown={e => {
								if (shouldSubmitOnEnter(e.key, e.nativeEvent.isComposing)) send();
							}}
							disabled={!view.connected || view.isStreaming}
							placeholder={composerPlaceholder(agent?.name)}
							className="flex-1 border-none bg-transparent py-1.5 text-[14px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
						/>
						<button
							type="button"
							onClick={send}
							disabled={!canSend}
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-all duration-150 hover:bg-accent-hover active:scale-95 disabled:opacity-40"
							aria-label="发送"
						>
							<Send size={15} strokeWidth={1.5} />
						</button>
					</div>
					<div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-ink-faint">
						<span>
							<span className="kbd">Enter</span> 发送到当前会话
						</span>
						<button type="button" className="link" onClick={() => navigate("/workspace")}>
							转入会话工作台（同一会话）
						</button>
					</div>
				</section>

				{/* Project registry（真实读数：列表 / 空态 / 读取失败态） */}
				<ProjectSection view={view} onRefresh={() => void store.refreshProjects(agentId)} />

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

				{/* 已注册 Agent：点击进入该 agent 会话（attach + switch）。没有「活跃」数据，不冒充「最近活跃」。 */}
				{agents.length > 0 && (
					<div className="w-full">
						<div className="mb-2.5 text-center text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							{AGENT_SECTION_TITLE}
						</div>
						<div className="flex flex-wrap justify-center gap-2.5">
							{agents.map((item, i) => (
								<button
									type="button"
									key={item.id}
									className="flex min-w-[160px] cursor-pointer items-center gap-2.5 rounded-xl border border-hairline bg-surface p-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-hairline-strong active:scale-[0.98] active:translate-y-0"
									onClick={() => {
										selectAgent(item.id);
										navigate("/workspace");
									}}
								>
									<span
										className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-ink"
										style={{ background: FACE_COLORS[i % FACE_COLORS.length] }}
									>
										{item.face}
									</span>
									<span className="min-w-0 truncate text-[13px] font-medium text-ink">{item.name}</span>
									<span
										className={`ml-auto shrink-0 ${item.status === "online" ? "conn-dot" : "conn-dot warn animate-pulse"}`}
									/>
								</button>
							))}
						</div>
					</div>
				)}

				{/* 保留原有入口：工作台直达（空会话，不开新会话） */}
				<div className="flex items-center gap-4 text-[11px] text-ink-faint">
					<button type="button" className="link" onClick={() => navigate("/workspace")}>
						打开会话工作台 <ArrowRight size={11} strokeWidth={1.5} className="inline align-middle" />
					</button>
				</div>
			</div>
		</div>
	);
}
