import { useSyncExternalStore } from "react";
import type { ContextItem, ContextItemFacts, ContextItemKind } from "../lib/context-items";
import {
	contextItemFacts,
	dedupeContextItems,
	makeFileContextItem,
	makeSelectionContextItem,
	selectionLineRange,
} from "../lib/context-items";
import type { FsReadResult, FsWriteResult, PiClient } from "../lib/pi-client-api";
import { FsConflictError } from "../lib/pi-client-api";
import { activeAgentIdOf } from "./agent-context";
import type { SessionView } from "./session-store";

/**
 * 文件编辑 + 上下文项 + Diff 审阅 的工作流状态（本会话的文件工作区）。
 *
 * ## 为什么是一个 store 而不是三个
 *
 * 打开的文件、没保存的草稿、选区引用、正在看的 diff，回答的是同一个问题：「本会话此刻在
 * 哪个文件上、改到哪了、要带走什么」。它们的**归属是同一条**（会话身份），生命周期也是同
 * 一条（换会话一起作废）。拆成三个 store 就得把身份作废逻辑抄三遍，抄漏一处就是上一个会话的
 * 草稿留在了新会话的屏幕上。
 *
 * ## 两个身份不要揉
 *
 *   **会话身份**（附件地址）＝ 「在哪个工作根里」—— fs_read/fs_write 的 `sessionId` 就是它，
 *    文件路径相对它解。它才是写盘目标。
 *   **归属 Agent**   ＝ 「是谁的」—— 解 agentDir 算范围、面板上显示归属。
 *
 * 一个 Agent 可以有多个附件（绑不同 Project），两者因此不是一回事；拿 Agent 名去指会话，
 * 拿到的永远是「那个 Agent 自己根上的附件」。
 *
 * ## 写盘的唯一真相
 *
 * 保存走 fs_write 的 compare-and-swap：带打开时读到的 `version`，服务端对不上就拒绝且一个
 * 字节都不写（见 pi-client-api 的 {@link FsConflictError}）。所以「草稿丢了别人的改动」这条
 * 路径根本不存在——只存在「你的保存被拒绝，选哪一份」。
 *
 * ## 与 UI 的边界
 *
 * 这里只有状态与判定，没有 DOM：选区在 UI 侧转成 (path, text, lineStart, lineEnd) 再进来，
 * 组件不会自己拿 fs_read/fs_write 绕过本 store 去写盘（那就等于存在两套文件编辑 runtime）。
 */

/** 保存被拒绝时磁盘上的那一份：留着给「看差异」和「保留磁盘版本」。 */
export interface EditorConflict {
	/** 服务端拒绝判决原文（`fs_conflict: expected …, actual …`）。 */
	detail: string;
	diskText: string;
	diskVersion: string;
}

/** 当前打开的一份文件。 */
export interface OpenFile {
	/** 会话工作面相对路径（fs_read/fs_write 入参）。 */
	path: string;
	/**
	 * **wire 目标 = 会话身份**（附件地址）：fs_read/fs_write/探测读的 `sessionId` 就是它。
	 * 打开时固定，不随后续会话切换漂移 —— 写盘只能落在“这份文件当时所在的那个根”里。
	 */
	attachmentAddress: string;
	/** 归属/展示 Agent（这份文件是它的工作面里的）：解 agentDir 算范围、面板上显示“来自哪个 Agent”。
	 * **不参与** fs 定向——归属是“是谁的”，不是“在哪个根里”，二者可以不同（一个 Agent 多个附件）。 */
	agentId: string;
	/** 磁盘上那一份（编辑器 base）：保存时回传 baseVersion 做 CAS。 */
	baseText: string;
	baseVersion: string;
	/** 编辑器里的草稿。 */
	draft: string;
	/** 草稿与 base 不同 = 有未保存修改。 */
	dirty: boolean;
	/** 文件被 fs_read 截断（>128KB）：拿不到全文就不能安全写回，编辑与保存都关闭。 */
	readOnly: boolean;
	loading: boolean;
	error: string | null;
	conflict: EditorConflict | null;
	/** 无用户改动的前提下磁盘被外部改写，视图已同步到新版（一句说明，不是错误）。 */
	externalUpdate: boolean;
	/** 会话身份已变：这份草稿属于上一个会话的路径，不再允许保存（等用户处置，不静默丢）。 */
	orphaned: boolean;
}

/** 待确认的“带未保存修改换文件”。 */
export interface PendingOpen {
	attachmentAddress: string;
	agentId: string;
	path: string;
}

/** Diff 审阅面板状态。 */
export interface DiffReview {
	title: string;
	/** 服务端 generateUnifiedDiffString 的带行号统一 diff（解析交给 diff-format）。 */
	text: string;
	loading: boolean;
	error: string | null;
}

export interface FileWorkflowView {
	/** 当前会话身份（`附件地址|sessionFile`）；未连接时为空串。 */
	identity: string;
	open: OpenFile | null;
	/** 待带走的下一条消息的上下文条目（每条带 scope 与 version —— 见下面的创建处）。 */
	contextItems: ContextItem[];
	diff: DiffReview | null;
	pendingOpen: PendingOpen | null;
}

/** 本 store 从会话视图读到的全部字段（SessionView 满足）。 */
export type FileWorkflowSessionView = Pick<
	SessionView,
	| "activeAgentId"
	// 会话身份（焦点附件的地址）：换会话的作废判定按它算 —— 路径是相对那个工作根解析的。
	| "attachmentAddress"
	| "sessionFile"
	| "isStreaming"
	| "agents"
	// 范围判定的锚点：条目归属 Agent 的家（agents[].agentDir）+ 会话所属 Project 的 root。
	| "projects"
	| "currentProjectId"
>;

/** store 依赖：只需要它用到的三条 fs 命令 + 会话身份/回合信号。 */
export interface FileWorkflowDeps {
	client: Pick<PiClient, "fsRead" | "fsWrite" | "fsDiff">;
	sessions: {
		getSnapshot(): FileWorkflowSessionView;
		subscribe(listener: () => void): () => void;
	};
}

export const EMPTY_FILE_WORKFLOW: FileWorkflowView = {
	identity: "",
	open: null,
	contextItems: [],
	diff: null,
	pendingOpen: null,
};

export class FileWorkflowStore {
	#deps: FileWorkflowDeps | null = null;
	#unsubscribe: (() => void) | null = null;
	#view: FileWorkflowView = EMPTY_FILE_WORKFLOW;
	#listeners = new Set<() => void>();
	/**
	 * 会话归属代际：身份一变就递增。在途的 fs 响应回来时对不上就整份丢弃——
	 * 换会话后落地的旧响应，比没有响应更糟（它会把上一个会话的文件显示成这个会话的）。
	 */
	#epoch = 0;
	/** 上一次观察到的身份（订阅回调里比对用）。 */
	#lastIdentity = "";
	/** 上一次观察到的「Agent 是否在跑」：只吃 true→false 这条边（回合结束＝它可能刚写了我的文件）。 */
	#lastStreaming = false;
	/**
	 * 「打开视图」的代际：换文件/换会话/关闭时递增，在途异步结果一律先对号再落地。
	 *
	 * 不能用 open 对象的引用当身份：`edit` 每次也换对象，那样「用户又敲了一个字」就会被误判成
	 * 「他换文件了」，写盘结果白白丢掉（base 不推进，界面停在一个早就不成立的版本上）。
	 */
	#token = 0;

	init(deps: FileWorkflowDeps): void {
		this.#deps = deps;
		this.#unsubscribe?.();
		this.#lastIdentity = this.#identityNow();
		this.#view = { ...EMPTY_FILE_WORKFLOW, identity: this.#lastIdentity };
		this.#unsubscribe = deps.sessions.subscribe(() => this.#onSessionsChanged());
		this.#notify();
	}

	getSnapshot(): FileWorkflowView {
		return this.#view;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// ── 打开 / 关闭 ──

	/**
	 * 打开一个文件。有未保存修改时**不**直接换（先挂起，等用户选）：换文件=丢掉草稿，
	 * 而草稿是用户打的字，丢掉它必须是他自己说的。
	 *
	 * 两个身份分开传：`attachmentAddress` 是 wire 目标（fs 命令的 `sessionId`），`agentId` 是
	 * 归属/展示 Agent。合成一个参数就是把“在哪个根里”与“是谁的”拴死 —— 而它们本来就能不同。
	 */
	requestOpen(target: { attachmentAddress: string; agentId: string; path: string }): void {
		const open = this.#view.open;
		if (open && !open.orphaned && open.attachmentAddress === target.attachmentAddress && open.path === target.path) {
			return;
		}
		if (open?.dirty) {
			this.#view = { ...this.#view, pendingOpen: { ...target } };
			this.#notify();
			return;
		}
		void this.#load(target);
	}

	/** 用户确认放弃草稿、打开挂起的那个文件。 */
	confirmPendingOpen(): void {
		const pending = this.#view.pendingOpen;
		if (!pending) return;
		this.#view = { ...this.#view, pendingOpen: null };
		void this.#load(pending);
	}

	cancelPendingOpen(): void {
		if (!this.#view.pendingOpen) return;
		this.#view = { ...this.#view, pendingOpen: null };
		this.#notify();
	}

	close(): void {
		if (!this.#view.open && !this.#view.diff && !this.#view.pendingOpen) return;
		this.#epoch += 1;
		this.#token += 1;
		this.#view = { ...this.#view, open: null, diff: null, pendingOpen: null };
		this.#notify();
	}

	/** 放弃上一个会话遗留的草稿并关闭（orphaned 的唯一出口之一）。 */
	discardOrphan(): void {
		const open = this.#view.open;
		if (!open?.orphaned) return;
		this.#epoch += 1;
		this.#token += 1;
		this.#view = { ...this.#view, open: null, diff: null, pendingOpen: null };
		this.#notify();
	}

	// ── 编辑 / 保存 ──

	edit(text: string): void {
		const open = this.#view.open;
		if (!open || open.loading || open.orphaned) return;
		this.#view = {
			...this.#view,
			open: {
				...open,
				draft: text,
				dirty: text !== open.baseText,
				// 用户又动手了：上一条「磁盘已更新」的说明不再是他需要看的重点
				externalUpdate: false,
				error: null,
			},
		};
		this.#notify();
	}

	/** 放弃草稿回到 base（磁盘上我最后确认的那一份）。 */
	revertDraft(): void {
		const open = this.#view.open;
		if (!open || open.draft === open.baseText) return;
		this.#view = {
			...this.#view,
			open: { ...open, draft: open.baseText, dirty: false, externalUpdate: false, error: null },
		};
		this.#notify();
	}

	save(): void {
		const open = this.#view.open;
		if (!open || open.loading || open.readOnly || open.orphaned || !open.dirty) return;
		void this.#write(open, open.draft, open.baseVersion);
	}

	/**
	 * 冲突后选择「用我的覆盖」：磁盘上那一份是用户明确看过的（conflict.diskVersion），
	 * 拿它做 CAS 再写一次。窗口内磁盘又变了一次就会再冲突——那时摆出来的又是最新的差异，
	 * 判定永远基于事实，不基于上一次的假设。
	 */
	overwriteWithDraft(): void {
		const open = this.#view.open;
		if (!open?.conflict) return;
		void this.#write(open, open.draft, open.conflict.diskVersion);
	}

	/** 冲突后选择「保留磁盘版本」：采纳磁盘那一份，草稿也随之作废（用户已经知道自己在放弃什么）。 */
	acceptDisk(): void {
		const open = this.#view.open;
		if (!open?.conflict) return;
		this.#view = {
			...this.#view,
			open: {
				...open,
				baseText: open.conflict.diskText,
				baseVersion: open.conflict.diskVersion,
				draft: open.conflict.diskText,
				dirty: false,
				conflict: null,
				externalUpdate: false,
				error: null,
			},
		};
		this.#notify();
	}

	/**
	 * 重新从磁盘读一遍（用户手动「重新加载」）。
	 *
	 * 有未保存修改时**拒绝**：重新加载会把草稿换成盘上的内容，而那正是用户敲的字。
	 * 想拿走盘上的版本就先撤销（或保存），这是一条明确的顺序，不是猜他想要哪一份。
	 * 判定放在 store 而不是按钮上，是因为「不丢用户输入」是数据层的不变量，不只是一种 UI 状态。
	 */
	reload(): void {
		const open = this.#view.open;
		if (!open || open.dirty) return;
		void this.#load({ attachmentAddress: open.attachmentAddress, agentId: open.agentId, path: open.path });
	}

	/**
	 * 主动探测磁盘是否被外部（通常是 Agent 自己）改写。回合结束时由订阅触发，也可由 UI 手动调。
	 * 探测失败不把编辑器拖进错误态：一次读不到不代表文件坏了，下一次回合还会再探。
	 */
	async checkExternal(): Promise<void> {
		const deps = this.#deps;
		const open = this.#view.open;
		if (!deps || !open || open.loading || open.readOnly || open.conflict || open.orphaned) return;
		const token = this.#token;
		let disk: FsReadResult;
		try {
			disk = await deps.client.fsRead(open.attachmentAddress, open.path);
		} catch {
			return;
		}
		// 判决基于**读回来后那一刻的** base：探测期间用户可能刚保存过（base 已推进到磁盘那一份），
		// 拿读到时的旧 base 去比会凭空造出一个冲突。
		const current = this.#liveOpen(token, open.path, open.attachmentAddress);
		if (!current) return;
		if (disk.version === current.baseVersion) return;
		if (!current.dirty) {
			// 没有用户改动 → 直接采纳磁盘新版（不丢任何东西），留一句说明
			this.#view = {
				...this.#view,
				open: {
					...current,
					baseText: disk.text,
					baseVersion: disk.version,
					draft: disk.text,
					readOnly: disk.truncated,
					dirty: false,
					externalUpdate: true,
					error: null,
				},
			};
		} else {
			this.#view = {
				...this.#view,
				open: {
					...current,
					conflict: {
						detail: `fs_conflict: expected ${current.baseVersion}, actual ${disk.version}`,
						diskText: disk.text,
						diskVersion: disk.version,
					},
				},
			};
		}
		this.#notify();
	}

	// ── Diff 审阅 ──

	/** 看「保存后会是什么样」：base vs 草稿。 */
	openDraftDiff(): Promise<void> {
		const open = this.#view.open;
		if (!open) return Promise.resolve();
		return this.#loadDiff(`${open.path} · 未保存修改`, open.baseText, open.draft);
	}

	/** 看「磁盘上变成了什么」：base vs 磁盘版本（冲突态才有意义）。 */
	openConflictDiff(): Promise<void> {
		const open = this.#view.open;
		if (!open?.conflict) return Promise.resolve();
		return this.#loadDiff(`${open.path} · 磁盘上的版本`, open.baseText, open.conflict.diskText);
	}

	closeDiff(): void {
		if (!this.#view.diff) return;
		this.#view = { ...this.#view, diff: null };
		this.#notify();
	}

	// ── 选区 / 文件上下文项（供下一条消息带走）──

	addFileContext(path: string): void {
		this.#pushContext(makeFileContextItem(path, this.#factsFor("file", path)));
	}

	addSelectionContext(input: { path: string; text: string; lineStart: number; lineEnd: number }): void {
		if (input.text.trim().length === 0) return; // 空选区不是一个引用
		this.#pushContext(makeSelectionContextItem(input, this.#factsFor("selection", input.path)));
	}

	/**
	 * 条目的两件随附事实（票 22）：范围与文件版本。两件都是**现有事实**的搬运，不是重算：
	 *
	 *   scope   路径落在哪个锚点下 —— 用 wire 的共享规则判（技能页同一份）；锚点/路径不够就不判。
	 *   version 打开这份文件时读到的 baseVersion —— 没读到（还在读、读失败、只读了半份）就是缺省。
	 *
	 * 归属 Agent：路径就是当前打开的那份文件时用它的 agentId（**打开时记下的归属**，
	 * 不是 wire 目标——路径是相对那个工作根解析的）；否则用当前焦点 Agent —— 条目会被当前
	 * 会话带走，而相对路径正是相对那个工作区解析的。
	 */
	#factsFor(kind: ContextItemKind, path: string): ContextItemFacts {
		const view = this.#deps?.sessions.getSnapshot();
		const open = this.#view.open;
		const ownerId = open && open.path === path ? open.agentId : view ? activeAgentIdOf(view) : undefined;
		const agentDir = view?.agents.find(agent => agent.id === ownerId)?.agentDir;
		const projectRoot = view?.projects?.find(project => project.projectId === view.currentProjectId)?.root;
		return contextItemFacts({
			kind,
			path,
			...(agentDir === undefined ? {} : { agentDir }),
			...(projectRoot === undefined ? {} : { projectRoot }),
			...(open && open.path === path ? { version: open.baseVersion } : {}),
		});
	}

	/**
	 * 从 textarea 的偏移量直接建一个选区引用（UI 只负责读 selectionStart/End）。
	 * 「什么样的偏移算一个选区」是数据问题不是渲染问题：空选区、纯空白选区都不是引用，
	 * 行范围由 context-items 的行号规则算，组件不自己数换行。
	 *
	 * @returns 是否真的加进去了（UI 据此给反馈，不猜测）。
	 */
	addSelectionFromOffsets(path: string, document: string, selectionStart: number, selectionEnd: number): boolean {
		const from = Math.min(selectionStart, selectionEnd);
		const to = Math.max(selectionStart, selectionEnd);
		if (to <= from) return false;
		const text = document.slice(from, to);
		if (text.trim().length === 0) return false;
		const { lineStart, lineEnd } = selectionLineRange(document, from, to);
		this.addSelectionContext({ path, text, lineStart, lineEnd });
		return true;
	}

	removeContextItem(id: string): void {
		const next = this.#view.contextItems.filter(item => item.id !== id);
		if (next.length === this.#view.contextItems.length) return;
		this.#view = { ...this.#view, contextItems: next };
		this.#notify();
	}

	clearContextItems(): void {
		if (this.#view.contextItems.length === 0) return;
		this.#view = { ...this.#view, contextItems: [] };
		this.#notify();
	}

	/**
	 * 同一条引用再加一次 = **刷新它的事实**（版本会变：文件被改过就是另一个版本），不是再加一条。
	 * 位置不动（它是同一条引用）；留着旧版本就是让模型拿一个不成立的版本对着运行时刚注入的内容。
	 * 身份判定仍只由 dedupeContextItems 负责，这里只是把同 id 的那条换掉。
	 */
	#pushContext(item: ContextItem): void {
		const current = this.#view.contextItems;
		const next = current.some(entry => entry.id === item.id)
			? current.map(entry => (entry.id === item.id ? item : entry))
			: [...current, item];
		this.#view = { ...this.#view, contextItems: dedupeContextItems(next) };
		this.#notify();
	}

	// ── 内部 ──

	/**
	 * 当前是否还是「那一次打开」（token 对得上且路径/目标会话一致）——异步结果落地前的唯一检查。
	 * 对表用的是 **wire 目标**（会话身份）：它变了就是另一个根里的另一个文件。
	 */
	#liveOpen(token: number, path: string, attachmentAddress: string): OpenFile | null {
		if (token !== this.#token) return null;
		const open = this.#view.open;
		if (!open || open.path !== path || open.attachmentAddress !== attachmentAddress) return null;
		return open;
	}

	async #load(target: { attachmentAddress: string; agentId: string; path: string }): Promise<void> {
		const deps = this.#deps;
		if (!deps) return;
		const { attachmentAddress, agentId, path } = target;
		const epoch = this.#epoch;
		const token = ++this.#token;
		this.#view = {
			...this.#view,
			diff: null,
			pendingOpen: null,
			open: {
				path,
				attachmentAddress,
				agentId,
				baseText: "",
				baseVersion: "",
				draft: "",
				dirty: false,
				readOnly: false,
				loading: true,
				error: null,
				conflict: null,
				externalUpdate: false,
				orphaned: false,
			},
		};
		this.#notify();
		let result: FsReadResult;
		try {
			result = await deps.client.fsRead(attachmentAddress, path);
		} catch (err) {
			if (epoch !== this.#epoch) return;
			const open = this.#liveOpen(token, path, attachmentAddress);
			if (!open) return;
			this.#view = { ...this.#view, open: { ...open, loading: false, error: messageOf(err) } };
			this.#notify();
			return;
		}
		if (epoch !== this.#epoch) return;
		const open = this.#liveOpen(token, path, attachmentAddress);
		if (!open) return;
		this.#view = {
			...this.#view,
			open: {
				...open,
				baseText: result.text,
				baseVersion: result.version,
				draft: result.text,
				// 只读降级：文件被截断（>128KB），base 不是全文 —— 写回去就是把文件截断，
				// 所以这里不是「禁用按钮」的 UX 取舍，而是「我们没有那份内容」的事实。
				readOnly: result.truncated,
				loading: false,
				error: null,
			},
		};
		this.#notify();
	}

	/** 保存/覆盖的唯一写盘出口（save 与 overwriteWithDraft 共用，判定只有一份）。 */
	async #write(open: OpenFile, content: string, expectedVersion: string): Promise<void> {
		const deps = this.#deps;
		if (!deps) return;
		const epoch = this.#epoch;
		const token = this.#token;
		let result: FsWriteResult;
		try {
			result = await deps.client.fsWrite(open.attachmentAddress, open.path, content, expectedVersion);
		} catch (err) {
			if (epoch !== this.#epoch) return;
			const failed = this.#liveOpen(token, open.path, open.agentId);
			if (!failed) return;
			if (err instanceof FsConflictError) {
				await this.#enterConflict(failed, err.detail, epoch, token);
				return;
			}
			this.#view = { ...this.#view, open: { ...failed, error: messageOf(err) } };
			this.#notify();
			return;
		}
		if (epoch !== this.#epoch) return;
		const current = this.#liveOpen(token, open.path, open.attachmentAddress);
		if (!current) return;
		// 写盘期间用户又改了草稿：base 推进到刚落盘的那一份，但 dirty 按现在的草稿算 ——
		// 否则「保存成功」会把他在飞行中敲的字标成已保存。
		const written: OpenFile = {
			...current,
			baseText: content,
			baseVersion: result.version,
			dirty: current.draft !== content,
			conflict: null,
			externalUpdate: false,
			error: null,
		};
		this.#view = { ...this.#view, open: written };
		this.#notify();
		// 服务端说落盘内容不是我们发的那份（格式化等）：把编辑器同步成盘上的那一份。
		if (result.normalized) await this.#adoptDiskText(written, content, epoch);
	}

	/**
	 * 写入被服务端改写后，把 base 与草稿都对齐到磁盘上的真实内容。
	 *
	 * 只在「用户在飞行中没再改」时采纳：他敲的字比他按下保存那一刻的意义更大。
	 * 读不回来就算了——version 已经对齐（冲突判定不受影响），不因此把编辑器拖进错误态。
	 */
	async #adoptDiskText(afterWrite: OpenFile, writtenContent: string, epoch: number): Promise<void> {
		const deps = this.#deps;
		if (!deps) return;
		const token = this.#token;
		let disk: FsReadResult;
		try {
			disk = await deps.client.fsRead(afterWrite.attachmentAddress, afterWrite.path);
		} catch {
			return;
		}
		if (epoch !== this.#epoch) return;
		const current = this.#liveOpen(token, afterWrite.path, afterWrite.attachmentAddress);
		if (!current) return; // 已经换了文件或会话
		if (current.draft !== writtenContent) return; // 用户在写盘期间又改了：别拿磁盘文本盖掉他的字
		this.#view = {
			...this.#view,
			open: {
				...current,
				baseText: disk.text,
				baseVersion: disk.version,
				draft: disk.text,
				readOnly: disk.truncated,
				conflict: null,
				externalUpdate: false,
				error: null,
			},
		};
		this.#notify();
	}

	/** 保存被拒绝：读一次磁盘，把「我这一份」与「磁盘那一份」都摆出来供用户裁决。 */
	async #enterConflict(open: OpenFile, detail: string, epoch: number, token: number): Promise<void> {
		const deps = this.#deps;
		const conflict: EditorConflict = { detail, diskText: "", diskVersion: "" };
		if (deps) {
			try {
				const disk = await deps.client.fsRead(open.attachmentAddress, open.path);
				if (epoch !== this.#epoch || !this.#liveOpen(token, open.path, open.attachmentAddress)) return;
				conflict.diskText = disk.text;
				conflict.diskVersion = disk.version;
			} catch {
				// 连磁盘都读不到：仍然把「保存被拒绝」这件事说出来，不能退回成「保存成功」
				if (epoch !== this.#epoch || !this.#liveOpen(token, open.path, open.attachmentAddress)) return;
			}
		}
		const current = this.#liveOpen(token, open.path, open.attachmentAddress) ?? open;
		this.#view = { ...this.#view, open: { ...current, conflict } };
		this.#notify();
	}

	async #loadDiff(title: string, before: string, after: string): Promise<void> {
		const deps = this.#deps;
		if (!deps) return;
		const epoch = this.#epoch;
		this.#view = { ...this.#view, diff: { title, text: "", loading: true, error: null } };
		this.#notify();
		try {
			const result = await deps.client.fsDiff(before, after);
			if (epoch !== this.#epoch) return;
			this.#view = { ...this.#view, diff: { title, text: result.diff, loading: false, error: null } };
		} catch (err) {
			if (epoch !== this.#epoch) return;
			this.#view = { ...this.#view, diff: { title, text: "", loading: false, error: messageOf(err) } };
		}
		this.#notify();
	}

	/**
	 * 会话身份：焦点附件的地址 + 会话文件。一个概念一处定义（与 Project 归属同一把尺子）。
	 *
	 * 用地址而不用焦点 Agent：路径是相对那个**工作根**解析的，同一个 Agent 的两个附件（绑了不同
	 * Project）是两个根 —— 按 Agent 名当身份，切到另一个附件时旧文件会活下来（它在新根下是另一个
	 * 东西）。未绑定的附件地址 == Agent 名，所以未绑会话逐字节不变。
	 */
	#identityNow(): string {
		const view = this.#deps?.sessions.getSnapshot();
		if (!view) return "";
		return `${view.attachmentAddress}|${view.sessionFile ?? ""}`;
	}

	/**
	 * 会话视图每次变化都过一遍：身份变了就作废本会话的文件工作区，回合结束就探一次外部改写。
	 * 挂在订阅上而不是散在各调用点，是因为漏掉一个入口就是漏掉一个窗口（T8 的 Project 归属教训）。
	 */
	#onSessionsChanged(): void {
		const view = this.#deps?.sessions.getSnapshot();
		if (!view) return;
		const identity = this.#identityNow();
		if (identity !== this.#lastIdentity) {
			this.#lastIdentity = identity;
			this.#epoch += 1;
			this.#token += 1;
			// 选区引用按定义属于被引用的那个会话（出会话即失效）；Draft 是 UI 偏好，不动。
			const open = this.#view.open;
			const next: FileWorkflowView = {
				...this.#view,
				identity,
				contextItems: [],
				diff: null,
				pendingOpen: null,
				// 路径是相对工作根解析的 —— 身份一变，同一个「path」指向的就是另一个目录里的另一个
				// 文件，留着它等于让编辑器对着一个不存在的东西写字。没草稿就直接关（无损失）；
				// 有草稿就不静默丢：留着让用户看见并自己处置（保存被拒并说明原因）。
				open: !open ? null : open.dirty ? { ...open, orphaned: true } : null,
			};
			this.#view = next;
			this.#notify();
		}
		// 回合结束（true→false）＝Agent 可能刚写过我的文件：探一次，别让编辑器显示过期内容
		const streaming = view.isStreaming;
		const finished = this.#lastStreaming && !streaming;
		this.#lastStreaming = streaming;
		if (finished) void this.checkExternal();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}

function messageOf(err: unknown): string {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	return String(err);
}

const store = new FileWorkflowStore();

export function getFileWorkflow(): FileWorkflowStore {
	return store;
}

/** 订阅文件工作流状态（React 18 useSyncExternalStore）。 */
export function useFileWorkflow(): FileWorkflowView {
	const s = getFileWorkflow();
	return useSyncExternalStore(
		cb => s.subscribe(cb),
		() => s.getSnapshot(),
	);
}
