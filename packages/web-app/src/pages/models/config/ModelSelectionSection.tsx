import type { ModelCatalogDto, ModelSelectionDto } from "@cornfield/wire";
import { useState } from "react";
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
}

export function ModelSelectionSection({
	selection,
	catalog,
	busy,
	onTemporary,
	onPersist,
}: ModelSelectionSectionProps): React.JSX.Element {
	const [picked, setPicked] = useState("");
	const view = toModelSelectionView(selection);
	const sessionRef = `${view.sessionProvider}/${view.sessionModelId}`;
	const persistedRef = view.persistedDefault
		? `${view.persistedDefault.provider}/${view.persistedDefault.modelId}`
		: null;
	const pickedRef = picked ? splitModelRef(picked) : null;
	// v2 目录含全部已知模型；选择器只提供可切换的 available 模型（其余状态在目录页可见可诊断）
	const models = (catalog?.models ?? []).filter(m => m.status === "available");

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
						{models.map(m => (
							<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
								{m.provider}/{m.id}
							</option>
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
			</div>
		</div>
	);
}
