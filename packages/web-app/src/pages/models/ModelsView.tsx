import { useEffect, useState } from "react";
import type { ModelInfoDto } from "../../lib/wire-dto";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * 模型市场（FR-6）—— get_available_models 按 Provider 分组 + set_model 切换。
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
	const [models, setModels] = useState<ModelInfoDto[]>([]);
	const [filter, setFilter] = useState<Filter>("all");

	useEffect(() => {
		if (!view.connected) return; // 未连接时跳过，连接后再拉（避免先于 WS open 的一次性失败）
		void store.fetchModels().then(setModels);
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

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[900px]">
				<h1 className="mb-7 text-[32px] font-semibold tracking-[-0.8px] text-ink">模型</h1>

				{currentInfo && (
					<div className="mb-8 flex items-center gap-5 rounded-xl border border-accent bg-surface px-7 py-6">
						<div className="flex-1">
							<div className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-accent-hover uppercase">
								当前使用
							</div>
							<div className="font-mono text-[24px] font-semibold tracking-[-0.02em] text-ink">
								{currentInfo.id}
							</div>
							<div className="mt-0.5 text-[13px] text-ink-subtle">{currentInfo.provider}</div>
							<div className="mt-3 flex gap-6">
								<HeroSpec label="上下文" value={currentInfo.contextWindow ?? "—"} />
								<HeroSpec label="价格" value={currentInfo.price ?? "—"} />
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
							className={`rounded px-3 py-1 text-[12px] transition-colors ${filter === f.id ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
							onClick={() => setFilter(f.id)}
						>
							{f.label}
						</button>
					))}
				</div>

				{/* Provider 分组 */}
				{Array.from(new Set(visible.map(m => m.provider))).map(provider => (
					<div key={provider} className="mb-7">
						<div className="mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							{provider}
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
									<span className="w-[140px] shrink-0 font-mono text-[12px] text-ink-subtle">
										{m.contextWindow}
									</span>
									<span className="flex shrink-0 gap-1">
										{m.supportsThinking ? (
											<span className="rounded bg-accent-dim px-1.5 py-px font-mono text-[10px] text-accent">
												thinking
											</span>
										) : (
											<span className="rounded px-1.5 py-px font-mono text-[10px] text-ink-faint">—</span>
										)}
									</span>
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

				{models.length === 0 && (
					<div className="py-16 text-center text-[13px] text-ink-faint">
						模型列表加载中（get_available_models）…
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
