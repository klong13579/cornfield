import { AlertTriangle, ArrowDownToLine, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { BroughtBackChildResultDto, ChildSessionNodeDto, DelegatedChildDto } from "../../lib/pi-client-api";
import { activeAgentIdOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	childProcessStateOf,
	delegateAgentOptions,
	delegateFailureNote,
	delegateSubmitState,
	focusProcessState,
	resultStateOf,
	STATUS_BADGE,
	STATUS_LABEL,
	shortTime,
} from "./session-tree-logic";

/**
 * 会话树（T8，FR-1/§8）—— 当前会话作为 Root，下面挂它直接委派出去的子会话。
 *
 * 数据只有一条来源：serve `get_session_tree`（父会话自己的账本）。
 * 几件被刻意分开显示的事，因为它们不是一回事：
 *   - 查不到（未连接 / 账本读失败）≠ 没有子会话（正常答案：空数组）
 *   - 结果就绪 ≠ 结果已带回（只有前者才能点「带回」）
 *   - 「这次才带回」≠「此前已带回」（重复带回不会二次注入，UI 也必须说清）
 *   - 任务状态（这次委派走到哪）≠ 进程状态（有没有进程在服务它）≠ 结果状态 —— 三个维度各画
 *     各的；进程那一维说不出凭据时就写「未知」（口径见 `./session-tree-logic`）
 *
 * 委派同理：不先画一行「启动中」的子会话再等回执 —— 子会话只从账本里长出来（成功就刷新同一条
 * `get_session_tree`）。失败照样把 serve 的原话摆出来，**并且照样重读账本**：serve 在起不来 /
 * 没过注册门时会把节点写成 `failed` 再报错，客户端无从知道那一次到底有没有起子会话。
 * （进程那一维的「启动中」不是这一条的反例：它只画在**账本已经给出的那条节点**上，凭据是手上
 * 那次还没有 pid 的委派回执，不会凭空多出一行子树。）
 */

/**
 * 子会话卡片（受控、无 hook）。三个维度的读数都在卡片里算 —— 任务状态 / 结果状态 / 进程
 * 状态，口径见 `./session-tree-logic`；本组件只管画。无 hook 是为了让单测能直接调用它，
 * 把屏上的字与按钮的可用性钉住，不必起一个 DOM。
 */
export function ChildSessionCard({
	child,
	startingChildId,
	busy,
	bringingBack,
	onBringBack,
}: {
	child: ChildSessionNodeDto;
	/** 手上那次「刚发出、还没有 pid」的委派（`starting` 唯一的凭据）。 */
	startingChildId?: string;
	/** 有任何一条正在带回中（一次一个，所以别的卡片也点不动）。 */
	busy: boolean;
	/** 正在带回的就是这一条。 */
	bringingBack: boolean;
	onBringBack: (sessionId: string) => void;
}): React.JSX.Element {
	const state = resultStateOf(child);
	const process = childProcessStateOf(child, { startingChildId });
	return (
		<div className="mb-1.5 rounded-lg border border-hairline bg-surface px-2.5 py-2">
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
				{/* 进程这一格的依据（含账本记着的 pid）都进 detail：不在屏上摆一个裸 pid */}
				<span className={process.state === "unknown" ? "text-ink-subtle" : undefined} title={process.detail}>
					进程 {process.label}
				</span>
			</div>

			{/* 「未知」必须在屏上说明缺什么，不能只给一个没解释的词 */}
			{process.state === "unknown" && <div className="mt-1 text-[11px] text-ink-subtle">{process.detail}</div>}

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
					disabled={!state.canBringBack || busy}
					onClick={() => onBringBack(child.sessionId)}
					title={
						state.canBringBack
							? `带回 ${child.resultRef}`
							: child.resultRef
								? "该结果此前已带回"
								: "子会话还没有产出结果"
					}
				>
					<ArrowDownToLine size={12} strokeWidth={1.5} />
					{bringingBack ? "带回中…" : "带回结果"}
				</button>
				{child.resultRef && (
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint" title={child.resultRef}>
						{child.resultRef}
					</span>
				)}
			</div>
		</div>
	);
}

export function SessionTree(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const agentId = activeAgentIdOf(view);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | undefined>();
	const [brought, setBrought] = useState<BroughtBackChildResultDto | undefined>();
	const [objective, setObjective] = useState("");
	const [targetAgentId, setTargetAgentId] = useState("");
	const [delegating, setDelegating] = useState(false);
	const [delegateError, setDelegateError] = useState<string | undefined>();
	const [delegated, setDelegated] = useState<DelegatedChildDto | undefined>();

	// 会话换人就重查：换了 Agent / 开了新会话后，上一个会话的子树与带回预览不得留在屏幕上。
	const sessionKey = view.sessionFile ?? view.sessionId;
	useEffect(() => {
		setBrought(undefined);
		setActionError(undefined);
		setDelegateError(undefined);
		setDelegated(undefined);
		setTargetAgentId("");
		if (!view.connected) return;
		void store.refreshSessionTree(agentId);
	}, [store, view.connected, agentId, sessionKey]);

	const children = view.sessionTree?.children ?? [];
	// 「刚发出、还没有 pid 的那次委派」是 `starting` 唯一的凭据（见 session-tree-logic 的说明）：
	// 账本里倒推不出来，所以只认手上这一条回执，并且只在它的 pid 真缺省时才成立。
	const startingChildId = delegated?.pid === undefined ? delegated?.sessionId : undefined;
	const rootProcess = focusProcessState(view.sessionTree);
	const submit = delegateSubmitState({ objective, busy: delegating });
	const delegate = async (): Promise<void> => {
		// 提交时的会话身份：这一次委派的回执只属于这个会话。
		const submitted = store.sessionIdentity();
		setDelegating(true);
		setDelegateError(undefined);
		try {
			const child = await store.delegateChild(
				{ objective: objective.trim(), ...(targetAgentId ? { agentId: targetAgentId } : {}) },
				agentId,
			);
			// 迟到的回执：用户已经换了会话 / Agent —— 它属于上一个会话（store 那边同样没有把
			// 上一个会话的账本刷进来），显示在这里就是把别人的结果挂在当前会话名下。
			if (store.sessionIdentity() !== submitted) return;
			setDelegated(child);
			setObjective("");
		} catch (err) {
			// 失败也一样：换过会话就不拿它去报另一个会话的错 —— 那条委派（和它在账本里的
			// 失败节点）属于上一个会话，回到那里才看得见。
			if (store.sessionIdentity() !== submitted) return;
			setDelegateError(err instanceof Error ? err.message : String(err));
		} finally {
			setDelegating(false);
		}
	};
	const bringBack = async (childSessionId: string): Promise<void> => {
		// 同一条纪律：带回的内容也是一种回执，落不到别的会话里。
		const submitted = store.sessionIdentity();
		setBusyId(childSessionId);
		setActionError(undefined);
		try {
			const result = await store.bringBackChild(childSessionId, agentId);
			if (store.sessionIdentity() !== submitted) return;
			setBrought(result);
		} catch (err) {
			if (store.sessionIdentity() !== submitted) return;
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

				{/* 委派：会话树唯一的写入口。目标 Agent 缺省 = 当前会话自己的 Agent。 */}
				{view.connected && (
					<form
						className="mb-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 py-2"
						onSubmit={event => {
							event.preventDefault();
							if (submit.canSubmit) void delegate();
						}}
					>
						<input
							value={objective}
							onChange={e => setObjective(e.target.value)}
							placeholder="这次委派要它做什么"
							spellCheck={false}
							className="w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
						/>
						<div className="mt-1.5 flex items-center gap-2">
							<select
								value={targetAgentId}
								onChange={e => setTargetAgentId(e.target.value)}
								aria-label="委派给哪个 Agent"
								className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
							>
								<option value="">{agentId ? `本 Agent（${agentId}）` : "本 Agent"}</option>
								{delegateAgentOptions(view.agents, agentId).map(agent => (
									<option key={agent.id} value={agent.id}>
										{agent.name}（{agent.id}）
									</option>
								))}
							</select>
							<button type="submit" className="btn-secondary cbtn" disabled={!submit.canSubmit}>
								<Plus size={12} strokeWidth={1.5} />
								{delegating ? "委派中…" : "委派子会话"}
							</button>
						</div>
						{submit.hint && !delegating && <div className="mt-1 text-[11px] text-ink-faint">{submit.hint}</div>}
					</form>
				)}

				{delegateError && (
					<div className="mx-1 mb-1 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
						<AlertTriangle size={13} strokeWidth={1.5} className="mt-0.5 shrink-0" />
						<span className="min-w-0 flex-1 break-words">
							委派失败：{delegateError}
							<span className="mt-0.5 block text-[11px] text-ink-subtle">
								{delegateFailureNote(view.sessionTreeError)}
							</span>
						</span>
					</div>
				)}

				{delegated && (
					<div className="mx-1 mb-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-subtle">
						<span className="font-mono text-[10px]">{delegated.sessionId.slice(0, 8)}</span>
						<span className="ml-1">已委派并写入账本（pid {delegated.pid ?? "—"}）</span>
					</div>
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
							{/* 进程是独立一维读数（与状态徽标、结果状态不是一回事），依据写在 title 里 */}
							<div className="mt-0.5 truncate text-[11px] text-ink-faint" title={rootProcess.detail}>
								进程 <span className="text-ink-subtle">{rootProcess.label}</span>
							</div>
						</div>

						{children.length === 0 && (
							<div className="px-2 py-8 text-center text-[12px] text-ink-faint">
								{view.sessionTreeLoading ? "读取中…" : "当前会话没有委派子会话"}
							</div>
						)}

						{children.map(child => (
							<ChildSessionCard
								key={child.sessionId}
								child={child}
								startingChildId={startingChildId}
								busy={busyId !== null}
								bringingBack={busyId === child.sessionId}
								onBringBack={childSessionId => void bringBack(childSessionId)}
							/>
						))}
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
