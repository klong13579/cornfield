import { Pause, Play, SkipBack, SkipForward, XCircle } from "lucide-react";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { type BranchPoint, CURRENT_SESSION_ID, type PlaybackEntry, toPlaybackEntries } from "../../lib/records";
import { type PlaybackSpeed, usePlayback } from "../../lib/use-playback";
import { useSessionStore } from "../../state/session-store";

/**
 * 会话回放（FR-3）—— 播放引擎（use-playback）驱动时间线逐步 reveal。
 * 数据源：serve get_messages 真数据（当前会话）；历史会话走 get_session_messages 读取 JSONL 时间线。
 * 控制：播放/暂停、快进/快退、速度 1x/2x/4x、进度条 + Step 计数、右侧时间线跳转。
 */
export function PlaybackView(): React.JSX.Element {
	const { id = "" } = useParams();
	const store = useSessionStore();
	const location = useLocation();
	// 历史会话：RecordsView 点击行时经 navigate state 携带 sessionFile；缺失则回放页给可见错误。
	const sessionFile = (location.state as { sessionFile?: string } | null)?.sessionFile ?? null;
	const [timeline, setTimeline] = useState<PlaybackEntry[] | null>(null);
	const [branchPoints, setBranchPoints] = useState<BranchPoint[]>([]);
	const [error, setError] = useState<string | null>(null);
	// 工具调用步骤展开集（key = `${entryId}:${ti}`）；默认折叠，过大 args/result 以截断预览呈现
	const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
	const toggleTool = (key: string) => {
		setOpenTools(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const scrollRef = useRef<HTMLDivElement>(null);

	// RecordsView 点击行时携 name 进来；缺失（直链/刷新）回落会话 id 短哈希。
	const histName = (location.state as { name?: string } | null)?.name;
	const title =
		id === CURRENT_SESSION_ID ? "当前会话（serve 真数据）" : histName?.trim() || `历史会话 · ${id.slice(0, 12)}`;

	useEffect(() => {
		let alive = true;
		if (id === CURRENT_SESSION_ID) {
			store
				.getMessages()
				.then(entries => {
					if (alive) setTimeline(entries);
				})
				.catch((err: unknown) => {
					if (alive) setError(err instanceof Error ? err.message : String(err));
				});
			// 分支候选（get_branch_messages 真命令；branch 跳转待 serve 实现）
			store
				.getBranchMessages()
				.then(points => {
					if (alive) setBranchPoints(points);
				})
				.catch(() => undefined);
		} else {
			// 历史会话：读取该会话 JSONL 时间线（get_session_messages 真命令）。
			if (!sessionFile) {
				if (alive) setError("缺少会话文件路径（sessionFile）——请从会话记录列表进入。");
				return;
			}
			// 契约（s2 并行实现 PiClient.getSessionMessages(sessionFile) → AgentMessageDto[]，
			// 并经 session-store 透传同签名；与 get_messages 返回完全同型）。本分支 s4 先行消费，
			// 方法未落地时保留运行期缺省并给出可见提示（不伪造数据）。
			if (!(store as unknown as { getSessionMessages?: unknown }).getSessionMessages) {
				if (alive) setError("历史会话时间线命令（get_session_messages）尚未就绪");
				return;
			}
			// 直接以方法调用形式执行（脱绑解引用会丢 this → #client undefined），返回 Promise.resolve 吞掉同步抛错路径
			Promise.resolve()
				.then(() =>
					(store as unknown as { getSessionMessages: (file: string) => Promise<unknown[]> }).getSessionMessages(
						sessionFile,
					),
				)
				.then(messages => {
					if (alive) setTimeline(toPlaybackEntries(messages));
				})
				.catch((err: unknown) => {
					if (alive) setError(err instanceof Error ? err.message : String(err));
				});
		}
		return () => {
			alive = false;
		};
	}, [id, store, sessionFile]);

	const playback = usePlayback(timeline?.length ?? 0);
	const revealed = useMemo(() => (timeline ? timeline.slice(0, playback.step) : []), [timeline, playback.step]);
	const currentIndex = playback.step - 1;

	// 播放时滚动跟随当前消息
	useEffect(() => {
		if (!scrollRef.current || playback.playing) return;
		const el = scrollRef.current.querySelector(`[data-entry="${currentIndex}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [currentIndex, playback.playing]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 控制条（回放页视觉主角） */}
			<div className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface px-6 py-3">
				<button
					type="button"
					className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover"
					onClick={playback.togglePlay}
					disabled={!timeline}
					aria-label={playback.playing ? "暂停" : "播放"}
				>
					{playback.playing ? (
						<Pause size={16} strokeWidth={1.5} fill="currentColor" />
					) : (
						<Play size={16} strokeWidth={1.5} fill="currentColor" className="ml-0.5" />
					)}
				</button>
				<button
					type="button"
					className="cbtn shrink-0"
					onClick={playback.prev}
					aria-label="快退"
					disabled={!timeline}
				>
					<SkipBack size={15} strokeWidth={1.5} />
				</button>
				<button
					type="button"
					className="cbtn shrink-0"
					onClick={playback.next}
					aria-label="快进"
					disabled={!timeline}
				>
					<SkipForward size={15} strokeWidth={1.5} />
				</button>

				<div className="flex gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
					{([1, 2, 4] as PlaybackSpeed[]).map(s => (
						<button
							key={s}
							type="button"
							className={`rounded px-2.5 py-0.5 font-mono text-[11px] transition-colors ${playback.speed === s ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
							onClick={() => playback.setSpeed(s)}
						>
							{s}x
						</button>
					))}
				</div>

				<div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded bg-surface-3">
					<div
						className="h-full rounded bg-accent transition-[width] duration-150"
						style={{ width: `${playback.progress * 100}%` }}
					/>
				</div>
				<span className="shrink-0 font-mono text-[11px] text-ink-subtle">
					Step {Math.min(playback.step, playback.entryCount)} / {playback.entryCount} ·{" "}
					{Math.round(playback.progress * 100)}%
				</span>
			</div>

			<div className="flex min-h-0 flex-1">
				{/* 转录区 */}
				<div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
					<div className="mx-auto flex max-w-[760px] flex-col gap-6">
						<div className="mb-1 flex items-baseline gap-2.5">
							<h1 className="text-[24px] font-semibold tracking-[-0.6px] text-ink">{title}</h1>
							{branchPoints.length > 0 && <span className="badge run">分支候选 {branchPoints.length}</span>}
							<Link
								to="/records"
								className="text-[12px] text-ink-muted no-underline hover:text-ink hover:underline"
							>
								← 返回列表
							</Link>
						</div>

						{!timeline && !error && (
							<div className="py-16 text-center text-[13px] text-ink-faint">加载消息中…</div>
						)}
						{error && (
							<div className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-[12.5px] text-danger">
								<XCircle size={13} className="text-danger" /> {error}
							</div>
						)}

						{timeline &&
							(timeline.length === 0 ? (
								<div className="py-16 text-center text-[13px] text-ink-faint">空会话 —— 没有可回放的消息。</div>
							) : null)}
						{revealed.map((entry, i) => (
							<div key={entry.id} data-entry={i} className="flex gap-3">
								{entry.role === "user" ? (
									<div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
										<div className="rounded-xl border border-hairline bg-user-bg px-3.5 py-2.5 text-ink">
											{entry.text}
										</div>
									</div>
								) : (
									<>
										<div className="avatar assistant shrink-0">π</div>
										<div className="min-w-0 flex-1">
											<div className="mb-1 text-[11px] tracking-[0.02em] text-ink-faint">
												{entry.model ?? "—"}
											</div>
											{entry.text && (
												<div className="leading-relaxed text-ink-muted">
													{entry.text.split("\n\n").map((p, pi) => (
														<p key={pi} className="mb-2 last:mb-0">
															{p}
														</p>
													))}
												</div>
											)}
											{entry.tools.map((tool, ti) => {
												const key = `${entry.id}:${ti}`;
												const open = openTools.has(key);
												return (
													<div key={ti} className="toolcard">
														<button
															type="button"
															className="head w-full cursor-pointer text-left"
															onClick={() => toggleTool(key)}
															aria-expanded={open}
														>
															<span className="tname">{tool.name}</span>
															<span className="state">
																{tool.state === "done" ? (
																	<span className="badge done">完成</span>
																) : (
																	<span className="badge fail">失败</span>
																)}
																<span className="ml-1 text-[11px] text-ink-faint">
																	{open ? "▲" : "▼"}
																</span>
															</span>
														</button>
														{tool.argsText && (
															<div className="args">
																{open
																	? tool.argsText
																	: tool.argsText.length > 120
																		? `${tool.argsText.slice(0, 120)}…`
																		: tool.argsText}
															</div>
														)}
														{tool.result && (
															<div className="result">
																{open
																	? tool.result
																	: tool.result.length > 200
																		? `${tool.result.slice(0, 200)}…`
																		: tool.result}
															</div>
														)}
													</div>
												);
											})}
										</div>
									</>
								)}
							</div>
						))}
					</div>
				</div>

				{/* 时间线导航 */}
				{timeline && timeline.length > 1 && (
					<aside className="hidden min-w-0 flex-1 overflow-y-auto border-l border-hairline bg-surface p-4 lg:w-[240px] lg:shrink-0 lg:block">
						<h3 className="mb-3 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							时间线 · {timeline.length}
						</h3>
						<div className="flex flex-col gap-1">
							{timeline.map((entry, i) => (
								<button
									key={entry.id}
									type="button"
									className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${i === currentIndex ? "bg-accent-dim" : "hover:bg-surface-2"}`}
									onClick={() => playback.seek(i + 1)}
								>
									<span
										className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.role === "user" ? "bg-ink-subtle" : "bg-success"}`}
									/>
									<span
										className={`min-w-0 truncate font-mono text-[11px] ${i === currentIndex ? "text-ink" : "text-ink-faint"}`}
									>
										{entry.role === "user" ? "U" : "A"}·{entry.model ? shortModel(entry.model) : "—"}
									</span>
									<span
										className={`ml-auto text-[10px] ${i < currentIndex ? "text-success" : "text-ink-faint"}`}
									>
										{i < currentIndex ? "✓" : `${i + 1}`}
									</span>
								</button>
							))}
							{branchPoints.length > 0 && (
								<div className="mt-4 border-t border-hairline pt-3">
									<h4 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										分支候选（get_branch_messages）
									</h4>
									<div className="flex flex-col gap-1.5">
										{branchPoints.map(p => (
											<div key={p.entryId} className="rounded-md bg-surface-2 px-2 py-1.5">
												<div className="truncate font-mono text-[10px] text-ink-faint">{p.entryId}</div>
												<div className="truncate text-[12px] text-ink-muted">{p.text}</div>
											</div>
										))}
									</div>
									<div className="mt-1.5 text-[10px] text-ink-faint">
										branch 跳转待 serve branch 命令（get_branch_messages 候选数据已真）
									</div>
								</div>
							)}
						</div>
					</aside>
				)}
			</div>
		</div>
	);
}

function shortModel(model: string): string {
	const parts = model.split("/");
	return parts[parts.length - 1].length > 14
		? `${parts[parts.length - 1].slice(0, 12)}…`
		: (parts[parts.length - 1] ?? model);
}
