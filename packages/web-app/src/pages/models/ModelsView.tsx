import type { ConfigScopeDto, ModelCatalogDto, ProviderListDto } from "@cornfield/wire";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import type { ControlCenterException, ExceptionSeverity } from "./exceptions";
import { catalogHealth, deriveExceptions } from "./exceptions";
import { subscribeMccDataChanged } from "./providers/mcc-sync";

/**
 * 模型控制中心（#01 骨架；#08 异常区）—— /models 壳 + 三个子工作区（router.tsx modelsRoutes）：
 * - /models/catalog  模型目录（原模型市场能力整体归位，CatalogView）
 * - /models/providers Provider 管理（ProvidersView + ProviderCard）
 * - /models/config   运行时配置（RuntimeConfigView）
 * /models 经 index 路由重定向到 /models/catalog。
 *
 * 壳承载：
 * - 顶部状态条（当前会话模型 / 配置作用域 / 目录状态 / 异常数量）——异常数与目录状态
 *   为壳层自拉三份数据（get_providers + get_model_catalog + get_config_scope）的派生值；
 * - 异常区（#08）：expandable 异常清单，每项带严重级别与跳转入口；无异常不占空间；
 * - 断连提示（明确文案 + 重试入口）与命令错误提示（store commandError，含 set_model 失败）。
 *
 * 异常数据流：ProviderCard 写动作成功 → mcc-sync notifyMccDataChanged → 壳层重拉三份
 * 数据 → deriveExceptions 重新推导。断开后失效待修复异常随之出现，重新接入后自动消失
 * （纯派生态，无清理动作）。
 */
const TABS: { to: string; label: string }[] = [
	{ to: "/models/catalog", label: "模型目录" },
	{ to: "/models/providers", label: "Provider" },
	{ to: "/models/config", label: "运行时配置" },
];

/** 严重级别徽章（badge 色板见 index.css：fail=红，run=琥珀）。 */
const SEVERITY_BADGES: Record<ExceptionSeverity, { label: string; className: string }> = {
	critical: { label: "严重", className: "badge fail" },
	warning: { label: "警告", className: "badge run" },
};

/** 异常跳转入口文案（按目标工作区区分）。 */
const TARGET_LABELS: Record<ControlCenterException["target"], string> = {
	"/models/providers": "去 Provider 工作区",
	"/models/config": "去运行时配置",
	"/models/catalog": "去模型目录",
};

export function ModelsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [providers, setProviders] = useState<ProviderListDto | null>(null);
	const [catalog, setCatalog] = useState<ModelCatalogDto | null>(null);
	const [scope, setScope] = useState<ConfigScopeDto | null>(null);
	/** 异常区数据拉取失败（状态条标注，不弹 banner——子视图有各自的错误呈现）。 */
	const [dataUnavailable, setDataUnavailable] = useState(false);
	/** 异常清单展开态（仅异常数 > 0 时可展开；无异常不占空间）。 */
	const [exceptionsOpen, setExceptionsOpen] = useState(false);

	/** 重拉三份异常区数据（settle 全部完成后再统一落状态，避免半新半旧推导）。 */
	const loadExceptionData = useCallback(() => {
		if (!view.connected) return;
		Promise.allSettled([store.fetchProviders(), store.fetchModelCatalog(), store.fetchConfigScope()]).then(
			([p, c, s]) => {
				setProviders(p.status === "fulfilled" ? p.value : null);
				setCatalog(c.status === "fulfilled" ? c.value : null);
				setScope(s.status === "fulfilled" ? s.value : null);
				setDataUnavailable(p.status === "rejected" || c.status === "rejected" || s.status === "rejected");
			},
		);
	}, [store, view.connected]);

	useEffect(() => {
		loadExceptionData();
	}, [loadExceptionData]);

	// ProviderCard 写动作（断开 / 凭据 / 端点 / 目录刷新）后重拉，异常区随之更新；
	// loadExceptionData 内部自带 connected 守卫，断连期间的事件不触发请求
	useEffect(() => subscribeMccDataChanged(loadExceptionData), [loadExceptionData]);

	const exceptions = useMemo(() => deriveExceptions({ providers, catalog, scope }), [providers, catalog, scope]);
	const health = catalogHealth(catalog);
	const catalogTitle = catalog
		? health.staleCount > 0
			? `${health.staleCount} 个 Provider 目录为非权威数据（缓存 / 回落）`
			: "全部 Provider 目录为权威数据"
		: "目录状态未知（数据未就绪或拉取失败）";
	const exceptionTitle = dataUnavailable ? "异常数据不可用（拉取失败）" : "异常数量（点击展开 / 收起清单）";

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-wide">
				<h1 className="mb-6 text-[32px] font-semibold tracking-[-0.8px] text-ink">模型控制中心</h1>

				{/* 顶部状态条 */}
				<div className="mb-6 flex items-center gap-8 rounded-xl border border-hairline bg-surface px-5 py-3.5">
					<StatusItem label="当前会话模型" value={view.model ?? "—"} mono />
					<StatusItem
						label="配置作用域"
						value="全局"
						title="本票固定为「全局」占位；per-agent 作用域后续 ticket 落地"
					/>
					<StatusItem label="目录状态" value={health.label} title={catalogTitle} danger={health.staleCount > 0} />
					{exceptions.length > 0 ? (
						<button
							type="button"
							className="flex items-baseline gap-2 rounded px-1 transition-colors hover:bg-surface-2"
							onClick={() => setExceptionsOpen(open => !open)}
							title={exceptionTitle}
						>
							<span className="text-[11px] text-ink-faint">异常</span>
							<span className="text-[13px] font-medium text-danger">{exceptions.length}</span>
							<span className="text-[11px] text-ink-faint">{exceptionsOpen ? "收起 ▲" : "展开 ▼"}</span>
						</button>
					) : (
						<StatusItem label="异常" value={dataUnavailable ? "—" : "0"} title={exceptionTitle} />
					)}
				</div>

				{/* 异常区：可展开清单（无异常不渲染，不占空间） */}
				{exceptions.length > 0 && exceptionsOpen && (
					<div className="mb-6 overflow-hidden rounded-xl border border-danger/40 bg-surface">
						<div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
							<span className="section-title text-[13px]">异常清单</span>
							<span className="text-[11px] text-ink-faint">
								{exceptions.length} 项 · 严重 {exceptions.filter(e => e.severity === "critical").length} · 警告{" "}
								{exceptions.filter(e => e.severity === "warning").length}
							</span>
						</div>
						<div className="divide-y divide-hairline">
							{exceptions.map(item => (
								<ExceptionRow key={exceptionKey(item)} item={item} />
							))}
						</div>
					</div>
				)}

				{/* 二级导航 */}
				<div className="mb-6 flex w-fit gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
					{TABS.map(tab => (
						<NavLink
							key={tab.to}
							to={tab.to}
							className={({ isActive }) =>
								`rounded px-3 py-1 text-[12px] transition-colors ${isActive ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`
							}
						>
							{tab.label}
						</NavLink>
					))}
				</div>

				{/* 命令错误（store 暴露）—— 可诊断 + 可清除；计入异常区之外的独立呈现，不折算计数 */}
				{view.commandError && (
					<div className="mb-6 flex items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12px] text-danger">
						<span className="flex-1">{view.commandError}</span>
						<button
							type="button"
							className="shrink-0 rounded border border-danger/30 px-2 py-0.5 transition-colors hover:bg-danger/10"
							onClick={() => store.clearCommandError()}
						>
							清除
						</button>
					</div>
				)}

				{!view.connected ? (
					/* 断连：明确提示 + 重试入口（不再永久骨架屏，也不渲染子工作区） */
					<div className="rounded-xl border border-hairline bg-surface px-6 py-12 text-center">
						<div className="text-[14px] font-medium text-ink">与 serve 未连接</div>
						<div className="mt-1.5 text-[12px] text-ink-subtle">
							模型目录、Provider 与运行时配置都依赖 serve 连接（{view.wsUrl}）
						</div>
						<button type="button" className="btn btn-sm mt-5" onClick={() => void store.connect()}>
							重试连接
						</button>
					</div>
				) : (
					<Outlet />
				)}
			</div>
		</div>
	);
}

/** 异常行唯一键：kind + 定位信息（provider / role+position / model），清单重排稳定。 */
function exceptionKey(item: ControlCenterException): string {
	if (item.providerId) return `${item.kind}:${item.providerId}`;
	if (item.role) return `${item.kind}:${item.role}:${item.position ?? ""}:${item.model ?? ""}`;
	return item.kind;
}

/** 异常清单行：严重级别徽章 + 标题 + 处置说明 + 跳转入口。 */
function ExceptionRow({ item }: { item: ControlCenterException }): React.JSX.Element {
	const badge = SEVERITY_BADGES[item.severity];
	return (
		<div className="flex items-start gap-3 px-5 py-2.5">
			<span className={`${badge.className} mt-0.5 shrink-0`}>{badge.label}</span>
			<div className="min-w-0 flex-1">
				<div className="text-[13px] font-medium text-ink">{item.title}</div>
				<div className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{item.detail}</div>
				{item.role && (
					<div className="mt-0.5 font-mono text-[11px] text-ink-faint">
						{item.role} · {item.position} → {item.model}
					</div>
				)}
			</div>
			<Link
				to={item.target}
				className="mt-0.5 shrink-0 rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
			>
				{TARGET_LABELS[item.target]}
			</Link>
		</div>
	);
}

function StatusItem({
	label,
	value,
	mono,
	danger,
	title,
}: {
	label: string;
	value: string;
	mono?: boolean;
	danger?: boolean;
	title?: string;
}): React.JSX.Element {
	return (
		<div className="flex items-baseline gap-2" title={title}>
			<span className="text-[11px] text-ink-faint">{label}</span>
			<span className={`${mono ? "font-mono" : ""} text-[13px] font-medium ${danger ? "text-danger" : "text-ink"}`}>
				{value}
			</span>
		</div>
	);
}
