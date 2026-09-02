import type { ConfigScopeDto, ModelCatalogDto, ModelCatalogEntryDto } from "@cornfield/wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ProviderLogo } from "../../components/ProviderLogo";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	type CapabilityFilter,
	type CatalogQuery,
	type ContextFilter,
	countByStatus,
	DEFAULT_QUERY,
	formatContextTokens,
	formatIsoTime,
	formatPriceUsd,
	keyOf,
	type ModalityFilter,
	type SortKey,
	STATUS_META,
	type StatusFilter,
	visibleCatalog,
} from "./catalog/catalog-logic";
import { ModelDetailDrawer } from "./catalog/ModelDetailDrawer";
import { StatusBadge } from "./catalog/StatusBadge";

/**
 * 模型目录（模型控制中心 #02）—— get_model_catalog 全量已知模型 + 会话临时切换。
 * 由 ModelsView 壳承载状态条/二级导航/断连与命令错误提示；本视图只消费 v2 目录 DTO
 * （ModelCatalogDto，不再使用 get_available_models / AvailableModelsDto）：
 * - 六态互斥（available / provider-not-configured / credential-invalid / disabled / local-offline /
 *   catalog-stale）按 status 区分而非过滤——未接入、已停用、离线、过期各自可见、可诊断。
 * - 搜索（名称/ID/provider）、筛选（provider/能力/输入模态/上下文/接入状态）、排序
 *   （价格/上下文/名称/发布时间；缺失排序数据排末尾）——纯逻辑在 catalog/catalog-logic.ts。
 * - 临时切换当前会话模型（set_model_temporary）：仅本会话生效，成功/失败均有可见反馈，
 *   文案不伪装成持久默认（持久默认归运行时配置 #05）。
 * - 已停用 provider/模型按 DTO 停用名单列出恢复入口；停用/恢复写入在 Provider 工作区（#03）。
 * - 未接入 provider 的模型行提供去 Provider 工作区的路由链接（接入流程归 #03）。
 * - 详情抽屉：完整能力/限制/价格/数据来源/更新时间/接入情况/引用角色；「连通性测试」为 #04 占位。
 */

/** 行网格：模型 | Provider | 状态 | 价格 | 上下文 | 能力 | 操作。 */
const GRID = "grid grid-cols-[minmax(0,1fr)_150px_88px_130px_84px_150px_170px] items-center gap-3";

/** 参与「清除筛选」判定的键（sort 属排序视图，不随清除重置）。 */
const FILTER_KEYS = ["search", "provider", "capability", "modality", "context", "status"] as const;

export function CatalogView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [catalog, setCatalog] = useState<ModelCatalogDto | null>(null);
	const [scope, setScope] = useState<ConfigScopeDto | null>(null);
	const [scopeUnavailable, setScopeUnavailable] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	/** 目录拉取失败（可见错误 + 重试）。 */
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [query, setQuery] = useState<CatalogQuery>(DEFAULT_QUERY);
	/** 详情抽屉条目键（`provider/id`；从最新目录解析，重拉后不悬挂旧对象）。 */
	const [drawerKey, setDrawerKey] = useState<string | null>(null);
	/** in-flight 临时切换目标键；期间禁用全部切换按钮。 */
	const [tempBusy, setTempBusy] = useState<string | null>(null);
	/** 临时切换失败（可见错误）。 */
	const [switchError, setSwitchError] = useState<string | null>(null);
	/** 临时切换成功反馈（明确「仅本会话」语义）。 */
	const [switchNotice, setSwitchNotice] = useState<string | null>(null);

	const models = useMemo(() => catalog?.models ?? [], [catalog]);

	const loadCatalog = useCallback(() => {
		if (!view.connected) return;
		setIsLoading(true);
		setFetchError(null);
		void store
			.fetchModelCatalog()
			.then(setCatalog)
			.catch((err: unknown) => setFetchError(errorText(err)))
			.finally(() => setIsLoading(false));
		// 配置作用域为辅助信息（抽屉内说明持久默认边界）：失败可见但不阻断目录本体
		void store
			.fetchConfigScope()
			.then(setScope)
			.catch(() => {
				setScope(null);
				setScopeUnavailable(true);
			});
	}, [store, view.connected]);

	useEffect(() => {
		loadCatalog();
	}, [loadCatalog]);

	const visible = useMemo(() => visibleCatalog(models, query), [models, query]);
	const statusCounts = useMemo(() => countByStatus(models), [models]);
	const disabledProviders = catalog?.disabledProviders ?? [];
	const disabledModels = catalog?.disabledModels ?? [];
	const totalDisabled = disabledProviders.length + disabledModels.length;
	const filterActive = FILTER_KEYS.some(k => query[k] !== DEFAULT_QUERY[k]);

	const providerOptions = useMemo(() => {
		const labels = new Map<string, string>();
		for (const p of catalog?.providers ?? []) labels.set(p.providerId, p.displayName ?? p.providerId);
		for (const m of models) if (!labels.has(m.provider)) labels.set(m.provider, m.provider);
		return Array.from(labels, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
	}, [catalog, models]);

	const drawerEntry = useMemo(
		() => (drawerKey ? (models.find(m => keyOf(m) === drawerKey) ?? null) : null),
		[drawerKey, models],
	);
	const drawerProviderMeta = drawerEntry
		? catalog?.providers.find(p => p.providerId === drawerEntry.provider)
		: undefined;

	const patchQuery = (patch: Partial<CatalogQuery>): void => setQuery(q => ({ ...q, ...patch }));

	/** 临时切换当前会话模型（set_model_temporary）；成功/失败均有可见反馈，不改持久默认。 */
	const temporarySwitch = async (entry: ModelCatalogEntryDto): Promise<void> => {
		if (tempBusy) return;
		const key = keyOf(entry);
		setTempBusy(key);
		setSwitchError(null);
		setSwitchNotice(null);
		try {
			await store.setModelTemporary(entry.provider, entry.id);
			setSwitchNotice(`已临时切换至 ${key}——仅当前会话生效，不写入持久默认配置`);
		} catch (err) {
			setSwitchError(`临时切换失败：${errorText(err)}`);
		} finally {
			setTempBusy(null);
		}
	};

	return (
		<div>
			<div className="mb-5 flex items-baseline justify-between gap-4">
				<h2 className="section-title text-[15px]">模型目录</h2>
				<span className="text-[12px] text-ink-faint">
					{catalog
						? `共 ${models.length} 个模型 · 显示 ${visible.length} 个 · 目录生成于 ${formatIsoTime(catalog.generatedAt)}`
						: fetchError
							? "目录不可用"
							: "加载中…"}
				</span>
			</div>

			{/* 目录拉取失败（可见错误 + 重试） */}
			{fetchError && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">模型目录不可用：{fetchError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={loadCatalog}
					>
						重试
					</button>
				</div>
			)}

			{/* 临时切换失败（可见错误） */}
			{switchError && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">{switchError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={() => setSwitchError(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 临时切换成功（明确「仅本会话」，不伪装成持久默认） */}
			{switchNotice && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-2.5 text-[12px] text-success">
					<span className="flex-1">{switchNotice}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-success/30 px-2 py-0.5 transition-colors hover:bg-success/10"
						onClick={() => setSwitchNotice(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 搜索 / 筛选 / 排序 */}
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<input
					value={query.search}
					onChange={e => patchQuery({ search: e.target.value })}
					placeholder="搜索名称 / 模型 ID / provider"
					className="w-60 rounded border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
				/>
				<Select title="按 Provider 筛选" value={query.provider} onChange={v => patchQuery({ provider: v })}>
					<option value="all">全部 Provider</option>
					{providerOptions.map(p => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</Select>
				<Select
					title="按接入状态筛选（六态互斥）"
					value={query.status}
					onChange={v => patchQuery({ status: v as StatusFilter })}
				>
					<option value="all">全部接入状态</option>
					{(Object.keys(STATUS_META) as Array<keyof typeof STATUS_META>).map(s => (
						<option key={s} value={s}>
							{STATUS_META[s].label}（{statusCounts[s]}）
						</option>
					))}
				</Select>
				<Select
					title="按能力筛选"
					value={query.capability}
					onChange={v => patchQuery({ capability: v as CapabilityFilter })}
				>
					<option value="all">全部能力</option>
					<option value="thinking">支持 thinking</option>
					<option value="vision">支持视觉输入</option>
					<option value="tools">支持工具调用</option>
				</Select>
				<Select
					title="按输入模态筛选"
					value={query.modality}
					onChange={v => patchQuery({ modality: v as ModalityFilter })}
				>
					<option value="all">全部输入模态</option>
					<option value="text">文本输入</option>
					<option value="image">图像输入</option>
				</Select>
				<Select
					title="按上下文长度筛选（未知上下文的模型不满足任何阈值）"
					value={query.context}
					onChange={v => patchQuery({ context: v as ContextFilter })}
				>
					<option value="all">全部上下文</option>
					<option value="ge128k">上下文 ≥ 128K</option>
					<option value="ge200k">上下文 ≥ 200K</option>
					<option value="ge1m">上下文 ≥ 1M</option>
				</Select>
				<Select
					title="缺失排序数据（未知上下文 / 未标注发布时间）排在末尾"
					value={query.sort}
					onChange={v => patchQuery({ sort: v as SortKey })}
				>
					<option value="name">排序：名称（A→Z）</option>
					<option value="price">排序：价格（输入，低→高）</option>
					<option value="context">排序：上下文（大→小）</option>
					<option value="released">排序：发布时间（新→旧）</option>
				</Select>
				{filterActive && (
					<button
						type="button"
						className="rounded px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
						onClick={() => setQuery(q => ({ ...q, ...DEFAULT_QUERY, sort: q.sort }))}
					>
						清除筛选
					</button>
				)}
			</div>

			{/* 列表头 */}
			{visible.length > 0 && (
				<div className={`${GRID} border-b border-hairline pb-2 text-[11px] text-ink-faint`}>
					<span>模型</span>
					<span>Provider</span>
					<span>状态</span>
					<span title="输入 / 输出 · $/1M tokens">价格（入/出）</span>
					<span title="上下文窗口 tokens">上下文</span>
					<span>能力</span>
					<span className="text-right">操作</span>
				</div>
			)}

			{visible.map(m => (
				<ModelRow
					key={keyOf(m)}
					entry={m}
					isCurrent={m.id === view.model}
					switchDisabled={tempBusy !== null}
					onTemporarySwitch={() => void temporarySwitch(m)}
					onOpenDetail={() => setDrawerKey(keyOf(m))}
				/>
			))}

			{/* 加载 / 空态 */}
			{fetchError ? null : isLoading ? (
				<div className="space-y-2 py-4">
					<div className="skeleton h-11 w-full" />
					<div className="skeleton h-11 w-full" />
					<div className="skeleton h-11 w-full" />
					<div className="skeleton h-11 w-full" />
				</div>
			) : models.length === 0 ? (
				<div className="py-16 text-center text-[13px] text-ink-faint">目录为空——尚未发现任何已知模型</div>
			) : visible.length === 0 ? (
				<div className="py-16 text-center">
					<div className="text-[13px] text-ink-faint">无匹配模型——调整搜索或筛选条件</div>
					<button
						type="button"
						className="btn btn-sm mt-3"
						onClick={() => setQuery(q => ({ ...q, ...DEFAULT_QUERY, sort: q.sort }))}
					>
						清除筛选
					</button>
				</div>
			) : null}

			{/* 已停用分区（DTO 停用名单；恢复写入归 Provider 工作区 #03，此处保留入口） */}
			{totalDisabled > 0 && (
				<div className="mt-10 overflow-hidden rounded-xl border border-hairline bg-surface">
					<div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
						<span className="section-title">已停用</span>
						<span className="font-mono text-[11px] text-ink-faint">
							{totalDisabled} 项 · 停用与恢复在 Provider 工作区操作
						</span>
					</div>
					<div className="px-5 py-3">
						{disabledProviders.map(provider => (
							<DisabledRow
								key={`p:${provider}`}
								label={provider}
								note="整 Provider 停用"
								restoreTarget={provider}
							/>
						))}
						{disabledModels.map(pattern => (
							<DisabledRow key={`m:${pattern}`} label={pattern} note="单模型停用" restoreTarget={pattern} />
						))}
					</div>
				</div>
			)}

			{/* 详情抽屉（key = 条目键：切换模型时重置连通性测试确认/结果态） */}
			{drawerEntry && (
				<ModelDetailDrawer
					key={keyOf(drawerEntry)}
					entry={drawerEntry}
					providerMeta={drawerProviderMeta}
					generatedAt={catalog?.generatedAt}
					configScope={scope}
					scopeUnavailable={scopeUnavailable}
					isCurrent={drawerEntry.id === view.model}
					tempBusy={tempBusy !== null}
					onTemporarySwitch={() => void temporarySwitch(drawerEntry)}
					onConnectivityTest={() => store.testModel(drawerEntry.provider, drawerEntry.id)}
					onClose={() => setDrawerKey(null)}
				/>
			)}
		</div>
	);
}

/** 模型行：名称/ID、provider、状态徽章、输入/输出价格、上下文、能力标签、引用角色、操作。 */
function ModelRow({
	entry,
	isCurrent,
	switchDisabled,
	onTemporarySwitch,
	onOpenDetail,
}: {
	entry: ModelCatalogEntryDto;
	/** 当前会话模型（serve 快照只带 id；同 id 跨 provider 时可能多处高亮）。 */
	isCurrent: boolean;
	switchDisabled: boolean;
	onTemporarySwitch: () => void;
	onOpenDetail: () => void;
}): React.JSX.Element {
	const capsNotable = entry.capabilities.thinking || entry.capabilities.vision || !entry.capabilities.tools;
	return (
		<div
			className={`${GRID} border-b border-hairline px-1 py-3 transition-colors last:border-b-0 hover:bg-surface ${isCurrent ? "bg-accent-dim/40" : ""}`}
		>
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<ProviderLogo provider={entry.provider} modelId={entry.id} />
					<span
						className="truncate font-mono text-[14px] font-semibold tracking-[-0.02em] text-ink"
						title={keyOf(entry)}
					>
						{entry.id}
					</span>
					{isCurrent && <span className="badge done">当前</span>}
				</div>
				<div className="mt-0.5 flex items-center gap-1.5">
					<span className="truncate text-[12px] text-ink-subtle">{entry.name}</span>
					{entry.roles.slice(0, 2).map(r => (
						<span
							key={r}
							className="shrink-0 rounded bg-surface-2 px-1.5 py-px font-mono text-3xs text-ink-faint"
							title={`引用角色：${r}`}
						>
							角色 {r}
						</span>
					))}
					{entry.roles.length > 2 && (
						<span className="shrink-0 font-mono text-3xs text-ink-faint">+{entry.roles.length - 2}</span>
					)}
				</div>
			</div>
			<span className="truncate text-[12px] text-ink-subtle" title={entry.provider}>
				{entry.provider}
			</span>
			<span>
				<StatusBadge status={entry.status} />
			</span>
			<span
				className="font-mono text-[12px]"
				title={`输入 ${formatPriceUsd(entry.pricing.input)} / 输出 ${formatPriceUsd(entry.pricing.output)} · $/1M tokens`}
			>
				{formatPriceUsd(entry.pricing.input)} / {formatPriceUsd(entry.pricing.output)}
			</span>
			<span
				className="font-mono text-[12px]"
				title={
					entry.contextWindowTokens > 0
						? `${entry.contextWindowTokens.toLocaleString("en-US")} tokens`
						: "目录未提供上下文数据"
				}
			>
				{formatContextTokens(entry.contextWindowTokens)}
			</span>
			<span className="flex flex-wrap gap-1">
				{entry.capabilities.thinking && <CapTag tone="accent">thinking</CapTag>}
				{entry.capabilities.vision && <CapTag tone="info">vision</CapTag>}
				{!entry.capabilities.tools && <CapTag tone="muted">非工具</CapTag>}
				{!capsNotable && <span className="font-mono text-3xs text-ink-faint">—</span>}
			</span>
			<span className="flex items-center justify-end gap-1.5">
				{entry.status === "provider-not-configured" && (
					<Link
						to={`/models/providers?provider=${encodeURIComponent(entry.provider)}`}
						className="shrink-0 rounded border border-hairline bg-surface-2 px-2 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
						title="该 Provider 未接入，去 Provider 工作区配置"
					>
						去接入
					</Link>
				)}
				{entry.status === "available" ? (
					<button
						type="button"
						className="btn btn-sm shrink-0"
						disabled={switchDisabled || isCurrent}
						title={isCurrent ? "当前会话模型" : "临时切换当前会话模型（仅本会话生效，不写持久默认）"}
						onClick={onTemporarySwitch}
					>
						{isCurrent ? "使用中" : "临时使用"}
					</button>
				) : (
					<span
						className="shrink-0 text-[11px] text-ink-faint"
						title={`${STATUS_META[entry.status].label}：${STATUS_META[entry.status].hint}`}
					>
						不可切换
					</span>
				)}
				<button
					type="button"
					className="shrink-0 rounded px-2 py-1 text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
					onClick={onOpenDetail}
				>
					详情
				</button>
			</span>
		</div>
	);
}

/** 已停用条目（provider 或 `provider/modelId` pattern）+ 去恢复入口。 */
function DisabledRow({
	label,
	note,
	restoreTarget,
}: {
	label: string;
	note: string;
	restoreTarget: string;
}): React.JSX.Element {
	return (
		<div className="flex items-center gap-3 border-b border-hairline px-1 py-2.5 last:border-b-0">
			<span className="truncate font-mono text-[13px] text-ink">{label}</span>
			<span className="shrink-0 text-3xs text-ink-faint">{note}</span>
			<Link
				to={`/models/providers?restore=${encodeURIComponent(restoreTarget)}`}
				className="ml-auto shrink-0 rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
			>
				去恢复
			</Link>
		</div>
	);
}

function CapTag({
	tone,
	children,
}: {
	tone: "accent" | "info" | "muted";
	children: React.ReactNode;
}): React.JSX.Element {
	const cls =
		tone === "accent"
			? "bg-accent-dim text-accent"
			: tone === "info"
				? "bg-info/10 text-info"
				: "bg-surface-3 text-ink-muted";
	return <span className={`rounded px-1.5 py-px font-mono text-3xs ${cls}`}>{children}</span>;
}

function Select({
	title,
	value,
	onChange,
	children,
}: {
	title: string;
	value: string;
	onChange: (v: string) => void;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<select
			title={title}
			value={value}
			onChange={e => onChange(e.target.value)}
			className="rounded border border-hairline bg-surface-2 px-2 py-1.5 text-[12px] text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-dim)]"
		>
			{children}
		</select>
	);
}

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
