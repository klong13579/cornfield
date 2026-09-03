import type { ProviderStatusDto } from "@cornfield/wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../state/use-session";
import { ProviderCard } from "./providers/ProviderCard";
import { errorText, statusHint } from "./providers/provider-display";
import { useProviderStore } from "./providers/provider-store";

/**
 * Provider 管理（模型控制中心 #03）—— get_providers 全量列表 + 凭据/连接维护。
 * 由 ModelsView 壳承载断连与命令错误提示；本视图只负责 Provider 本体：
 * - 列表：连接六态徽章、凭据来源（api-key/oauth/env/none，api-key 仅掩码片段）、模型数、
 *   目录 stale 标记、本地 provider 标记（展示契约见 providers/provider-display.ts）；
 * - 接入维护（ProviderCard）：OAuth（手输 code / 纯轮询刷新收口）、API Key 录入/替换/删除
 *   （password 输入 + 确认，保存后仅 maskedKey 回显）、Base URL / 本地端点、环境变量只读、
 *   断开依赖检查 + force 二次确认；
 * - 失败可见：列表拉取失败（重试）与动作失败（清除）沿用 T01 banner 模式。
 * #04 已实装：卡片级「刷新目录」（refresh_provider，不影响其他 provider）与页级
 * 「刷新全部目录」（refresh_catalog，服务端并行；失败保留旧缓存并标记 stale，不清空列表）；
 * 断开替换引导与失效态强化归 #08。
 */
export function ProvidersView(): React.JSX.Element {
	const view = useSession();
	const store = useProviderStore();
	const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	/** 列表拉取失败（可见错误 + 重试）。 */
	const [fetchError, setFetchError] = useState<string | null>(null);
	/** 卡片动作失败（可见错误，不再静默）。 */
	const [actionError, setActionError] = useState<string | null>(null);
	/** 全量刷新进行中 + 成功反馈（可见，不伪装成静默成功）。 */
	const [refreshBusy, setRefreshBusy] = useState(false);
	const [refreshNotice, setRefreshNotice] = useState<string | null>(null);

	/** 拉取 Provider 状态列表（get_providers）；失败写 fetchError 供渲染可诊断信息。 */
	const loadProviders = useCallback(() => {
		if (!view.connected) return;
		setIsLoading(true);
		setFetchError(null);
		void store
			.fetchProviders()
			.then(list => setProviders(list.providers))
			.catch((err: unknown) => setFetchError(errorText(err)))
			.finally(() => setIsLoading(false));
	}, [store, view.connected]);

	useEffect(() => {
		loadProviders();
	}, [loadProviders]);

	/** 全量刷新后的静默状态回读（不重放骨架屏）；失败保留旧列表并上抛提示。 */
	const reloadProvidersQuietly = useCallback(() => {
		return store
			.fetchProviders()
			.then(list => setProviders(list.providers))
			.catch((err: unknown) => {
				setActionError(`目录已刷新，但状态列表回读失败：${errorText(err)}`);
			});
	}, [store]);

	/** #04 全量目录刷新（refresh_catalog；服务端并行，返回刷新后的完整目录）。 */
	const refreshAllCatalogs = useCallback(() => {
		if (refreshBusy || !view.connected) return;
		setRefreshBusy(true);
		setRefreshNotice(null);
		setActionError(null);
		void store
			.refreshCatalog()
			.then(() => {
				setRefreshNotice("全部 Provider 目录已刷新；单个 Provider 失败会在对应卡片保留旧数据并标记过期");
				return reloadProvidersQuietly();
			})
			.catch((err: unknown) => setActionError(`刷新全部目录失败：${errorText(err)}`))
			.finally(() => setRefreshBusy(false));
	}, [store, view.connected, refreshBusy, reloadProvidersQuietly]);

	/** 写命令返回的权威状态回填列表（按 providerId 替换）。 */
	const applyStatus = useCallback((next: ProviderStatusDto) => {
		setProviders(prev => (prev ? prev.map(p => (p.providerId === next.providerId ? next : p)) : prev));
	}, []);

	// 已连接置顶（稳定分组：组内保持 serve 原序），未接入/异常沉底
	const list = useMemo(() => {
		const all = providers ?? [];
		const connected: ProviderStatusDto[] = [];
		const rest: ProviderStatusDto[] = [];
		for (const p of all) (p.status === "connected" ? connected : rest).push(p);
		return [...connected, ...rest];
	}, [providers]);
	const connectedCount = list.filter(p => p.status === "connected").length;
	const problemCount = list.filter(p => statusHint(p.status) !== null).length;

	return (
		<div>
			<div className="mb-5 flex items-baseline justify-between gap-4">
				<h2 className="section-title text-[15px]">Provider 管理</h2>
				<div className="flex items-center gap-3">
					<span className="text-[12px] text-ink-faint">
						{list.length > 0
							? `共 ${list.length} 个 · 已连接 ${connectedCount}${problemCount > 0 ? ` · 待处理 ${problemCount}` : ""}`
							: "凭据与连接在 provider 卡片内维护"}
					</span>
					<button
						type="button"
						className="btn btn-sm shrink-0"
						disabled={refreshBusy || !view.connected}
						title="并行刷新全部 Provider 目录（online 强制）；单 Provider 失败保留旧缓存并标记过期"
						onClick={refreshAllCatalogs}
					>
						{refreshBusy ? "刷新中…" : "刷新全部目录"}
					</button>
				</div>
			</div>

			{/* 全量刷新成功（可见反馈） */}
			{refreshNotice && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-2.5 text-[12px] text-success">
					<span className="flex-1">{refreshNotice}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-success/30 px-2 py-0.5 transition-colors hover:bg-success/10"
						onClick={() => setRefreshNotice(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 卡片动作失败（可见错误） */}
			{actionError && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">{actionError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={() => setActionError(null)}
					>
						清除
					</button>
				</div>
			)}

			{/* 列表拉取失败（可见错误 + 重试） */}
			{fetchError && (
				<div className="mb-6 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
					<span className="flex-1">Provider 列表不可用：{fetchError}</span>
					<button
						type="button"
						className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
						onClick={loadProviders}
					>
						重试
					</button>
				</div>
			)}

			{fetchError ? null : isLoading ? (
				<>
					<div className="skeleton mb-4 h-16 w-full" />
					<div className="skeleton mb-4 h-16 w-full" />
					<div className="skeleton mb-4 h-16 w-full" />
				</>
			) : list.length === 0 ? (
				<div className="py-16 text-center text-[13px] text-ink-faint">
					没有已知 Provider——目录构建后出现在这里。
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{list.map(p => (
						<ProviderCard key={p.providerId} provider={p} onStatus={applyStatus} onError={setActionError} />
					))}
				</div>
			)}
		</div>
	);
}
