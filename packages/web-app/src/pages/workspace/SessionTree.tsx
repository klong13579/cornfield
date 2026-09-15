import { AlertTriangle, ArrowDownToLine, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { BroughtBackChildResultDto } from "../../lib/pi-client-api";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import { resultStateOf, STATUS_BADGE, STATUS_LABEL, shortTime } from "./session-tree-logic";

/**
 * 会话树（T8，FR-1/§8）—— 当前会话作为 Root，下面挂它直接委派出去的子会话。
 *
 * 数据只有一条来源：serve `get_session_tree`（父会话自己的账本）。
 * 三件事在这里被刻意分开显示，因为它们不是一回事：
 *   - 查不到（未连接 / 账本读失败）≠ 没有子会话（正常答案：空数组）
 *   - 结果就绪 ≠ 结果已带回（只有前者才能点「带回」）
 *   - 「这次才带回」≠「此前已带回」（重复带回不会二次注入，UI 也必须说清）
 */

export function SessionTree(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const agentId = activeAgentIdOf(view);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | undefined>();
	const [brought, setBrought] = useState<BroughtBackChildResultDto | undefined>();

	// 会话换人就重查：换了 Agent / 开了新会话后，上一个会话的子树与带回预览不得留在屏幕上。
	const sessionKey = view.sessionFile ?? view.sessionId;
	useEffect(() => {
		setBrought(undefined);
		setActionError(undefined);
		if (!view.connected) return;
		void store.refreshSessionTree(agentId);
	}, [store, view.connected, agentId, sessionKey]);

	const children = view.sessionTree?.children ?? [];
	const bringBack = async (childSessionId: string): Promise<void> => {
		setBusyId(childSessionId);
		setActionError(undefined);
		try {
			setBrought(await store.bringBackChild(childSessionId, agentId));
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyId(null);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between px-2 pt-2 pb-1.5">
				<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">会话树</span>
				<button
					type="button"
					className="cbtn"
					onClick={() => void store.refreshSessionTree(agentId)}
					disabled={!view.connected}
					aria-label="刷新会话树"
					title="刷新会话树"
				>
					<RefreshCw size={13} strokeWidth={1.5} className={view.sessionTreeLoading ? "spin" : undefined} />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{!view.connected && (
					<div className="px-2 py-10 text-center text-[12px] text-ink-faint">未连接——会话树不可用</div>
				)}

				{view.connected && view.sessionTreeError && (
					<div className="mx-1 mt-1 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
						<AlertTriangle size={13} strokeWidth={1.5} className="mt-0.5 shrink-0" />
						<span className="min-w-0 flex-1 break-words">
							会话树读取失败：{view.sessionTreeError}
							<span className="mt-0.5 block text-[11px] text-ink-subtle">
								读不到和「没有子会话」不是一回事，这里不显示空树。
							</span>
						</span>
					</div>
				)}

				{view.connected && !view.sessionTreeError && (
					<>
						{/* Root：当前会话本身 */}
						<div className="mb-1 rounded-lg border border-hairline bg-surface-2 px-2.5 py-2">
							<div className="flex items-center gap-1.5">
								<span className="h-[7px] w-[7px] shrink-0 rounded-[3px] bg-accent" />
								<span className="min-w-0 flex-1 truncate text-[13px] text-ink">
									{view.sessionName ?? view.sessionId ?? "当前会话"}
								</span>
								<span className="badge">root</span>
							</div>
							<div className="mt-0.5 truncate text-[11px] text-ink-faint">
								{view.activeWorkspace ?? "—"}
								{view.isStreaming ? " · 进行中" : ""}
							</div>
						</div>

						{children.length === 0 && (
							<div className="px-2 py-8 text-center text-[12px] text-ink-faint">
								{view.sessionTreeLoading ? "读取中…" : "当前会话没有委派子会话"}
							</div>
						)}

						{children.map(child => {
							const state = resultStateOf(child);
							return (
								<div
									key={child.sessionId}
									className="mb-1.5 rounded-lg border border-hairline bg-surface px-2.5 py-2"
								>
									<div className="flex items-center gap-1.5">
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">└─</span>
										<span className="min-w-0 flex-1 truncate text-[13px] text-ink">
											{child.objective ?? child.delegationRole ?? child.sessionId.slice(0, 8)}
										</span>
										<span className={STATUS_BADGE[child.status]}>{STATUS_LABEL[child.status]}</span>
									</div>

									<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
										{child.delegationRole && <span>{child.delegationRole}</span>}
										<span>depth {child.depth}</span>
										<span>{shortTime(child.updatedAt)}</span>
										<span className={state.canBringBack ? "text-warning" : undefined}>{state.label}</span>
										{child.lastPid !== undefined && <span className="font-mono">pid {child.lastPid}</span>}
									</div>

									{child.escalation && (
										<div className="mt-1 rounded border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] text-warning">
											等父会话（{child.escalation.blocking}）：{child.escalation.question || "（未附问题）"}
										</div>
									)}
									{!child.escalation && child.statusDetail && (
										<div className="mt-1 text-[11px] text-ink-subtle">{child.statusDetail}</div>
									)}

									<div className="mt-1.5 flex items-center gap-2">
										<button
											type="button"
											className="btn-secondary cbtn"
											disabled={!state.canBringBack || busyId !== null}
											onClick={() => void bringBack(child.sessionId)}
											title={
												state.canBringBack
													? `带回 ${child.resultRef}`
													: child.resultRef
														? "该结果此前已带回"
														: "子会话还没有产出结果"
											}
										>
											<ArrowDownToLine size={12} strokeWidth={1.5} />
											{busyId === child.sessionId ? "带回中…" : "带回结果"}
										</button>
										{child.resultRef && (
											<span
												className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint"
												title={child.resultRef}
											>
												{child.resultRef}
											</span>
										)}
									</div>
								</div>
							);
						})}
					</>
				)}

				{actionError && (
					<div className="mx-1 mt-1 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
						带回失败：{actionError}
					</div>
				)}

				{brought && (
					<div className="mx-1 mt-2 rounded-lg border border-hairline bg-surface-2 px-2.5 py-2">
						<div className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
							<span className="font-mono text-[10px]">{brought.childSessionId.slice(0, 8)}</span>
							{/* 「这次才带回」与「此前已带回」必须分开说：后者没有第二次注入 */}
							<span>
								{brought.firstTime
									? brought.injected
										? "本次带回，已并入父会话"
										: "本次带回"
									: "此前已带回，未重复注入"}
							</span>
							<button type="button" className="link ml-auto" onClick={() => setBrought(undefined)}>
								收起
							</button>
						</div>
						<pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-ink-muted">
							{brought.content}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
