import type { ConfigScope, ModelCatalogDto, ModelCatalogStatus } from "@cornfield/wire";

/**
 * 角色配置编辑器 #07 的纯逻辑（无 React / 无 store 依赖，测试直测本文件）：
 * - 草稿状态机：内置 + 自定义角色的主模型 / 回退链增删排序、新增 / 复制 / 重命名 / 删除、按角色恢复已保存值；
 * - diff 计算：逐角色逐字段（主模型、回退链增删 + 重排）旧→新；
 * - 校验（保存闸门）：重复模型、已停用、未接入 provider、目录不存在的 spec 为 error（阻止保存）；
 *   凭据失效 / 本地离线 / 目录非权威 / 目录不可用为 warning（不阻止）；空主模型但有回退链允许但需明示；
 * - 序列化：草稿 → modelRoutes 写入值（空角色条目丢弃，等价于移除）；
 * - 草稿持久化（sessionStorage 载荷编解码 + 基准指纹校验）；
 * - modelTags 展示元数据（自定义角色颜色）的变更计算与角色展示信息。
 *
 * 层次语义：写入 = setConfigValue 整键替换「写入目标作用域」的 modelRoutes。
 * 草稿基准 = 写入目标作用域当前值（非合并生效值），未触碰的其他层角色不会被复制进写入值，
 * 生效值继续从原有层继承（与 #05「恢复继承 = 删除覆盖，不复制全局值」的层次哲学一致）。
 */

/** settings.modelRoutes 键名（与 coding-agent MODEL_ROUTES_KEY 同源；web-app 不依赖 coding-agent，本地镜像）。 */
export const MODEL_ROUTES_KEY = "modelRoutes";

/** 编辑器保存载荷（页面层据此调用 setConfigValue；tags 为 null = modelTags 无需写入）。 */
export interface RoleEditorSavePayload {
	scope: ConfigScope;
	routes: RoleRoutes;
	tags: RoleTags | null;
	changedCount: number;
}

/** 编辑器保存结果：ok=false 时草稿保留且不应用部分配置；ok=true 时 notice 供页面横幅展示。 */
export interface RoleSaveResult {
	ok: boolean;
	notice?: string;
	error?: string;
}

// ── 配置表示（与 coding-agent ModelRoleRoute / ModelTagDef 结构一致的 wire 形状）──

/** modelRoutes 单角色路由。primary 缺省（空串语义）时该角色仅回退链生效。 */
export interface RoleRoute {
	primary?: string;
	fallbacks: string[];
}

export type RoleRoutes = Record<string, RoleRoute>;

/** modelTags 单角色展示元数据（自定义角色的显示名 / 颜色）。 */
export interface RoleTagMeta {
	name?: string;
	color?: string;
}

export type RoleTags = Record<string, RoleTagMeta>;

// ── 内置角色（与 coding-agent MODEL_ROLES / MODEL_ROLE_IDS 同源的本地镜像）──

export const BUILTIN_ROLE_IDS = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "task"] as const;

export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

export interface BuiltinRoleMeta {
	/** 运行时 tag（英文，与 TUI 一致）。 */
	tag: string;
	/** 中文显示名。 */
	label: string;
	/** 主题色（角色色板键）。 */
	color: RoleColor;
}

export const BUILTIN_ROLE_META: Record<BuiltinRoleId, BuiltinRoleMeta> = {
	default: { tag: "DEFAULT", label: "默认", color: "success" },
	smol: { tag: "SMOL", label: "快速", color: "warning" },
	slow: { tag: "SLOW", label: "深度思考", color: "accent" },
	vision: { tag: "VISION", label: "视觉", color: "error" },
	plan: { tag: "PLAN", label: "规划", color: "muted" },
	designer: { tag: "DESIGNER", label: "设计", color: "muted" },
	commit: { tag: "COMMIT", label: "提交", color: "dim" },
	task: { tag: "TASK", label: "子任务", color: "muted" },
};

/** 自定义角色可选色板（modelTags.color 合法 ThemeColor 的展示子集）。 */
export const ROLE_COLOR_PALETTE = ["accent", "success", "warning", "error", "muted", "dim"] as const;

export type RoleColor = (typeof ROLE_COLOR_PALETTE)[number];

export function isBuiltinRole(role: string): role is BuiltinRoleId {
	return (BUILTIN_ROLE_IDS as readonly string[]).includes(role);
}

// ── 草稿状态机 ──

/** 草稿中的单角色条目。 */
export interface RoleDraftEntry {
	/** 组件内稳定标识（跨重命名 / 删除不变，React key 用）。 */
	uid: number;
	/** 当前角色 id（写入 modelRoutes 的键；重命名后变化）。 */
	id: string;
	/** 基准（写入目标作用域）中的原 id；新增角色为 null。 */
	baseId: string | null;
	/** 主模型 spec；"" = 未设置。 */
	primary: string;
	fallbacks: string[];
	/** 新增自定义角色选定的颜色（仅 isNew 条目可设置；null = 未选）。 */
	color: RoleColor | null;
	isNew: boolean;
}

export interface RoleDraft {
	entries: RoleDraftEntry[];
	nextUid: number;
}

/** 可能因用户输入失败的操作的返回：失败时原样返回可诊断错误（不修改草稿）。 */
export type DraftOpResult = { ok: true; draft: RoleDraft } | { ok: false; error: string };

/** 校验角色 id：trim 后非空、不与其他条目重名（重名拒绝）。返回错误文案或 null。 */
export function validateRoleId(draft: RoleDraft, rawId: string, excludeUid?: number): string | null {
	const id = rawId.trim();
	if (!id) return "角色名称不能为空";
	for (const e of draft.entries) {
		if (e.uid === excludeUid) continue;
		if (e.id === id) return `角色名称「${id}」已存在（重名拒绝）`;
	}
	return null;
}

/** 初始化草稿：内置角色按固定顺序全部在场（未配置的以空路由呈现），自定义角色按基准键序追加。 */
export function initRoleDraft(base: RoleRoutes): RoleDraft {
	const entries: RoleDraftEntry[] = [];
	let uid = 1;
	const push = (id: string): void => {
		const route = base[id];
		entries.push({
			uid: uid++,
			id,
			baseId: id,
			primary: route?.primary ?? "",
			fallbacks: [...(route?.fallbacks ?? [])],
			color: null,
			isNew: false,
		});
	};
	for (const id of BUILTIN_ROLE_IDS) push(id);
	for (const id of Object.keys(base)) if (!isBuiltinRole(id)) push(id);
	return { entries, nextUid: uid };
}

function cloneEntry(entry: RoleDraftEntry): RoleDraftEntry {
	return { ...entry, fallbacks: [...entry.fallbacks] };
}

function withEntry(draft: RoleDraft, uid: number, patch: (entry: RoleDraftEntry) => RoleDraftEntry): DraftOpResult {
	const idx = draft.entries.findIndex(e => e.uid === uid);
	if (idx === -1) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	const entries = [...draft.entries];
	entries[idx] = patch(entries[idx]);
	return { ok: true, draft: { ...draft, entries } };
}

/** 设置主模型 spec（空串 = 清除）。 */
export function setPrimary(draft: RoleDraft, uid: number, spec: string): DraftOpResult {
	return withEntry(draft, uid, entry => cloneEntry({ ...entry, primary: spec }));
}

/** 追加回退项（空白 spec 拒绝；重复项允许进入草稿，由校验即时标红并阻止保存）。 */
export function addFallback(draft: RoleDraft, uid: number, spec: string): DraftOpResult {
	const trimmed = spec.trim();
	if (!trimmed) return { ok: false, error: "回退模型不能为空" };
	return withEntry(draft, uid, entry => cloneEntry({ ...entry, fallbacks: [...entry.fallbacks, trimmed] }));
}

/** 删除回退项（越界为无效操作，返回错误且不修改草稿）。 */
export function removeFallback(draft: RoleDraft, uid: number, index: number): DraftOpResult {
	const entry = draft.entries.find(e => e.uid === uid);
	if (!entry) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	if (index < 0 || index >= entry.fallbacks.length) return { ok: false, error: "回退项序号越界" };
	return withEntry(draft, uid, e => {
		const fallbacks = [...e.fallbacks];
		fallbacks.splice(index, 1);
		return cloneEntry({ ...e, fallbacks });
	});
}

/** 移动回退项（拖拽与键盘 ▲▼ 共用同一操作）；越界 / 原位为无变化。 */
export function moveFallback(draft: RoleDraft, uid: number, from: number, to: number): DraftOpResult {
	return withEntry(draft, uid, entry => {
		if (from === to || from < 0 || to < 0 || from >= entry.fallbacks.length || to >= entry.fallbacks.length) {
			return cloneEntry(entry);
		}
		const fallbacks = [...entry.fallbacks];
		const [moved] = fallbacks.splice(from, 1);
		fallbacks.splice(to, 0, moved);
		return cloneEntry({ ...entry, fallbacks });
	});
}

/** 新增自定义角色（名称 + 可选颜色；重名拒绝）；seed 用于把另一层生效值一键带入写入目标。 */
export function addCustomRole(
	draft: RoleDraft,
	rawId: string,
	color: RoleColor | null,
	seed?: { primary?: string; fallbacks?: readonly string[] },
): DraftOpResult {
	const id = rawId.trim();
	const nameError = validateRoleId(draft, id);
	if (nameError) return { ok: false, error: nameError };
	const entry: RoleDraftEntry = {
		uid: draft.nextUid,
		id,
		baseId: null,
		primary: seed?.primary ?? "",
		fallbacks: [...(seed?.fallbacks ?? [])],
		color,
		isNew: true,
	};
	return { ok: true, draft: { entries: [...draft.entries, entry], nextUid: draft.nextUid + 1 } };
}

/** 以生效值预填路由（写入目标未配置该角色时，从另一层生效值一键带入后修改）。 */
export function seedRoute(
	draft: RoleDraft,
	uid: number,
	seed: { primary?: string; fallbacks?: readonly string[] },
): DraftOpResult {
	return withEntry(draft, uid, entry =>
		cloneEntry({ ...entry, primary: seed.primary ?? "", fallbacks: [...(seed.fallbacks ?? [])] }),
	);
}

/** 重命名自定义角色（内置角色拒绝；重名拒绝；改回原名等价于取消重命名）。 */
export function renameCustomRole(draft: RoleDraft, uid: number, rawId: string): DraftOpResult {
	const entry = draft.entries.find(e => e.uid === uid);
	if (!entry) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	if (isBuiltinRole(entry.id)) return { ok: false, error: "内置角色不可重命名" };
	const id = rawId.trim();
	const nameError = validateRoleId(draft, id, uid);
	if (nameError) return { ok: false, error: nameError };
	return withEntry(draft, uid, e => cloneEntry({ ...e, id }));
}

/** 复制角色为新的自定义角色（复制主模型 + 回退链；名称重名拒绝）。 */
export function duplicateRole(draft: RoleDraft, uid: number, rawId: string): DraftOpResult {
	const entry = draft.entries.find(e => e.uid === uid);
	if (!entry) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	const id = rawId.trim();
	const nameError = validateRoleId(draft, id);
	if (nameError) return { ok: false, error: nameError };
	const copy: RoleDraftEntry = {
		uid: draft.nextUid,
		id,
		baseId: null,
		primary: entry.primary,
		fallbacks: [...entry.fallbacks],
		color: null,
		isNew: true,
	};
	return { ok: true, draft: { entries: [...draft.entries, copy], nextUid: draft.nextUid + 1 } };
}

/** 删除自定义角色（内置角色拒绝）。写入后该角色从写入目标作用域移除；另一层仍有时生效值回落（diff 提示）。 */
export function deleteRole(draft: RoleDraft, uid: number): DraftOpResult {
	const entry = draft.entries.find(e => e.uid === uid);
	if (!entry) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	if (isBuiltinRole(entry.id)) return { ok: false, error: "内置角色不可删除" };
	return { ok: true, draft: { ...draft, entries: draft.entries.filter(e => e.uid !== uid) } };
}

/**
 * 恢复已保存值（按角色）：改动中的角色还原为写入目标作用域的当前值；
 * 新增角色没有已保存值，等价于移除该条目。
 */
export function resetRole(draft: RoleDraft, uid: number, base: RoleRoutes): DraftOpResult {
	const entry = draft.entries.find(e => e.uid === uid);
	if (!entry) return { ok: false, error: "角色条目不存在（可能已被删除）" };
	if (entry.isNew || entry.baseId === null) {
		return { ok: true, draft: { ...draft, entries: draft.entries.filter(e => e.uid !== uid) } };
	}
	const route = base[entry.baseId];
	return withEntry(draft, uid, e =>
		cloneEntry({
			...e,
			id: e.baseId ?? e.id,
			primary: route?.primary ?? "",
			fallbacks: [...(route?.fallbacks ?? [])],
		}),
	);
}

// ── 序列化（草稿 → modelRoutes 写入值）──

/**
 * 草稿 → modelRoutes 写入值：trim 主模型与回退项；主模型与回退链均空的角色条目丢弃
 * （等价于从写入目标作用域移除该条目，diff 中呈现为 removed）。
 */
export function serializeDraft(draft: RoleDraft): RoleRoutes {
	const out: RoleRoutes = {};
	for (const entry of draft.entries) {
		const primary = entry.primary.trim();
		const fallbacks = entry.fallbacks.map(f => f.trim()).filter(f => f.length > 0);
		if (!primary && fallbacks.length === 0) continue;
		out[entry.id] = { ...(primary ? { primary } : {}), fallbacks };
	}
	return out;
}

// ── diff 计算（逐角色逐字段 旧→新）──

export interface FallbacksDiff {
	from: string[];
	to: string[];
	added: string[];
	removed: string[];
	/** 两层共有项的相对顺序改变。 */
	reordered: boolean;
}

export interface RoleRouteDiff {
	role: string;
	kind: "added" | "removed" | "changed" | "same";
	/** 主模型变更（null = 未变）。from/to 的 null = 该层无主模型。 */
	primary: { from: string | null; to: string | null } | null;
	fallbacks: FallbacksDiff | null;
	/** removed 时：另一层仍有该角色，生效值回落的层（null = 彻底移除）。 */
	otherLayer?: "global" | "project";
}

function diffFallbacks(from: string[], to: string[]): FallbacksDiff {
	const fromCounts = new Map<string, number>();
	const toCounts = new Map<string, number>();
	for (const spec of from) fromCounts.set(spec, (fromCounts.get(spec) ?? 0) + 1);
	for (const spec of to) toCounts.set(spec, (toCounts.get(spec) ?? 0) + 1);
	const added: string[] = [];
	const removed: string[] = [];
	for (const [spec, count] of toCounts) {
		const surplus = count - (fromCounts.get(spec) ?? 0);
		for (let i = 0; i < surplus; i++) added.push(spec);
	}
	for (const [spec, count] of fromCounts) {
		const surplus = count - (toCounts.get(spec) ?? 0);
		for (let i = 0; i < surplus; i++) removed.push(spec);
	}
	// 重排判定：按多重集最小交集过滤两条列表，比较过滤后序列
	const common = new Set<string>();
	for (const [spec, count] of toCounts) if (count > 0 && fromCounts.has(spec)) common.add(spec);
	const seqFrom = from.filter(s => common.has(s));
	const seqTo = to.filter(s => common.has(s));
	const reordered = seqFrom.join("\n") !== seqTo.join("\n");
	return { from: [...from], to: [...to], added, removed, reordered };
}

/** 写入 diff 的另一层参照（removed 角色的生效值回落来源）。 */
export interface OtherLayerRef {
	scope: "global" | "project";
	routes: RoleRoutes;
}

/** 计算 modelRoutes 写入 diff（base = 写入目标作用域当前值，next = 草稿序列化值）。顺序稳定：内置在前。 */
export function computeRoutesDiff(base: RoleRoutes, next: RoleRoutes, otherLayer?: OtherLayerRef): RoleRouteDiff[] {
	const roles: string[] = [];
	const seen = new Set<string>();
	for (const id of BUILTIN_ROLE_IDS) {
		if (base[id] !== undefined || next[id] !== undefined) {
			roles.push(id);
			seen.add(id);
		}
	}
	for (const id of Object.keys(base)) {
		if (!seen.has(id) && !isBuiltinRole(id)) {
			roles.push(id);
			seen.add(id);
		}
	}
	for (const id of Object.keys(next)) {
		if (!seen.has(id) && !isBuiltinRole(id)) {
			roles.push(id);
			seen.add(id);
		}
	}

	return roles.map(role => {
		const before = base[role];
		const after = next[role];
		if (!before) {
			// 新增角色：写入内容也必须可见（写入前 diff 契约），not null——否则确认弹窗看不到将写入的主模型/回退链
			return {
				role,
				kind: "added" as const,
				primary: { from: null, to: after?.primary ?? null },
				fallbacks: after ? diffFallbacks([], after.fallbacks ?? []) : null,
			};
		}
		if (!after) {
			const survived = otherLayer !== undefined && otherLayer.routes[role] !== undefined;
			return {
				role,
				kind: "removed" as const,
				primary: null,
				fallbacks: null,
				...(survived && otherLayer ? { otherLayer: otherLayer.scope } : {}),
			};
		}
		const fromPrimary = before.primary ?? null;
		const toPrimary = after.primary ?? null;
		const primaryChanged = fromPrimary !== toPrimary;
		const fb = diffFallbacks(before.fallbacks ?? [], after.fallbacks ?? []);
		const fallbacksChanged = fb.added.length > 0 || fb.removed.length > 0 || fb.reordered;
		return {
			role,
			kind: primaryChanged || fallbacksChanged ? ("changed" as const) : ("same" as const),
			primary: primaryChanged ? { from: fromPrimary, to: toPrimary } : null,
			fallbacks: fallbacksChanged ? fb : null,
		};
	});
}

// ── spec 校验（保存闸门）──

/** spec 校验失败种类。 */
export type SpecIssueKind =
	| "malformed"
	| "duplicate"
	| "disabled"
	| "provider-not-configured"
	| "not-in-catalog"
	| "credential-invalid"
	| "local-offline"
	| "catalog-stale"
	| "unverifiable";

export interface SpecIssue {
	kind: SpecIssueKind;
	severity: "error" | "warning";
	message: string;
}

/** spec 校验上下文（由模型目录预构建，重复校验共享）。 */
export interface SpecCheckContext {
	/** `provider/modelId` → 目录状态；null = 目录不可用（存在性降级为 warning）。 */
	statusByKey: Map<string, ModelCatalogStatus> | null;
	disabledProviders: readonly string[];
	disabledModels: readonly string[];
}

/** 运行时可识别的思考级别后缀（与 coding-agent parseThinkingLevel 同源集合）。 */
const THINKING_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh", "inherit", "off"]);

/** 剥离 `:level` 思考级别后缀（仅当后缀为合法思考级别；其他冒号内容视为 modelId 的一部分）。 */
export function stripThinkingSuffix(modelId: string): string {
	const idx = modelId.lastIndexOf(":");
	if (idx === -1) return modelId;
	return THINKING_SUFFIXES.has(modelId.slice(idx + 1)) ? modelId.slice(0, idx) : modelId;
}

/** 解析 `provider/modelId` spec（首个 `/` 切分；无 provider 段或无 modelId 段为非法）。 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) return null;
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

/** 从 get_model_catalog 响应构建校验上下文；catalog 为 null（拉取失败）→ 存在性不可校验。 */
export function buildSpecCheckContext(catalog: ModelCatalogDto | null): SpecCheckContext {
	if (!catalog) return { statusByKey: null, disabledProviders: [], disabledModels: [] };
	const statusByKey = new Map<string, ModelCatalogStatus>();
	for (const model of catalog.models) statusByKey.set(`${model.provider}/${model.id}`, model.status);
	return {
		statusByKey,
		disabledProviders: catalog.disabledProviders,
		disabledModels: catalog.disabledModels,
	};
}

function statusToIssue(status: ModelCatalogStatus): SpecIssue | null {
	switch (status) {
		case "available":
			return null;
		case "disabled":
			return { kind: "disabled", severity: "error", message: "该模型已停用" };
		case "provider-not-configured":
			return { kind: "provider-not-configured", severity: "error", message: "Provider 未接入（无凭据）" };
		case "credential-invalid":
			return { kind: "credential-invalid", severity: "warning", message: "Provider 凭据已知失效" };
		case "local-offline":
			return { kind: "local-offline", severity: "warning", message: "本地 Provider 进程不可达" };
		case "catalog-stale":
			return { kind: "catalog-stale", severity: "warning", message: "目录非权威，无法确证该模型可用性" };
		default:
			return { kind: "catalog-stale", severity: "warning", message: "目录状态未知" };
	}
}

/**
 * 校验单个 spec：格式 → 停用名单（provider 级 / 模型级，先于目录查询）→ 目录状态。
 * 可用返回 null；error 级阻止保存，warning 级仅提示。
 */
export function checkSpec(rawSpec: string, ctx: SpecCheckContext): SpecIssue | null {
	const spec = rawSpec.trim();
	if (!spec) return { kind: "malformed", severity: "error", message: "模型 spec 不能为空" };
	const parsed = parseModelSpec(spec);
	if (!parsed) return { kind: "malformed", severity: "error", message: "格式无效（应为 provider/modelId）" };
	const key = `${parsed.provider}/${stripThinkingSuffix(parsed.modelId)}`;
	if (ctx.disabledModels.includes(key)) {
		return { kind: "disabled", severity: "error", message: "该模型在停用名单中（disabledModels）" };
	}
	if (ctx.disabledProviders.includes(parsed.provider)) {
		return { kind: "disabled", severity: "error", message: "该 Provider 已整体停用（disabledProviders）" };
	}
	if (!ctx.statusByKey) {
		return { kind: "unverifiable", severity: "warning", message: "模型目录不可用，无法校验该模型是否存在" };
	}
	const status = ctx.statusByKey.get(key);
	if (!status) return { kind: "not-in-catalog", severity: "error", message: "模型目录中不存在该模型" };
	return statusToIssue(status);
}

/** 单角色路由的问题清单（重复模型 + 逐 spec 校验）。 */
export interface RouteIssue {
	field: "primary" | "fallback";
	/** fallback 序号；field=primary 时为 -1。 */
	index: number;
	spec: string;
	kind: SpecIssueKind;
	severity: "error" | "warning";
	message: string;
}

/**
 * 校验单角色路由：重复项（与主模型或回退链其他项相同 spec，首个出现之外的每次出现）即时标红为 error；
 * 其余按 checkSpec 逐项校验。
 */
export function validateRoute(
	route: { primary?: string; fallbacks: readonly string[] },
	ctx: SpecCheckContext,
): RouteIssue[] {
	const issues: RouteIssue[] = [];
	const primary = route.primary?.trim() ?? "";
	const specs: Array<{ field: "primary" | "fallback"; index: number; spec: string }> = [];
	if (primary) specs.push({ field: "primary", index: -1, spec: primary });
	route.fallbacks.forEach((spec, index) => {
		const trimmed = spec.trim();
		if (trimmed) specs.push({ field: "fallback", index, spec: trimmed });
	});
	const firstSeen = new Map<string, { field: "primary" | "fallback"; index: number }>();
	for (const item of specs) {
		const first = firstSeen.get(item.spec);
		if (first) {
			issues.push({
				field: item.field,
				index: item.index,
				spec: item.spec,
				kind: "duplicate",
				severity: "error",
				message: `与${first.field === "primary" ? "主模型" : `回退项 #${first.index + 1}`}重复`,
			});
			continue;
		}
		firstSeen.set(item.spec, { field: item.field, index: item.index });
		const issue = checkSpec(item.spec, ctx);
		if (issue) {
			issues.push({
				field: item.field,
				index: item.index,
				spec: item.spec,
				kind: issue.kind,
				severity: issue.severity,
				message: issue.message,
			});
		}
	}
	return issues;
}

// ── 草稿整体校验（保存闸门）──

export interface DraftEntryValidation {
	uid: number;
	issues: RouteIssue[];
	/** 空主模型但有回退链：允许保存但需明示「仅回退链生效」。 */
	fallbackOnly: boolean;
	/** 新增角色未配置任何模型：阻止保存（否则保存后角色不会出现，用户无感知丢角色）。 */
	emptyNew: boolean;
	nameError: string | null;
	severity: "error" | "warning" | "ok";
}

export interface DraftValidation {
	blocked: boolean;
	perEntry: DraftEntryValidation[];
	errorCount: number;
	warningCount: number;
}

/** 校验整份草稿（保存闸门）：任一 error（重复 / 停用 / 未接入 / 目录不存在 / 格式 / 重名 / 新角色空配置）阻止保存。 */
export function validateDraft(draft: RoleDraft, ctx: SpecCheckContext): DraftValidation {
	let errorCount = 0;
	let warningCount = 0;
	const perEntry = draft.entries.map(entry => {
		const issues = validateRoute({ primary: entry.primary, fallbacks: entry.fallbacks }, ctx);
		const trimmedPrimary = entry.primary.trim();
		const trimmedFallbacks = entry.fallbacks.map(f => f.trim()).filter(f => f.length > 0);
		const fallbackOnly = !trimmedPrimary && trimmedFallbacks.length > 0;
		const emptyNew = entry.isNew && !trimmedPrimary && trimmedFallbacks.length === 0;
		const nameError = validateRoleId(draft, entry.id, entry.uid);
		let severity: DraftEntryValidation["severity"] = "ok";
		if (emptyNew || nameError) severity = "error";
		else if (issues.some(i => i.severity === "error")) severity = "error";
		else if (issues.some(i => i.severity === "warning")) severity = "warning";
		if (severity === "error") {
			errorCount += 1 + (nameError ? 1 : 0) + (emptyNew ? 1 : 0);
		} else if (severity === "warning") {
			warningCount += 1;
		}
		return { uid: entry.uid, issues, fallbackOnly, emptyNew, nameError, severity };
	});
	return { blocked: errorCount > 0, perEntry, errorCount, warningCount };
}

// ── 草稿 vs 基准（脏判定）──

function sameRoute(
	a: { primary?: string; fallbacks?: readonly string[] } | undefined,
	primary: string,
	fallbacks: readonly string[],
): boolean {
	const basePrimary = a?.primary ?? "";
	const baseFallbacks = a?.fallbacks ?? [];
	return (
		basePrimary.trim() === primary.trim() &&
		baseFallbacks.length === fallbacks.length &&
		baseFallbacks.every((f, i) => f.trim() === fallbacks[i]?.trim())
	);
}

/** 单条目是否相对基准有改动（新增角色恒为脏）。 */
export function isEntryDirty(entry: RoleDraftEntry, base: RoleRoutes): boolean {
	if (entry.isNew || entry.baseId === null) return true;
	if (entry.id !== entry.baseId) return true;
	return !sameRoute(base[entry.baseId], entry.primary, entry.fallbacks);
}

/** 草稿是否有任何改动（决定保存 / 放弃按钮与离开提示）。 */
export function isDraftDirty(draft: RoleDraft, base: RoleRoutes): boolean {
	return draft.entries.some(e => isEntryDirty(e, base));
}

// ── 草稿持久化（sessionStorage 载荷）──

export interface StoredRoleDraft {
	writeTarget: "global" | "project";
	/** 基准指纹：恢复时与当前基准比对，配置在别处被修改则草稿作废（不还原过期草稿）。 */
	baseFingerprint: string;
	entries: Array<Pick<RoleDraftEntry, "uid" | "id" | "baseId" | "primary" | "fallbacks" | "color" | "isNew">>;
	nextUid: number;
	savedAt: string;
}

/** sessionStorage 持久化键（按写入作用域分键：切换作用域互不丢草稿）。 */
export function draftStorageKey(writeTarget: "global" | "project"): string {
	return `omp.roleEditor.draft.v1.${writeTarget}`;
}

/** 基准指纹（稳定 JSON）。 */
export function draftFingerprint(base: RoleRoutes): string {
	return JSON.stringify(base);
}

/** 编码草稿为可持久化载荷。 */
export function encodeDraft(draft: RoleDraft, writeTarget: "global" | "project", base: RoleRoutes): StoredRoleDraft {
	return {
		writeTarget,
		baseFingerprint: draftFingerprint(base),
		entries: draft.entries.map(({ uid, id, baseId, primary, fallbacks, color, isNew }) => ({
			uid,
			id,
			baseId,
			primary,
			fallbacks: [...fallbacks],
			color,
			isNew,
		})),
		nextUid: draft.nextUid,
		savedAt: new Date().toISOString(),
	};
}

/**
 * 解码持久化载荷为草稿：目标作用域或基准指纹不匹配、形状非法 → null（调用方丢弃并提示，不还原过期草稿）。
 */
export function decodeDraft(raw: string, writeTarget: "global" | "project", base: RoleRoutes): RoleDraft | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const stored = parsed as Partial<StoredRoleDraft>;
	if (stored.writeTarget !== writeTarget) return null;
	if (stored.baseFingerprint !== draftFingerprint(base)) return null;
	if (!Array.isArray(stored.entries) || typeof stored.nextUid !== "number") return null;
	const entries: RoleDraftEntry[] = [];
	for (const item of stored.entries) {
		if (!item || typeof item !== "object") return null;
		const e = item as Partial<RoleDraftEntry>;
		if (typeof e.uid !== "number" || typeof e.id !== "string" || !e.id.trim()) return null;
		if (typeof e.primary !== "string" || !Array.isArray(e.fallbacks) || e.fallbacks.some(f => typeof f !== "string"))
			return null;
		if (typeof e.isNew !== "boolean") return null;
		if (e.isNew && e.baseId !== null) return null;
		if (typeof e.baseId !== "string" && e.baseId !== null) return null;
		if (e.color !== null && e.color !== undefined && !(ROLE_COLOR_PALETTE as readonly string[]).includes(e.color))
			return null;
		entries.push({
			uid: e.uid,
			id: e.id,
			baseId: e.baseId ?? null,
			primary: e.primary,
			fallbacks: [...e.fallbacks],
			color: (e.color ?? null) as RoleColor | null,
			isNew: e.isNew,
		});
	}
	return { entries, nextUid: stored.nextUid };
}

// ── modelTags 展示元数据 ──

/** 角色展示信息（内置元数据 + modelTags 覆盖，与 coding-agent getRoleInfo 的覆盖优先级一致）。 */
export interface RoleDisplayMeta {
	/** 角色键（modelRoutes / modelTags 的键）。 */
	role: string;
	/** 显示名：内置为中文标签，自定义优先 modelTags.name，否则角色 id。 */
	name: string;
	/** 运行时 tag（仅内置角色）。 */
	tag?: string;
	/** 色板键（非法 / 缺失为 null，展示层回落中性色）。 */
	color: RoleColor | null;
	builtin: boolean;
}

export function roleDisplayMeta(role: string, tags: RoleTags): RoleDisplayMeta {
	const configured = tags[role];
	const color = (c: string | undefined): RoleColor | null =>
		c && (ROLE_COLOR_PALETTE as readonly string[]).includes(c) ? (c as RoleColor) : null;
	if (isBuiltinRole(role)) {
		const meta = BUILTIN_ROLE_META[role];
		return {
			role,
			name: configured?.name?.trim() || meta.label,
			tag: meta.tag,
			color: configured?.color ? (color(configured.color) ?? meta.color) : meta.color,
			builtin: true,
		};
	}
	return { role, name: configured?.name?.trim() || role, color: color(configured?.color), builtin: false };
}

export interface RoleTagsChange {
	/** modelTags 写入值（基准 = 写入目标作用域当前值）。 */
	tags: RoleTags;
	/** 确认弹窗中的变更说明行。 */
	summary: string[];
}

/**
 * 计算 modelTags 变更（仅处理写入目标作用域基准内的自定义角色元数据）：
 * 新增角色的颜色写入、重命名移动元数据、删除角色移除元数据；无变化返回 null（不发起写入）。
 * 另一层（如全局）中的元数据不在整键替换范围内，保持原样（展示层回落角色 id）。
 */
export function computeTagsChanges(draft: RoleDraft, baseTags: RoleTags): RoleTagsChange | null {
	const next: RoleTags = { ...baseTags };
	const summary: string[] = [];
	// 存活角色 = 草稿条目的最终 id（新增 / 重命名后的 id）：删除角色的旧 id 不在集合中被移除，
	// 重命名条目的旧 id 同样被移除（其元数据已移动到新 id）。
	const survivingIds = new Set(draft.entries.map(e => e.id));

	// 新增角色颜色
	for (const entry of draft.entries) {
		if (entry.isNew && entry.color) {
			next[entry.id] = { ...next[entry.id], color: entry.color };
			summary.push(`颜色：${entry.id} → ${entry.color}`);
		}
	}
	// 重命名移动元数据
	for (const entry of draft.entries) {
		if (entry.baseId && entry.id !== entry.baseId && next[entry.baseId] !== undefined) {
			const meta = next[entry.baseId];
			delete next[entry.baseId];
			next[entry.id] = { ...meta };
			summary.push(`元数据随重命名移动：${entry.baseId} → ${entry.id}`);
		}
	}
	// 删除角色移除元数据（重命名后的旧 id / 已删角色均不在存活集合内）
	for (const id of Object.keys(baseTags)) {
		if (!isBuiltinRole(id) && !survivingIds.has(id) && next[id] !== undefined) {
			delete next[id];
			summary.push(`移除已删角色的元数据：${id}`);
		}
	}

	const before = JSON.stringify(baseTags);
	const after = JSON.stringify(next);
	if (before === after) return null;
	return { tags: next, summary };
}

// ── 角色列表视图（生效值 + 来源 + 失效状态）──

/** 容错解析 ConfigScopeDto 中的 modelRoutes 取值（用户手改 YAML 可能形状异常；与运行时读路径同等宽容）。 */
export function normalizeRoutesValue(input: unknown): RoleRoutes {
	const out: RoleRoutes = {};
	if (!input || typeof input !== "object" || Array.isArray(input)) return out;
	for (const [role, value] of Object.entries(input as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const raw = value as { primary?: unknown; fallbacks?: unknown };
		const primary = typeof raw.primary === "string" ? raw.primary.trim() : "";
		const fallbacks = Array.isArray(raw.fallbacks)
			? raw.fallbacks.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map(f => f.trim())
			: [];
		if (!primary && fallbacks.length === 0) continue;
		out[role] = primary ? { primary, fallbacks } : { fallbacks };
	}
	return out;
}

/** 容错解析 ConfigScopeDto 中的 modelTags 取值。 */
export function normalizeTagsValue(input: unknown): RoleTags {
	const out: RoleTags = {};
	if (!input || typeof input !== "object" || Array.isArray(input)) return out;
	for (const [role, value] of Object.entries(input as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const raw = value as { name?: unknown; color?: unknown };
		const meta: RoleTagMeta = {};
		if (typeof raw.name === "string" && raw.name.trim()) meta.name = raw.name.trim();
		if (typeof raw.color === "string" && raw.color.trim()) meta.color = raw.color.trim();
		if (meta.name || meta.color) out[role] = meta;
	}
	return out;
}

export type RoleProvenance = "project" | "global" | "unset";

export interface RoleListItem {
	role: string;
	/** 生效值来源：项目覆盖 / 全局 / 未设置。 */
	provenance: RoleProvenance;
	/** 生效主模型 spec（无主模型为空串）。 */
	primary: string;
	fallbackCount: number;
	/** 生效路由的失效状态（error / warning 的可诊断信息）。 */
	health: { severity: "ok" | "warning" | "error"; messages: string[] };
	/** 该角色是否存在于写入目标作用域（false = 仅另一层；在写入目标编辑将创建该层覆盖）。 */
	inTargetScope: boolean;
}

/**
 * 角色列表视图：键 = 写入目标作用域值 ∪ 合并生效值（内置角色固定在前）；
 * 失效状态按合并生效路由校验（运行时真正使用的值）。
 */
export function toRoleListItems(
	effective: RoleRoutes,
	projectValue: RoleRoutes | undefined,
	globalValue: RoleRoutes | undefined,
	targetScope: "global" | "project",
	ctx: SpecCheckContext,
): RoleListItem[] {
	const roles: string[] = [];
	const seen = new Set<string>();
	const push = (id: string): void => {
		if (!seen.has(id)) {
			seen.add(id);
			roles.push(id);
		}
	};
	for (const id of BUILTIN_ROLE_IDS) push(id);
	for (const id of Object.keys(effective)) if (!isBuiltinRole(id)) push(id);
	for (const id of Object.keys(projectValue ?? {})) if (!isBuiltinRole(id)) push(id);
	for (const id of Object.keys(globalValue ?? {})) if (!isBuiltinRole(id)) push(id);

	return roles.map(role => {
		const route = effective[role];
		const issues = route ? validateRoute(route, ctx) : [];
		const hasError = issues.some(i => i.severity === "error");
		const messages = issues.map(i => i.message);
		const provenance: RoleProvenance =
			projectValue?.[role] !== undefined ? "project" : globalValue?.[role] !== undefined ? "global" : "unset";
		const inTargetScope = (targetScope === "project" ? projectValue : globalValue)?.[role] !== undefined;
		return {
			role,
			provenance,
			primary: route?.primary ?? "",
			fallbackCount: route?.fallbacks?.length ?? 0,
			health: { severity: hasError ? "error" : issues.length > 0 ? "warning" : "ok", messages },
			inTargetScope,
		};
	});
}

// ── 保存结果文案（沿用本页横幅模式）──

export interface RoleSaveNoticeInput {
	scope: ConfigScope;
	/** 实际写入的配置文件路径（由刷新后的 ConfigScopeDto 取；缺省给哨兵路径）。 */
	scopePath?: string;
	/** 本次写入变更的角色数（diff 中 kind ≠ same 的条目数）。 */
	changedCount: number;
	/** 是否同时写入了 modelTags（角色颜色元数据）。 */
	tagsWritten: boolean;
	/** modelTags 写入失败信息（角色配置本身已生效，颜色回落默认展示）。 */
	tagsError?: string | null;
	/** 写入后刷新作用域 / 目录失败信息（写入事实不受影响）。 */
	refreshError?: string | null;
}

/** 保存成功的结果文案：实际作用域 + 文件路径 + 变更规模；部分失败（元数据 / 刷新）如实追加。 */
export function describeRoleSave(input: RoleSaveNoticeInput): string {
	const scopeText =
		input.scope === "global"
			? `全局配置（${input.scopePath ?? "<agentDir>/config.yml"}）`
			: `项目配置（${input.scopePath ?? "<cwd>/.cornfield/config.yml"}）`;
	let text = `已将 ${input.changedCount} 个角色的变更写入${scopeText}的「modelRoutes」`;
	if (input.tagsWritten && !input.tagsError) text += "，并同步更新了角色颜色元数据（modelTags）";
	if (input.tagsError) text += `；角色配置已生效，但颜色元数据（modelTags）写入失败：${input.tagsError}`;
	if (input.refreshError)
		text += `；配置已写入，但刷新作用域 / 目录失败：${input.refreshError}（生效值以重进页面为准）`;
	return text;
}
