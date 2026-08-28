import type { AvailableModelsDto } from "@cornfield/wire";
import { useEffect, useState } from "react";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 模型市场（FR-6）—— get_available_models 按 Provider 分组 + set_model 切换 + 停用管理。
 * 停用（W3 模型禁用写协议 set_model_disabled）：
 * - provider 组头「停用」= 整 provider 停用（写 settings.disabledProviders）
 * - 模型行「停用」= 精确模型停用（写 settings.disabledModels `provider/modelId`）
 * 停用即从可用列表消失（服务端过滤），页面底部「已停用」分区可一键恢复。
 * 视觉主角：当前模型 hero（accent 描边大区块），其余模型行式排列。
 * 筛选：全部 / 支持 thinking / 高上下文 / 最新（启发式，真实渠道以 serve 返回为准）。
 */
type Filter = "all" | "thinking" | "long" | "new";
const FILTERS: { id: Filter; label: string }[] = [
	{ id: "all", label: "全部" },
	{ id: "thinking", label: "支持 thinking" },
	{ id: "long", label: "高上下文" },
	{ id: "new", label: "最新" },
];

export function ModelsView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [data, setData] = useState<AvailableModelsDto | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const [isLoading, setIsLoading] = useState(true);
	/** in-flight 停用/恢复目标（`provider` 或 `provider/modelId`），期间禁用所有开关。 */
	const [busy, setBusy] = useState<string | null>(null);

	const models = data?.models ?? [];

	useEffect(() => {
		if (!view.connected) return; // 未连接时跳过，连接后再拉（避免先于 WS open 的一次性失败）
		void store.fetchModels().then(setData);
		setIsLoading(false);
	}, [store, view.connected]);

	const current = view.model;
	const currentInfo =
		models.find(m => m.id === current) ??
		(current
			? {
					id: current,
					provider: current.split("/")[0] ?? "serve",
					description: "当前会话模型（serve 快照）· get_available_models 真实现后进入列表",
					supportsThinking:
						view.thinkingLevel !== undefined && view.thinkingLevel !== null && view.thinkingLevel !== "off",
				}
			: undefined);

	const visible = models.filter(m => {
		switch (filter) {
			case "thinking":
				return m.supportsThinking;
			case "long":
				return contextK(m.contextWindow) >= 200;
			case "new":
				return models.indexOf(m) < 2;
			default:
				return true;
		}
	});

	/** 停用/恢复 provider 或模型后重拉全量（models 会被服务端过滤，停用名单随响应更新）。 */
	const toggleDisabled = async (target: string, provider: string, modelId: string | undefined, disabled: boolean) => {
		if (busy) return;
		setBusy(target);
		try {
			await store.setModelDisabled(provider, modelId, disabled);
			setData(await store.fetchModels());
		} catch {
			// 命令失败（未连接等）：保留现列表，不改变本地视图
		} finally {
			setBusy(null);
		}
	};

	const totalDisabled = (data?.disabledProviders.length ?? 0) + (data?.disabledModels.length ?? 0);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="page-wide">
				<h1 className="mb-7 flex items-baseline gap-3.5 text-[32px] font-semibold tracking-[-0.8px] text-ink">
					<span>模型</span>
					<span className="text-[13px] font-normal tracking-normal text-ink-faint">
						{totalDisabled > 0 ? `${totalDisabled} 个已停用 · 底部可恢复` : "停用 provider 或单模型在列表内操作"}
					</span>
				</h1>

				{currentInfo && (
					<div className="mb-8 flex items-center gap-5 rounded-xl border border-accent bg-surface px-7 py-6">
						<div className="flex-1">
							<span className="section-title">当前使用</span>
							<div className="font-mono text-[24px] font-semibold tracking-[-0.02em] text-ink">
								{currentInfo.id}
							</div>
							<div className="mt-0.5 text-[13px] text-ink-subtle">{currentInfo.provider}</div>
							<div className="mt-3 flex gap-6">
								<HeroSpec label="上下文" value={currentInfo.contextWindow ?? "—"} />
								<HeroSpec label="价格" value={currentInfo.price ?? "—"} />
								<span className="text-3xs text-ink-faint">每百万 tokens（输入 / 输出）</span>
							</div>
							{currentInfo.supportsThinking && (
								<div className="mt-3 flex gap-1.5">
									<span className="rounded bg-accent-dim px-2 py-0.5 font-mono text-[11px] text-accent">
										thinking
									</span>
								</div>
							)}
						</div>
						<span className="rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-on-accent">使用中</span>
					</div>
				)}

				{/* 筛选 seg */}
				<div className="mb-6 flex w-fit gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
					{FILTERS.map(f => (
						<button
							key={f.id}
							type="button"
							className={`rounded px-3 py-1 text-[12px] transition-colors ${filter === f.id ? "bg-accent-dim font-medium text-ink" : "text-ink-subtle hover:text-ink"}`}
							onClick={() => setFilter(f.id)}
						>
							{f.label}
						</button>
					))}
				</div>

				{/* Provider 分组 */}
				{Array.from(new Set(visible.map(m => m.provider))).map(provider => (
					<div key={provider} className="mb-7">
						<div className="mb-2 flex items-baseline gap-2.5">
							<span className="section-title">{provider}</span>
							<span className="font-mono text-[10px] text-ink-faint">
								{visible.filter(m => m.provider === provider).length}
							</span>
							<button
								type="button"
								disabled={busy !== null}
								title={`停用整个 ${provider} provider`}
								className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
								onClick={() => void toggleDisabled(provider, provider, undefined, true)}
							>
								停用
							</button>
						</div>
						{visible
							.filter(m => m.provider === provider)
							.map(m => (
								<div
									key={m.id}
									className={`flex items-center gap-4 border-b border-hairline px-1 py-3.5 transition-colors last:border-b-0 hover:bg-surface ${m.id === current ? "bg-accent-dim/40" : ""}`}
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="font-mono text-[15px] font-semibold tracking-[-0.02em] text-ink">
												{m.id}
											</span>
											{m.id === current && <span className="badge done">当前</span>}
										</div>
										<div className="mt-0.5 text-[12px] text-ink-subtle">{m.description}</div>
									</div>
									<span className="w-[140px] shrink-0 font-mono text-xs">{m.contextWindow}</span>
									<span className="flex shrink-0 gap-1">
										{m.supportsThinking ? (
											<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-3xs text-accent">
												thinking
											</span>
										) : (
											<span className="rounded px-1.5 py-px font-mono text-3xs text-ink-faint">—</span>
										)}
									</span>
									<button
										type="button"
										disabled={busy !== null}
										title={`停用 ${m.id}`}
										className="shrink-0 rounded px-1.5 py-1 text-[11px] text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
										onClick={() => void toggleDisabled(`${provider}/${m.id}`, provider, m.id, true)}
									>
										停用
									</button>
									<button
										type="button"
										className="btn btn-sm shrink-0"
										disabled={m.id === current}
										onClick={() => store.setModel(m.id, m.provider)}
									>
										{m.id === current ? "使用中" : "使用此模型"}
									</button>
								</div>
							))}
					</div>
				))}

				{isLoading ? (
					<>
						<div className="skeleton h-10 w-full" />
						<div className="skeleton h-10 w-full" />
						<div className="skeleton h-10 w-full" />
						<div className="skeleton h-10 w-full" />
					</>
				) : models.length === 0 ? (
					<div className="py-16 text-center text-[13px] text-ink-faint">
						{data
							? "没有可用模型——当前 provider 均已停用，底部可恢复"
							: "模型列表加载中（get_available_models）…"}
					</div>
				) : null}

				{/* 已停用分区：provider / 模型 两类，一键恢复 */}
				{totalDisabled > 0 && (
					<div className="mt-10 overflow-hidden rounded-xl border border-hairline bg-surface">
						<div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
							<span className="section-title">已停用</span>
							<span className="font-mono text-[11px] text-ink-faint">{totalDisabled} 项</span>
						</div>

						{data?.disabledProviders.length ? (
							<div className="px-5 pt-3">
								<div className="mb-1.5 section-title">Provider</div>
								{data.disabledProviders.map(provider => (
									<div
										key={provider}
										className="flex items-center gap-3 border-b border-hairline px-1 py-2.5 last:border-b-0"
									>
										<span className="font-mono text-[13px] text-ink">{provider}</span>
										<span className="text-3xs text-ink-faint">整 provider 停用</span>
										<button
											type="button"
											disabled={busy !== null}
											className="ml-auto shrink-0 rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
											onClick={() => void toggleDisabled(provider, provider, undefined, false)}
										>
											恢复
										</button>
									</div>
								))}
							</div>
						) : null}

						{data?.disabledModels.length ? (
							<div className="px-5 pt-3 pb-3">
								<div className="mb-1.5 section-title">模型</div>
								{data.disabledModels.map(pattern => {
									const provider = pattern.split("/")[0] ?? "";
									return (
										<div
											key={pattern}
											className="flex items-center gap-3 border-b border-hairline px-1 py-2.5 last:border-b-0"
										>
											<span className="truncate font-mono text-[13px] text-ink">{pattern}</span>
											<button
												type="button"
												disabled={busy !== null}
												className="ml-auto shrink-0 rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
												onClick={() => {
													const modelId = pattern.slice(provider.length + 1);
													void toggleDisabled(pattern, provider, modelId, false);
												}}
											>
												恢复
											</button>
										</div>
									);
								})}
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

function HeroSpec({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<div className="text-[12px] text-ink-subtle">
			<b className="block font-mono text-[15px] font-semibold text-ink">{value}</b>
			{label}
		</div>
	);
}

function contextK(raw: string | undefined): number {
	if (!raw) return 0;
	const match = /(\d+(?:\.\d+)?)(K|M)/i.exec(raw);
	if (!match) return 0;
	const num = Number.parseFloat(match[1]);
	return match[2].toLowerCase() === "m" ? num * 1000 : num;
}
