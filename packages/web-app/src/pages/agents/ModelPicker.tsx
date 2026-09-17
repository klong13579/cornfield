import type { ModelInfoDto } from "@cornfield/wire";
import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";

/**
 * Agent 详情「模型配置」tab 的 Provider / Model 两个下拉（真数据路径：get_available_models / set_model）。
 *
 * ## 这一版修的是什么
 *
 * 1. Provider 下拉的选中值曾经写死 `"anthropic"` —— 它不在自己的选项里。React 受控 select 的 value
 *    对不上任何 option 时，浏览器把 selectedIndex 置 -1：屏幕上就是「一个都没选中」。现在它由**当前
 *    agent 的真实模型**推出来（`agent.model` / `view.model`，与标题上的模型徽标同源）。
 * 2. Model 下拉曾被上面那个写死的 provider 过滤，首屏筛完为空、于是**一个 option 都没有**：既选不了，
 *    也看不到当前模型。现在任何一帧都保证 ≥1 个 option。
 *
 * ## provider 只能从真目录里查出来，不能从模型串上切
 *
 * web-app 拿到的当前模型是**裸 id**（`AgentInfoDto.model` 与 `view.model` 都由适配层取 `.id`，
 * 见 pi-client-adapter 的 mapAgentEntry / session-store 的 #applySnapshot），不带 `provider/` 前缀。
 * 所以「这个模型归谁」的唯一真数据来源是 `get_available_models` 的目录条目：拿 id 去查，**唯一**
 * 命中才算知道。查不到（目录没到 / 不在可用列表 / 同名模型分属多个 provider）就是不知道 ——
 * 这一栏明说「未知」，不编一个 provider 名（编出来的那个会让筛选和写命令都指向错的 provider）。
 *
 * ## Model 下拉为什么按「当前模型在不在这一份选项里」补项
 *
 * 旧写法是 `models.length === 0` 时补一个兑底 option —— 它只在**整个目录为空**时生效，恰好在
 * 「目录里有模型、只是不归当前 provider」这一帧失灵，而那正是首屏。判断条件必须是「当前模型
 * 在不在这一份选项里」：不在就让它自己作为一项出现（「当前：…」，不可选 —— 它是事实，不是选项）。
 *
 * ## 四种「没有」分开说
 *
 *   未连接   —— 读不到目录（未连接 **不是** 没有模型）
 *   加载中   —— 还没问完
 *   读取失败 —— 问了，命令失败（原文照显，可重试）
 *   没有模型 —— 问了，serve 明确返回空
 * 前三者渲染成第四种，用户会据此以为这个 agent 无模型可用。
 */

/** 可用模型目录（get_available_models）的读取状态，四态互斥。 */
export type AvailableModelsState =
	| { status: "disconnected" }
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "ready"; models: ModelInfoDto[] };

export interface ModelOption {
	/** 选项值。Provider 的选项是 provider 名；Model 的选项是**裸模型 id**（set_model 的 modelId）。 */
	value: string;
	label: string;
	/** 事实项而非可选项（当前模型 / 未知 provider）：不可选，只用来把选中值托住。 */
	disabled?: boolean;
}

/**
 * 当前模型所属的 provider：拿裸 id 去真目录里查，**唯一**命中才算知道，否则 `""`（未知）。
 * 不返回猜测值 —— 猜错的 provider 会让 Model 列表筛空、让 set_model 报 Model not found。
 */
export function providerOfCurrentModel(model: string, catalog: readonly ModelInfoDto[]): string {
	const id = model.trim();
	if (id === "") return "";
	const matched = new Set(catalog.filter(m => m.id === id).map(m => m.provider));
	return matched.size === 1 ? [...matched][0]! : "";
}

/**
 * Provider 下拉的选项：目录里的 provider，必要时把「当前选中的那个」自己补进来 ——
 * 受控 select 的 value 必须在自己选项里，否则 selectedIndex 就是 -1。
 */
export function providerOptions(providers: readonly string[], selected: string): ModelOption[] {
	const options: ModelOption[] = providers.map(p => ({ value: p, label: p }));
	if (options.some(o => o.value === selected)) return options;
	return [
		{
			value: selected,
			label: selected === "" ? "未知" : `${selected}（不在可用列表）`,
			disabled: true,
		},
		...options,
	];
}

/**
 * Model 下拉的选项：当前 provider 名下的可选模型；当前模型不在这一份里时，它自己作为一项出现。
 * 恒 ≥1 项：当前模型在筛选集里 → 筛选集非空；不在 → 补的那一项在。
 * provider 未知（`""`）时不列任何模型 —— 拿一个不知道的 provider 去筛，筛出来的东西是编的。
 */
export function modelOptions(catalog: readonly ModelInfoDto[], provider: string, currentModel: string): ModelOption[] {
	const options: ModelOption[] =
		provider === "" ? [] : catalog.filter(m => m.provider === provider).map(m => ({ value: m.id, label: m.id }));
	if (options.some(o => o.value === currentModel)) return options;
	return [
		{
			value: currentModel,
			label: currentModel === "" ? "（该 agent 未报模型）" : `当前：${currentModel}`,
			disabled: true,
		},
		...options,
	];
}

export interface ModelPickerViewProps {
	state: AvailableModelsState;
	/** 当前 agent 的模型（`agent.model` / `view.model`，裸 id；与标题徽标同源）。 */
	currentModel: string;
	/** 用户本次显式选过的 provider；null = 没选过 → 用当前模型推出来的那个。 */
	providerPick: string | null;
	onPickProvider: (provider: string) => void;
	/** 选中项来自哪个 provider 就报哪个：serve 的 set_model 按 (provider, modelId) 配对查表。 */
	onPickModel: (modelId: string, provider: string) => void;
	onRetry: () => void;
}

/**
 * 纯展示层（无 state、无请求）：所有输入都是 props，所以四种读取态在渲染级就能整份验
 * （静态渲染不跑 effect —— 这正是 ArtifactsPanel / ChangesPanel 同一套写法的原因）。
 */
export function ModelPickerView({
	state,
	currentModel,
	providerPick,
	onPickProvider,
	onPickModel,
	onRetry,
}: ModelPickerViewProps): React.JSX.Element {
	// 目录没到（未连接/加载中/失败）时只有「不知道」这一件事可说 —— 不拿空数组冒充「没有模型」。
	const catalog = state.status === "ready" ? state.models : [];
	const currentProvider = providerOfCurrentModel(currentModel, catalog);
	const selProvider = providerPick ?? currentProvider;
	const providers = Array.from(new Set(catalog.map(m => m.provider)));
	const providerChoices = providerOptions(providers, selProvider);
	const modelChoices = modelOptions(catalog, selProvider, currentModel);

	return (
		<>
			<div className="text-[11px] text-ink-faint" data-testid="model-catalog-state">
				{state.status === "disconnected" && "未连接——读不到可用模型列表"}
				{state.status === "loading" && "加载中…"}
				{state.status === "error" && (
					<>
						<span className="text-danger">读取可用模型失败：{state.error}</span>
						<button type="button" className="ml-2 underline hover:text-ink" onClick={onRetry}>
							重试
						</button>
					</>
				)}
				{state.status === "ready" &&
					(state.models.length === 0
						? "serve 返回的可用模型列表为空——该 agent 没有可选模型"
						: `可用模型 ${state.models.length} 个（get_available_models）`)}
			</div>

			<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
				<span className="w-[90px] shrink-0">Provider</span>
				<select
					value={selProvider}
					onChange={e => onPickProvider(e.target.value)}
					data-testid="model-provider-select"
					className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
				>
					{providerChoices.map(o => (
						<option key={o.value} value={o.value} disabled={o.disabled}>
							{o.label}
						</option>
					))}
				</select>
			</label>

			<label className="flex items-center gap-3 text-[13px] text-ink-subtle">
				<span className="w-[90px] shrink-0">Model</span>
				<select
					value={currentModel}
					onChange={e => onPickModel(e.target.value, selProvider)}
					data-testid="model-select"
					className="flex-1 rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
				>
					{modelChoices.map(o => (
						<option key={o.value} value={o.value} disabled={o.disabled}>
							{o.label}
						</option>
					))}
				</select>
			</label>
		</>
	);
}

/** 读可用模型目录。未连接在**渲染时**判定（不发请求），连不上的那一帧就已经是「未连接」。 */
function useAvailableModels(connected: boolean): { state: AvailableModelsState; reload: () => void } {
	const store = useSessionStore();
	const [state, setState] = useState<AvailableModelsState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const reload = useCallback(() => setAttempt(n => n + 1), []);

	useEffect(() => {
		let cancelled = false;
		if (!connected) return;
		setState({ status: "loading" });
		// fetchModels 失败契约是抛错（不吞错、不返回空数组）—— 这里把它变成可见的「读取失败」，
		// 而不是留在一条 unhandled rejection 里、屏幕上什么都不说。
		store
			.fetchModels()
			.then(result => {
				if (!cancelled) setState({ status: "ready", models: result.models });
			})
			.catch((err: unknown) => {
				if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			cancelled = true;
		};
	}, [connected, store, attempt]);

	if (!connected) return { state: { status: "disconnected" }, reload };
	return { state, reload };
}

/**
 * 容器：拉目录 + 记用户选过的 provider，渲染交给 {@link ModelPickerView}。
 * 调用方用 `key={agentId}` 挂载 —— 换 agent 时重挂，不会把上一个 agent 的 provider 选择带过来。
 */
export function ModelPicker({ agentId, currentModel }: { agentId: string; currentModel: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [providerPick, setProviderPick] = useState<string | null>(null);
	const { state, reload } = useAvailableModels(view.connected);

	return (
		<ModelPickerView
			state={state}
			currentModel={currentModel}
			providerPick={providerPick}
			onPickProvider={setProviderPick}
			onPickModel={(modelId, provider) => {
				// provider 与 modelId 必须同来：serve 按 (provider, modelId) 配对查表，缺一个就是
				// `Model not found` —— 宁可不发，也不发一条注定失败的写。
				if (modelId === "" || provider === "") return;
				store.setModel(modelId, provider, agentId);
			}}
			onRetry={reload}
		/>
	);
}
