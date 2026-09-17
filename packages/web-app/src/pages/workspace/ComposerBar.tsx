import type { AgentInfoDto, ImageContentDto } from "@cornfield/wire";
import { ChevronDown, Mic, Paperclip, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextRing } from "../../components/ContextRing";
import { ProviderLogo } from "../../components/ProviderLogo";
import type { ContextItem } from "../../lib/context-items";
import { composePrompt, hasFileVersion } from "../../lib/context-items";
import type { GatewayStatusDto } from "../../lib/pi-client-api";
import { SCOPE_LABELS } from "../../lib/scope-display";
import { getFileWorkflow, useFileWorkflow } from "../../state/file-workflow-store";
import { type SessionView, useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { DEFAULT_COMMANDS, filterSlashCommands, type SlashCommandDef, SlashPalette } from "./SlashPalette";

/** 模型菜单行（provider + id）。 */
interface ModelMenuRow {
	id: string;
	provider: string;
}

/**
 * 模型按 provider 分组；当前模型所在 provider 置顶，其余保持 serve 返回顺序。
 * 纯函数——从 ComposerBar 提出，便于单测（模型下拉分组是「只显示第一个 provider」
 * 截断问题修复的一部分）。
 */
export function groupModelsByProvider(
	modelList: ModelMenuRow[],
	currentModelId: string | null | undefined,
	currentModelProvider?: string | null,
): Array<[string, ModelMenuRow[]]> {
	const byProvider = new Map<string, ModelMenuRow[]>();
	for (const m of modelList) {
		const group = byProvider.get(m.provider) ?? [];
		group.push(m);
		byProvider.set(m.provider, group);
	}
	// 置顶依据是「实际生效的 provider」：同 id 多 provider 时按 id find 会错拿第一个，
	// 显式给出 provider 时直接用它，否则退回按 id 查（兼容旧调用）。
	const currentProvider =
		currentModelProvider != null
			? currentModelProvider
			: currentModelId
				? modelList.find(m => m.id === currentModelId)?.provider
				: undefined;
	return [...byProvider.entries()].sort((a, b) => {
		if (currentProvider && a[0] === currentProvider) return -1;
		if (currentProvider && b[0] === currentProvider) return 1;
		return 0; // 稳定排序：同权重保留 serve 首现顺序
	});
}

/** 从剪贴板 DataTransfer 里筛出图片文件；无则空数组——纯文本粘贴不 preventDefault、不被吞。 */
export function imageFilesFromClipboardData(data: DataTransfer | null | undefined): File[] {
	if (!data?.files) return [];
	return Array.from(data.files).filter(file => file.type.startsWith("image/"));
}

/** 组合态 Enter 判据：只「非组合态 && Enter && 无 Shift」才发送；Shift+Enter 换行，中文输入法组合态按 Enter 不发送。 */
export function shouldSendOnEnter(key: string, shiftKey: boolean, isComposing: boolean): boolean {
	return key === "Enter" && !shiftKey && !isComposing;
}

/** 模型行是否为当前生效那条：provider 已知时要求精确匹配（同 id 多 provider 只标实际生效那一条）。 */
export function isCurrentModel(
	model: ModelMenuRow,
	currentModelId: string | null | undefined,
	currentModelProvider: string | null | undefined,
): boolean {
	if (!currentModelId || model.id !== currentModelId) return false;
	if (currentModelProvider == null) return true; // provider 未知：退回按 id 匹配（老快照/局部视图）
	return model.provider === currentModelProvider;
}

/** 模型列表子串过滤（provider / id，大小写不敏感）。 */
export function filterModelList(modelList: ModelMenuRow[], query: string): ModelMenuRow[] {
	const q = query.trim().toLowerCase();
	if (!q) return modelList;
	return modelList.filter(m => m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q));
}

/**
 * 模型列表（可过滤 + provider 分组 + 「当前」徽标只在实际生效那条落下）。
 * 纯展示：列表/当前值/选中回调由调用方给，内部只持有过滤词状态（静态渲染可断言空过滤态）。
 */
export function ModelList({
	modelList,
	currentModelId,
	currentModelProvider,
	onSelect,
}: {
	modelList: ModelMenuRow[];
	currentModelId: string | null;
	currentModelProvider?: string | null;
	onSelect: (id: string, provider: string) => void;
}): React.JSX.Element {
	const [filter, setFilter] = useState("");
	const filtered = filterModelList(modelList, filter);
	const groups = groupModelsByProvider(filtered, currentModelId, currentModelProvider);
	return (
		<>
			<input
				type="text"
				className="mx-1.5 mb-1 w-[calc(100%-12px)] rounded border border-hairline bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
				placeholder="过滤模型（id / provider）…"
				value={filter}
				onChange={e => setFilter(e.target.value)}
			/>
			<div className="max-h-[46vh] overflow-y-auto overscroll-contain px-1 pb-1">
				{filtered.length === 0 ? (
					<div className="px-3 py-2 text-[12px] text-ink-faint">没有匹配 “{filter}” 的模型</div>
				) : (
					groups.map(([provider, models]) => (
						<div key={provider}>
							<div className="flex items-baseline gap-1.5 px-2.5 pt-1.5 pb-0.5">
								<ProviderLogo provider={provider} size={10} />
								<span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									{provider}
								</span>
								<span className="font-mono text-[9px] text-ink-faint">{models.length}</span>
							</div>
							{models.map(m => (
								<button
									key={`${provider}/${m.id}`}
									type="button"
									className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3 ${isCurrentModel(m, currentModelId, currentModelProvider) ? "bg-accent-dim" : ""}`}
									onClick={() => onSelect(m.id, m.provider)}
								>
									<ProviderLogo provider={provider} modelId={m.id} size={10} />
									<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{m.id}</span>
									{isCurrentModel(m, currentModelId, currentModelProvider) && (
										<span className="shrink-0 rounded bg-accent px-1 py-px font-mono text-[9px] text-on-accent">
											当前
										</span>
									)}
								</button>
							))}
						</div>
					))
				)}
			</div>
		</>
	);
}

const THINKING_LEVELS = ["off", "low", "medium", "high"];

/**
 * 发消息时 wire 的定向身份（`prompt.sessionId`）= **会话身份**（`view.attachmentAddress`，本屏焦点附件的地址）。
 *
 * 不能拿屏幕上的 Agent 名（`activeAgentIdOf(view)` / 下拉里选的那个）当 `sessionId`：wire 把
 * Agent 名解到那个 Agent **未绑定**的附件 —— 对绑了 Project 的会话，那是**另一个根**（屏幕上
 * 根本没在看的那个会话），消息会进错会话。
 *
 * 为什么在载荷里点名地址，而不是省掉 `sessionId` 让 wire 取「焦点附件」这个缺省：两者指向
 * 同一个附件，但缺省是一个客户端看不见的服务端状态；载荷里写出地址，才答得上「这条消息进了
 * 哪个会话」，也才与右栏文件面/产物面用的是同一个身份。地址为空串（还没收到快照）时退回缺省
 * —— 此刻客户端确实不知道对方是谁。
 */
export function promptTargetOf(view: Pick<SessionView, "attachmentAddress">): string | undefined {
	return view.attachmentAddress === "" ? undefined : view.attachmentAddress;
}

/** 上下文条目在输入区的展示名（选区带行范围，其它就是路径）。 */
function contextItemLabel(item: ContextItem): string {
	if (item.kind !== "selection") return item.path;
	const range = item.lineStart === item.lineEnd ? `${item.lineStart}` : `${item.lineStart}-${item.lineEnd}`;
	return `${item.path}:${range}`;
}

/** 版本在 chip 里只显示前 8 位（sha256 太长）；完整值在 title 上，不丢事实。 */
function shortVersion(version: string): string {
	return version.length > 8 ? `${version.slice(0, 8)}…` : version;
}

/**
 * 上下文条目 chip：定位（路径 / 选区行范围）+ 范围 + 版本（§9 要求每个引用看得到这两件事）。
 *
 * 缺哪件就说「未知」：渲染成空标签等于把「不知道」画成「没有」。URL 条目不说版本 ——
 * 链接不是文件，那是「不适用」而不是「没读到」（{@link hasFileVersion}）。
 */
export function ContextItemChip({ item, onRemove }: { item: ContextItem; onRemove: () => void }): React.JSX.Element {
	return (
		<span className="chip max-w-[320px] gap-1.5">
			<span className="truncate font-mono" title={item.path}>
				{contextItemLabel(item)}
			</span>
			<span
				className="shrink-0 rounded-sm bg-surface-3 px-1 text-[9px] text-ink-subtle"
				title={
					item.scope === undefined
						? "范围未知：拿不到这个 Agent 的工作区锚点，判不出来"
						: `范围：${SCOPE_LABELS[item.scope]}`
				}
			>
				{item.scope === undefined ? "范围未知" : SCOPE_LABELS[item.scope]}
			</span>
			{hasFileVersion(item.kind) &&
				(item.version === undefined ? (
					<span className="shrink-0 text-[9px] text-ink-faint" title="版本未知：加这条引用时没读到文件版本">
						版本未知
					</span>
				) : (
					<span className="shrink-0 font-mono text-[9px] text-ink-faint" title={`版本 ${item.version}`}>
						版本 {shortVersion(item.version)}
					</span>
				))}
			<button
				type="button"
				className="shrink-0 text-ink-faint hover:text-danger"
				title={`移除 ${item.path}`}
				onClick={onRemove}
			>
				×
			</button>
		</span>
	);
}

function statusDot(s: string): string {
	if (s === "online") return "bg-success";
	if (s === "busy") return "bg-warning animate-pulse";
	return "bg-ink-faint";
}

function statusLabel(s: string): string {
	switch (s) {
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

/**
 * Agent 选择菜单的一行（纯展示，从 ComposerBar 提出，静态渲染可断言）。
 * footer 只渲染**有数据源**的 skillsCount：`cronCount` 在服务端无数据源（调度器在 gateway
 * 进程，serve 的 list_agents 拿不到），已从渲染里删除且不留占位 —— 缺值渲染看着像"功能坏了"，
 * 而事实是这项数据不存在（票 10，依据 docs/web-app-fix-t6）。
 */
export function AgentMenuItem({
	agent,
	selected,
	stopped,
	onSelect,
}: {
	agent: AgentInfoDto;
	selected: boolean;
	stopped: boolean;
	onSelect: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-3 ${selected ? "bg-accent-dim" : ""} ${stopped ? "opacity-60" : ""}`}
			onClick={onSelect}
		>
			<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-2 text-[9px] font-semibold">
				{agent.face}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1.5 text-ink">
					@{agent.name}
					<span
						className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(agent.status)}`}
						title={statusLabel(agent.status)}
					/>
					{stopped && (
						<span className="rounded bg-danger/10 px-1 py-px text-[9px] font-medium text-danger">已停用</span>
					)}
				</span>
				<span className="text-[10px] text-ink-faint">{agent.skillsCount ?? 0} 技能</span>
			</span>
			<span className="ml-auto shrink-0 text-[10px] text-ink-faint">
				{agent.kind === "coding" ? "CODING" : "WORKER"}
			</span>
		</button>
	);
}

/**
 * 工作台输入区（assistant-ui Composer 就绪前的原生实现，两行：textarea + 工具栏）。
 * - Enter 发送 / Shift+Enter 换行 / Esc 中止（streaming 时）；中文输入法组合态按 Enter 不发送
 * - 草稿自动保留（localStorage）；粘贴图片转为附件随 prompt 发出（纯文本粘贴不被吞）
 * - 工具栏：Agent 选择器（按工作区分组 + CODING/WORKER + 钉钉角标）、附件、语音、
 *   模型/thinking 下拉（模型列表可过滤、当前 provider 置顶）、发送/停止
 * - autoFocusDraft 仅约定聚焦（?q= 直达种子文本由 WorkspaceView 写入草稿 store）
 */
export function ComposerBar({ autoFocusDraft = "" }: { autoFocusDraft?: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const navigate = useNavigate();
	const textRef = useRef<HTMLTextAreaElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const [agentId, setAgentId] = useState<string | undefined>(view.agents[0]?.id);
	const [showAgentMenu, setShowAgentMenu] = useState(false);
	const [showModelMenu, setShowModelMenu] = useState(false);
	const [modelList, setModelList] = useState<Array<{ id: string; provider: string }>>([]);
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandDef[]>(DEFAULT_COMMANDS);
	/** 发送拦截提示（方向 2：停用账号禁止从工作台发起会话）。 */
	const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
	/** gateway 运行态账号表（gateway_status；15s 轮询，判定账号在线/停用）。 */
	const [gwStatus, setGwStatus] = useState<GatewayStatusDto | null>(null);
	/** ui.draft 是输入区唯一事实源（含 ?q= 直达种子——由 WorkspaceView 在挂载时写入一次、发送后清空）。
	 * 不再回退 autoFocusDraft：否则种子成为永久 fallback，用户清空输入后文本立即恢复。 */
	const value = ui.draft;
	// 上下文条目（文件/选区）挂在文件工作流上并与会话同归属：换会话即清空（引用会失效）
	const contextItems = useFileWorkflow().contextItems;
	const [attachments, setAttachments] = useState<ImageContentDto[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	// 附件：文件选择 / 粘贴图片 → base64 读入 → prompt.images 通道（真命令已支持）
	const readImageFiles = (files: File[]) => {
		for (const file of files) {
			const reader = new FileReader();
			reader.onload = () => {
				const data = String(reader.result ?? "").split(",")[1] ?? "";
				if (data) {
					setAttachments(prev => [...prev, { type: "image", data, mimeType: file.type || "image/png" }]);
				}
			};
			reader.readAsDataURL(file);
		}
	};
	const onPickImages = (e: React.ChangeEvent<HTMLInputElement>) => {
		readImageFiles(Array.from(e.target.files ?? []));
		e.target.value = "";
	};
	// 粘贴图片按附件收下；纯文本粘贴不 preventDefault，交给默认行为（不被吞）。
	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const imageFiles = imageFilesFromClipboardData(e.clipboardData);
		if (imageFiles.length === 0) return;
		e.preventDefault();
		readImageFiles(imageFiles);
	};

	/**
	 * 拉取真实可用模型列表（serve get_available_models）；失败保持现有列表（可读性优先）。
	 * 连接就绪后拉一次；每次打开下拉再刷一次——serve 重启后模型注册表可能变化
	 * （如 models.yml 新增 provider），否则下拉停留在旧列表。
	 */
	const refreshModels = () => {
		void store
			.getAvailableModels()
			.then(result => {
				if (result.models.length > 0) {
					setModelList(result.models.map(m => ({ id: m.id, provider: m.provider ?? "" })));
				}
			})
			.catch(() => undefined);
	};
	const refreshCommands = () => {
		void store
			.listCommands()
			.then(cmds => {
				if (cmds.length > 0) {
					setSlashCommands(cmds);
				}
			})
			.catch(() => undefined);
	};

	useEffect(() => {
		if (!view.connected) return; // 未连接时跳过，连接后就绪再拉
		refreshModels();
		refreshCommands();
	}, [store, view.connected]);

	/** gateway 账号在线表（gateway_status 15s 轮询）。停用账号（enabled:false）会从 accounts 消失，据此判定可对话性。 */
	useEffect(() => {
		if (!view.connected) return;
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const s = await store.gatewayStatus();
				if (!cancelled) setGwStatus(s);
			} catch {
				// gateway 未运行/不可达 → 保留 null：不拦截（本地 serve 能力仍可用）
				if (!cancelled) setGwStatus(null);
			}
		};
		void load();
		const t = setInterval(() => void load(), 15_000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
	}, [store, view.connected]);

	/**
	 * 账号是否已停用（方向 2 判定）：gateway 运行中（非 stale）+ 该 agent 绑定了钉钉 +
	 * accountId 不在 gateway 账号表 = 停用。未绑定钉钉的 agent（如 default 本地 agent）
	 * 永远可对话 —— 不按 gateway 账号表判定。
	 */
	const isAccountStopped = (id: string): boolean => {
		if (!gwStatus || gwStatus.stale) return false; // gateway 未运行/状态陈旧 → 不拦截
		const meta = view.agents.find(a => a.id === id);
		if (!meta?.dingtalk) return false; // 未绑定钉钉（default 等本地 agent）→ 不拦截
		return !gwStatus.accounts.some(a => a.accountId === id);
	};

	/**
	 * SERVE-1 回归：输入框 agent 跟随当前视图焦点（openHistorySession / Agent 卡片 / 下拉切换
	 * 都会改 view.activeAgentId）。此前 ComposerBar 只看 agents[0] 初值——在 hr 会话视图里发消息
	 * 实际投给了 default：消息进了 default 的会话、回推帧又被连接焦点过滤，页面无任何显示。
	 * 手动下拉切换会同步 switch_session（activeAgentId 变到同值，不回弹）。
	 */
	useEffect(() => {
		if (!view.activeAgentId) return;
		if (view.agents.some(a => a.id === view.activeAgentId)) {
			setAgentId(view.activeAgentId);
		}
	}, [view.activeAgentId, view.agents]);

	/** 当前模型的 provider（顶栏按钮 logo 用）—— 以快照权威 provider 为准；老快照/局部视图缺省时退回按 id 查。 */
	const currentProvider = useMemo(
		() => view.modelProvider ?? modelList.find(m => m.id === view.model)?.provider,
		[modelList, view.model, view.modelProvider],
	);

	const active = view.isStreaming || view.phase !== "idle";
	const agent = view.agents.find(a => a.id === agentId) ?? view.agents[0];
	const workspaces = Array.from(new Set(view.agents.map(a => a.workspace).filter(Boolean)));

	useEffect(() => {
		if (autoFocusDraft) textRef.current?.focus();
	}, [autoFocusDraft]);
	/** Agent / model 下拉：Escape 关闭 + 点击外部关闭。 */
	useEffect(() => {
		if (!showAgentMenu && !showModelMenu) return;
		const close = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setShowAgentMenu(false);
				setShowModelMenu(false);
			}
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [showAgentMenu, showModelMenu]);

	useEffect(() => {
		if (!showAgentMenu && !showModelMenu) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setShowAgentMenu(false);
				setShowModelMenu(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showAgentMenu, showModelMenu]);

	const autoGrow = () => {
		const el = textRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	};

	const send = () => {
		// 带上上下文条目 = 草稿 + 序列化块（@路径 走运行时既有的提及通道，选区额外内联选中文本）。
		// 只有条目没有文字也允许发送：用户指着一段代码说话，就是一条完整的消息。
		const text = composePrompt(value.trim(), contextItems);
		if (!text) return;
		// 方向 2：停用账号（gateway 侧 enabled:false）禁止从工作台发起会话
		if (agentId && isAccountStopped(agentId)) {
			setBlockedMsg(
				`@${agent?.name ?? "该 agent"} 已停用（gateway 账号 enabled=false），请在 Agent 管理 → 钉钉 tab 重新启用后再发起会话。`,
			);
			setShowAgentMenu(false);
			return;
		}
		setBlockedMsg(null);
		getUiStore().setDraft("");
		// 第二个入参是 wire 的定向身份（`prompt.sessionId`）—— 见 promptTargetOf：会话身份，不是 agentId。
		store.prompt(text, promptTargetOf(view), attachments.length > 0 ? attachments : undefined);
		// 条目随这条消息一起发走了：留着它会让下一条消息莫名其妙地带上一段旧代码
		getFileWorkflow().clearContextItems();
		setAttachments([]);
	};

	const selectSlash = (cmd: SlashCommandDef) => {
		getUiStore().setDraft(`${cmd.name} `);
		setSlashOpen(false);
		textRef.current?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (slashOpen) {
			const filtered = filterSlashCommands(slashCommands, value.slice(1));
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashIndex(i => Math.min(i + 1, filtered.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashIndex(i => Math.max(i - 1, 0));
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const cmd = filtered[slashIndex];
				if (cmd) selectSlash(cmd);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setSlashOpen(false);
				return;
			}
		}
		if (shouldSendOnEnter(e.key, e.shiftKey, e.nativeEvent.isComposing)) {
			e.preventDefault();
			if (active) {
				store.abort();
			} else {
				send();
			}
		} else if (e.key === "Escape" && active) {
			store.abort();
		}
	};

	return (
		<div className="shrink-0 border-t border-hairline bg-surface px-4.5 pt-3.5 pb-3">
			<div className="relative mx-auto max-w-[1100px]">
				{slashOpen && (
					<div className="relative z-menu">
						<SlashPalette
							commands={slashCommands}
							query={value.slice(1)}
							activeIndex={slashIndex}
							onSelect={selectSlash}
							onHover={setSlashIndex}
						/>
					</div>
				)}

				<div className="rounded-xl border border-hairline bg-surface-2 transition-[border-color,box-shadow] duration-150 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
					{contextItems.length > 0 && (
						// 可见的「上下文」标题就是这一块的标签，不再叠一个 aria-label（role 与标签重复反而不清楚）
						<div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-3 py-1.5">
							<span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
								上下文
							</span>
							{contextItems.map(item => (
								<ContextItemChip
									key={item.id}
									item={item}
									onRemove={() => getFileWorkflow().removeContextItem(item.id)}
								/>
							))}
							<button type="button" className="link" onClick={() => getFileWorkflow().clearContextItems()}>
								清空
							</button>
						</div>
					)}
					<textarea
						ref={textRef}
						rows={1}
						value={value}
						placeholder={
							agentId && isAccountStopped(agentId)
								? `@${agent?.name ?? "Agent"} 已停用，无法发起会话`
								: `@${agent?.name ?? "Agent"} 发消息，或直接提问…`
						}
						onChange={e => {
							const v = e.target.value;
							getUiStore().setDraft(v);
							setSlashOpen(v.startsWith("/"));
							setSlashIndex(0);
						}}
						onInput={autoGrow}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						className="min-h-[52px] w-full resize-none border-none bg-transparent px-3.5 pt-3 pb-1.5 font-inherit text-ink outline-none placeholder:text-ink-faint"
					/>
					<div className="flex items-center gap-2 px-2.5 pb-1.5">
						{/* Agent 选择器 */}
						<div className="relative">
							<button
								type="button"
								className="flex items-center gap-2 rounded-md border border-hairline bg-surface-3 py-1 pr-2 pl-1 text-[12px] transition-colors hover:border-hairline-strong"
								onClick={() => setShowAgentMenu(v => !v)}
							>
								<span className="relative flex h-6 w-6 items-center justify-center rounded-[6px] border border-hairline bg-surface-2 text-[10px] font-semibold text-ink">
									{agent?.face ?? "?"}
									{agent?.dingtalk?.enabled && (
										<span
											className="absolute -right-1 -bottom-1 flex h-3 w-3 items-center justify-center rounded-[4px] bg-dingtalk"
											title={`钉钉：${agent?.dingtalk?.robotName ?? "已绑定"}`}
										/>
									)}
								</span>
								<span className="font-medium text-ink">@{agent?.name ?? "Agent"}</span>
								{agentId && isAccountStopped(agentId) && (
									<span className="rounded bg-danger/10 px-1 py-px text-[9px] font-medium text-danger">
										已停用
									</span>
								)}
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showAgentMenu && (
								<div
									ref={menuRef}
									className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-65 overflow-hidden rounded-md border border-hairline-strong bg-surface shadow-lg"
								>
									{workspaces.map(ws => (
										<div key={ws}>
											<div className="border-b border-hairline px-3 py-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
												{ws}
											</div>
											{view.agents
												.filter(a => a.workspace === ws)
												.map(a => (
													<AgentMenuItem
														key={a.id}
														agent={a}
														selected={a.id === agentId}
														stopped={isAccountStopped(a.id)}
														onSelect={() => {
															setAgentId(a.id);
															setBlockedMsg(null);
															store.focusAgent(a.id); // attach + 切 active：后续 prompt 默认发往该 agent
															setShowAgentMenu(false);
														}}
													/>
												))}
										</div>
									))}
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />
						<input
							ref={fileRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={onPickImages}
						/>
						<button
							type="button"
							className="cbtn shrink-0"
							title={
								attachments.length > 0
									? `${attachments.length} 张图片已附加（发送时随指令）`
									: "添加图片（随指令发送）"
							}
							onClick={() => fileRef.current?.click()}
						>
							<Paperclip size={15} strokeWidth={1.5} />
							<span className="hidden sm:inline">附件</span>
							{attachments.length > 0 && (
								<span className="rounded bg-accent px-1 font-mono text-[10px] text-on-accent">
									{attachments.length}
								</span>
							)}
						</button>
						<button type="button" className="cbtn" title="语音输入" onClick={() => navigate("/voice")}>
							<Mic size={15} strokeWidth={1.5} />
						</button>

						<div className="flex-1" />

						{/* 模型 + thinking 下拉 */}
						<div className="relative">
							<button
								type="button"
								className="cbtn"
								onClick={() =>
									setShowModelMenu(v => {
										const next = !v;
										if (next) refreshModels(); // 打开即刷新，防 serve 重启后的旧注册表
										return next;
									})
								}
							>
								<ProviderLogo provider={currentProvider ?? "-"} size={12} />
								<b className="font-mono text-[12px] font-medium text-ink">{view.model ?? "—"}</b>{" "}
								<span className="rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[10px] text-ink-subtle">
									{view.thinkingLevel ?? "off"}
								</span>
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showModelMenu && (
								<div
									ref={menuRef}
									className="absolute right-0 bottom-[calc(100%+8px)] z-30 w-80 overflow-hidden rounded-md border border-hairline-strong bg-surface shadow-lg"
								>
									<div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										模型
									</div>
									{modelList.length === 0 ? (
										<div className="px-3 py-2 text-[12px] text-ink-faint">
											无可用模型（未连接 / 列表加载中）
										</div>
									) : (
										<ModelList
											modelList={modelList}
											currentModelId={view.model}
											currentModelProvider={view.modelProvider}
											onSelect={(id, provider) => {
												store.setModel(id, provider);
												setShowModelMenu(false);
											}}
										/>
									)}
									<div className="border-t border-hairline px-3 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										思维级别
									</div>
									<div className="px-1 pb-1">
										{THINKING_LEVELS.map(level => (
											<button
												key={level}
												type="button"
												className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-3 ${level === view.thinkingLevel ? "bg-accent-dim" : ""}`}
												onClick={() => {
													store.setThinkingLevel(level);
													setShowModelMenu(false);
												}}
											>
												{level}
											</button>
										))}
									</div>
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />

						{view.context && (
							<ContextRing
								percent={view.context.percent}
								usedTokens={view.context.usedTokens}
								totalTokens={view.context.totalTokens}
								size={28}
							/>
						)}
						{/* 发送 ↔ 停止 原位替换 */}
						<button
							type="button"
							onClick={() => (active ? store.abort() : send())}
							className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md border-none transition-all duration-150 active:scale-95 sm:h-9 sm:w-9 ${active ? "bg-danger text-white hover:bg-danger/85" : "bg-accent text-on-accent hover:bg-accent-hover"}`}
							aria-label={active ? "停止" : "发送"}
						>
							{active ? (
								<Square size={14} strokeWidth={1.5} fill="currentColor" />
							) : (
								<Send size={14} strokeWidth={1.5} />
							)}
						</button>
					</div>
				</div>
				{blockedMsg && (
					<div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11px] text-danger">
						<span className="shrink-0 font-medium">无法发送：</span>
						<span className="min-w-0">{blockedMsg}</span>
					</div>
				)}
				<div className="mt-1.5 flex gap-3.5 text-[11px] text-ink-faint">
					<span>
						<span className="kbd">Enter</span> 发送 · <span className="kbd">Shift+Enter</span> 换行 ·{" "}
						<span className="kbd">Esc</span> 中止
					</span>
					<span>draft 自动保留 · 输入自适应增高</span>
				</div>
			</div>
		</div>
	);
}
