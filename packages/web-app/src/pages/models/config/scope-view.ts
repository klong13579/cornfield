import type {
	ConfigInheritanceRestoreDto,
	ConfigScope,
	ConfigScopeDto,
	ConfigScopeKeyDto,
	ModelSelectionDto,
} from "@cornfield/wire";

/**
 * 运行时配置 #05 的纯展示映射（无 React / 无 store 依赖，测试直测本文件）：
 * - 逐键三层取值（项目值 / 全局值 / 生效值）的展示行与覆盖/继承判定
 * - 项目配置缺失 → 正在继承全局的横幅判定与文案
 * - 模型选择两层语义（仅当前会话 vs 持久默认）的读侧标签与写入文案
 * - 恢复继承 / 按作用域写入的结果文案（恢复=删除覆盖而非复制值；写入后报实际作用域与生效值）
 */

/** 单层取值的展示行。 */
export interface ScopeValueRow {
	layer: "project" | "global" | "effective";
	/** 层标签：项目值 / 全局值 / 生效值。 */
	label: string;
	/** 该层是否有显式值（false = 未设置，渲染 absentNote 说明）。 */
	present: boolean;
	/** 有值时的格式化文本。 */
	text: string;
	/** 无值时的继承/默认说明。 */
	absentNote: string;
}

/** 单个可覆盖键的展示视图。 */
export interface ScopeKeyView {
	key: string;
	/** 项目配置已覆盖该键（高亮 + 可恢复继承的依据）。 */
	overridden: boolean;
	/** 顺序固定：项目值 → 全局值 → 生效值。 */
	rows: ScopeValueRow[];
	/** 「恢复继承」可用 = 项目覆盖存在（删除覆盖，而非复制全局值）。 */
	restorable: boolean;
}

/** 配置作用域整体视图（继承判定 + 文件路径 + 被覆盖键清单）。 */
export interface ScopeInheritanceView {
	/** 项目级配置文件缺失 → 整体正在继承全局。 */
	inheritingGlobal: boolean;
	/** 缺失时的横幅文案（ticket 05 要求的明确文案）。 */
	inheritanceBanner: string;
	/** 项目配置文件路径（不存在时 undefined）。 */
	projectConfigPath?: string;
	globalConfigPath: string;
	/** 已被项目覆盖的键（恢复继承候选）。 */
	overriddenKeys: string[];
}

/** 模型选择两层语义视图（读侧区分，写侧 setModelTemporary / setPersistentDefaultModel 分开）。 */
export interface ModelSelectionView {
	sessionProvider: string;
	sessionModelId: string;
	/** 会话模型来源标签：仅当前会话（临时）/ 持久默认 / 注册表默认。 */
	sessionSourceLabel: string;
	/** 来源的语义说明（临时=不写文件会话结束失效 等）。 */
	sessionSourceNote: string;
	isTemporary: boolean;
	/** 持久默认展示文本（从未持久化过 = 明确说明，不与注册表默认混淆）。 */
	persistedLabel: string;
	persistedDefault: { provider: string; modelId: string } | null;
	/** 会话生效模型与持久默认不一致（或从未持久化）→ 可「设为持久默认」。 */
	diverged: boolean;
}

/** unknown 配置值的展示格式化：字符串原样，其余 JSON（含 undefined 哨兵）。 */
export function formatConfigValue(value: unknown): string {
	if (value === undefined) return "未设置";
	if (typeof value === "string") return value;
	if (value === null) return "null";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** 逐键三层展示映射：项目值 / 全局值 / 生效值 + 覆盖判定。 */
export function toScopeKeyView(dto: ConfigScopeKeyDto): ScopeKeyView {
	const projectPresent = dto.projectValue !== undefined;
	const globalPresent = dto.globalValue !== undefined;
	const effectivePresent = dto.effectiveValue !== undefined;
	return {
		key: dto.key,
		overridden: dto.overridden,
		restorable: dto.overridden,
		rows: [
			{
				layer: "project",
				label: "项目值",
				present: projectPresent,
				text: projectPresent ? formatConfigValue(dto.projectValue) : "",
				absentNote: dto.overridden
					? "已标记覆盖但未读到项目值（异常，重试刷新）"
					: "未覆盖（继承全局 / schema 默认）",
			},
			{
				layer: "global",
				label: "全局值",
				present: globalPresent,
				text: globalPresent ? formatConfigValue(dto.globalValue) : "",
				absentNote: "未设置（回落 schema 默认）",
			},
			{
				layer: "effective",
				label: "生效值",
				present: effectivePresent,
				text: effectivePresent ? formatConfigValue(dto.effectiveValue) : "",
				absentNote: projectPresent || globalPresent ? "无生效值（重试刷新）" : "两层均未设置，取 schema 默认",
			},
		],
	};
}

/** 作用域整体映射：继承判定 + 横幅文案 + 被覆盖键清单。 */
export function toScopeInheritanceView(dto: ConfigScopeDto): ScopeInheritanceView {
	const inheritingGlobal = !dto.hasProjectConfig;
	return {
		inheritingGlobal,
		inheritanceBanner: inheritingGlobal ? "当前项目无项目级配置，正在继承全局" : "",
		projectConfigPath: dto.projectConfigPath,
		globalConfigPath: dto.globalConfigPath,
		overriddenKeys: dto.keys.filter(k => k.overridden).map(k => k.key),
	};
}

/** 模型选择两层语义映射（session.source 驱动标签；persistedDefault 独立展示）。 */
export function toModelSelectionView(dto: ModelSelectionDto): ModelSelectionView {
	const sourceLabels: Record<ModelSelectionDto["session"]["source"], { label: string; note: string }> = {
		temporary: {
			label: "仅当前会话（临时）",
			note: "由临时切换设置：不写入任何配置文件，会话结束/重启后失效",
		},
		persistent: {
			label: "持久默认",
			note: "与持久化默认模型一致（settings.modelRoutes.default.primary）",
		},
		"registry-default": {
			label: "注册表默认",
			note: "未持久化过默认模型，当前按注册表默认解析",
		},
	};
	const source = sourceLabels[dto.session.source];
	const persistedDefault = dto.persistedDefault;
	return {
		sessionProvider: dto.session.provider,
		sessionModelId: dto.session.modelId,
		sessionSourceLabel: source.label,
		sessionSourceNote: source.note,
		isTemporary: dto.session.source === "temporary",
		persistedLabel: persistedDefault
			? `${persistedDefault.provider}/${persistedDefault.modelId}`
			: "未持久化过默认模型",
		persistedDefault,
		diverged:
			dto.session.source === "temporary" ||
			!persistedDefault ||
			persistedDefault.provider !== dto.session.provider ||
			persistedDefault.modelId !== dto.session.modelId,
	};
}

/**
 * 恢复继承结果文案：明确「删除项目覆盖」而非「把全局值复制进项目文件」。
 * removed=false = 项目文件本无该覆盖（幂等），如实说明。
 */
export function describeRestore(dto: ConfigInheritanceRestoreDto): string {
	if (!dto.removed) {
		return `「${dto.key}」在项目配置中本无覆盖，无需恢复（幂等操作）；当前生效值：${formatConfigValue(dto.effectiveValue)}`;
	}
	return `已删除「${dto.key}」的项目覆盖（恢复继承 = 删除覆盖，不会把全局值复制进项目文件）；生效值回落为：${formatConfigValue(dto.effectiveValue)}`;
}

/** 写入结果输入（作用域文件路径由调用方从刷新后的 ConfigScopeDto 取）。 */
export interface WriteResultInput {
	key: string;
	scope: ConfigScope;
	/** 实际写入的配置文件路径（global = globalConfigPath；project = projectConfigPath，新建后刷新可得）。 */
	scopePath?: string;
	/** 写入后该键的生效值（刷新后的合并视图）。 */
	effectiveValue: unknown;
}

/** 按作用域写入的结果文案：报实际写入作用域（含文件路径）与写入后生效值。 */
export function describeWriteResult(input: WriteResultInput): string {
	const scopeText =
		input.scope === "global"
			? `全局配置（${input.scopePath ?? "<agentDir>/config.yml"}）`
			: `项目配置（${input.scopePath ?? "<cwd>/.cornfield/config.yml"}）`;
	return `已写入${scopeText}的「${input.key}」；写入后生效值：${formatConfigValue(input.effectiveValue)}`;
}

/** 模型写入种类：temporary = 仅当前会话；persist = 持久默认（写全局配置）。 */
export type ModelWriteKind = "temporary" | "persist";

/** 模型写入结果文案：两种写法语义分离，文案明确「不写文件/仅会话」vs「持久化到配置」。 */
export function describeModelWrite(kind: ModelWriteKind, provider: string, modelId: string): string {
	const ref = `${provider}/${modelId}`;
	if (kind === "temporary") {
		return `已临时切换为 ${ref}：仅当前会话生效，不写入任何配置文件；持久默认模型不变。`;
	}
	return `已设为持久默认 ${ref}：写入全局配置（settings.modelRoutes.default.primary），持久生效；这不是会话级临时切换。`;
}

/** 解析 `provider/modelId` 选择值（provider 不含 `/`，取首个 `/` 切分）；非法输入返回 null。 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | null {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return null;
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** 编辑器草稿解析：JSON.parse 包一层，失败返回可诊断错误（不静默丢弃输入）。 */
export function parseConfigDraft(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (err) {
		return { ok: false, error: `值不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
	}
}
