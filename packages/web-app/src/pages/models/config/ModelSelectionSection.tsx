import type { ModelCatalogDto, ModelSelectionDto } from "@cornfield/wire";
import { useEffect, useMemo, useState } from "react";
import { availableModels, groupModelsByProvider } from "./model-options";
import { splitModelRef, toModelSelectionView } from "./scope-view";

/**
 * 模型选择语义分离（#05）：当前会话模型（temporary）与持久默认模型两个分区独立展示，
 * 写入走两条不同链路——临时切换 setModelTemporary（仅本会话，不写文件）与
 * setPersistentDefaultModel（写全局配置 modelRoutes.default.primary）。文案逐处区分两种语义。
 */
interface ModelSelectionSectionProps {
	selection: ModelSelectionDto;
	/** 模型目录（get_model_catalog）供选择器；仅列出 available 模型；拉取失败为 null（按钮禁用）。 */
	catalog: ModelCatalogDto | null;
	busy: boolean;
	onTemporary(provider: string, modelId: string): void;
	onPersist(provider: string, modelId: string): void;
	/** 快捷隐藏 provider（写全局停用名单 disabledProviders，同 Provider 工作区链路）；缺省不渲染入口。 */
	onHideProvider?(provider: string): Promise<void>;
}

export function ModelSelectionSection({
	selection,
	catalog,
	busy,
	onTemporary,
	onPersist,
	onHideProvider,
}: ModelSelectionSectionProps): React.JSX.Element {
	const [picked, setPicked] = useState("");
	/** 两步确认：已点一下待确认的 provider（再点执行，4s 无操作自动解除）。 */
	const [armed, setArmed] = useState<string | null>(null);
	const [hiding, setHiding] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const t = setTimeout(() => setArmed(null), 4000);
		return () => clearTimeout(t);
	}, [armed]);
	const view = toModelSelectionView(selection);
	const sessionRef = `${view.sessionProvider}/${view.sessionModelId}`;
	const persistedRef = view.persistedDefault
		? `${view.persistedDefault.provider}/${view.persistedDefault.modelId}`
		: null;
	const pickedRef = picked ? splitModelRef(picked) : null;
	// v2 目录含全部已知模型；选择器只提供可切换的 available 模型（其余状态在目录页可见可诊断），按 provider 分组
	const models = useMemo(() => availableModels(catalog?.models ?? []), [catalog]);
	const groups = useMemo(() => groupModelsByProvider(models), [models]);

	const temporaryDisabled = busy || !pickedRef || picked === sessionRef;
	const persistDisabled = busy || !pickedRef || picked === persistedRef;

	return (
		<div className="space-y-3">
			<div className="grid gap-3 lg:grid-cols-2">
				{/* 分区一：当前会话模型（临时语义） */}
				<div className="rounded-xl border border-hairline bg-surface px-5 py-4">
					<div className="flex items-center gap-2.5">
						<span className="section-title text-[13px]">当前会话模型</span>
						<span
							className={`rounded px-1.5 py-px font-mono text-3xs ${view.isTemporary ? "bg-accent-dim text-accent" : "text-ink-faint"}`}
						>
							{view.sessionSourceLabel}
						</span>
					</div>
					<div className="mt-2 font-mono text-[15px] font-semibold text-ink">{sessionRef}</div>
					<div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">{view.sessionSourceNote}</div>
				</div>

				{/* 分区二：持久默认模型（持久语义） */}
				<div className="rounded-xl border border-hairline bg-surface px-5 py-4">
					<div className="flex items-center gap-2.5">
						<span className="section-title text-[13px]">持久默认模型</span>
						<span className="rounded px-1.5 py-px font-mono text-3xs text-ink-faint">写入配置文件</span>
					</div>
					<div className="mt-2 font-mono text-[15px] font-semibold text-ink">{view.persistedLabel}</div>
					<div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
						{view.persistedDefault
							? "持久化在全局配置（settings.modelRoutes.default.primary），与会话级临时切换相互独立"
							: "从未持久化过默认模型——与会话临时切换是两回事，此处为空不代表没有会话模型"}
					</div>
				</div>
			</div>

			{/* 选择器 + 两条写入链路（文案区分「仅当前会话」与「持久默认」） */}
			<div className="rounded-xl border border-hairline bg-surface px-5 py-4">
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-[12px] text-ink-subtle">切换到</span>
					<select
						className="max-w-[360px] flex-1 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
						value={picked}
						onChange={e => setPicked(e.target.value)}
					>
						<option value="">{models.length > 0 ? "选择模型…" : "无可用模型"}</option>
						{groups.map(g => (
							<optgroup key={g.provider} label={`${g.provider} · ${g.models.length}`}>
								{g.models.map(m => (
									<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
										{m.id}
									</option>
								))}
							</optgroup>
						))}
					</select>
					<button
						type="button"
						className="btn btn-sm shrink-0"
						disabled={temporaryDisabled}
						title={picked === sessionRef ? "当前会话已是该模型" : "临时切换：仅当前会话生效，不写入任何配置文件"}
						onClick={() => {
							if (pickedRef) onTemporary(pickedRef.provider, pickedRef.modelId);
						}}
					>
						{busy ? "执行中…" : "仅当前会话使用（临时）"}
					</button>
					<button
						type="button"
						className="rounded border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
						disabled={persistDisabled}
						title={picked === persistedRef ? "持久默认已是该模型" : "持久默认：写入全局配置，持久生效"}
						onClick={() => {
							if (pickedRef) onPersist(pickedRef.provider, pickedRef.modelId);
						}}
					>
						设为持久默认（写入配置）
					</button>
				</div>
				<div className="mt-2 text-[11px] text-ink-faint">
					两条链路语义不同：临时切换仅影响当前会话且不落盘；持久默认写入全局配置（modelRoutes.default.primary）并持久生效。
					{view.diverged && " 当前会话模型与持久默认不一致。"}
				</div>
				{onHideProvider && groups.length > 0 && (
					<div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2.5">
						<span className="text-[11px] text-ink-faint">多了不想要的 Provider？</span>
						{groups.map(g => {
							const isArmed = armed === g.provider;
							return (
								<button
									key={g.provider}
									type="button"
									aria-label={isArmed ? `确认隐藏 ${g.provider}？` : `隐藏 ${g.provider}`}
									className={`rounded border px-1.5 py-px font-mono text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
										isArmed
											? "border-danger/40 text-danger"
											: "border-hairline bg-surface-2 text-ink-subtle hover:border-hairline-strong hover:text-ink"
									} ${hiding && !isArmed ? "opacity-40" : ""}`}
									disabled={busy || (hiding && !isArmed)}
									title={`两步确认隐藏 ${g.provider}（写全局停用名单，可在 Provider 工作区恢复）`}
									onClick={() => {
										if (hiding) return;
										if (!isArmed) {
											setArmed(g.provider);
											return;
										}
										setHiding(true);
										void onHideProvider(g.provider)
											.catch(() => {}) // 失败由页面层 actionError 呈现，此处仅复位本地状态
											.finally(() => {
												setHiding(false);
												setArmed(null);
											});
									}}
								>
									{hiding && isArmed ? `隐藏中…` : isArmed ? `确认隐藏 ${g.provider}？` : `${g.provider} ✕`}
								</button>
							);
						})}
						<span className="text-[10.5px] text-ink-faint">
							两步确认，写全局停用名单，可在 Provider 工作区恢复
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
