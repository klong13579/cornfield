/**
 * 角色级模型路由（模型控制中心 #06）：每个角色的主模型与有序回退链的统一表示。
 *
 * 取代两个旧表示：
 * - `modelRoles: Record<role, string>`（仅主模型 spec）
 * - `modelFallbacks: string[]`（全局回退列表，语义上归属 default 角色）
 *
 * 迁移规则（migrateLegacyModelConfig，确定性 + 幂等）：
 * 1. 已有 `modelRoutes` 条目始终优先（部分迁移中断不会回退到旧值）；
 * 2. 旧 `modelRoles` 只填充 modelRoutes 缺失或缺 primary 的角色；
 * 3. 旧 `modelFallbacks` 并入 default 角色回退链（其链已非空时跳过）；
 * 4. 规范化：fallbacks 去重、剔除与该角色 primary 相同的条目、丢弃非字符串项；
 * 5. 只要旧键存在即报告 changed（调用方负责删除旧键并重写文件）。
 */

export interface ModelRoleRoute {
	/** 角色主模型 spec（`provider/modelId[:level]`）。缺省时该角色仅回退链生效。 */
	primary?: string;
	/** 主模型失败（401/429/5xx/网络错误）时依次重试的备用 spec，有序、去重。 */
	fallbacks: string[];
}

/** settings.modelRoutes 键名。 */
export const MODEL_ROUTES_KEY = "modelRoutes";

/** 旧 settings 键名（仅迁移读取用；schema 已删除）。 */
export const LEGACY_MODEL_ROLES_KEY = "modelRoles";
export const LEGACY_MODEL_FALLBACKS_KEY = "modelFallbacks";

/** 规范化单个路由：丢弃空白 primary、非字符串回退项，去重并剔除与 primary 相同的条目。 */
export function normalizeRoute(input: unknown): ModelRoleRoute | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const raw = input as { primary?: unknown; fallbacks?: unknown };
	const primary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : undefined;
	const fallbacks: string[] = [];
	const rawFallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks : [];
	for (const item of rawFallbacks) {
		if (typeof item !== "string") continue;
		const spec = item.trim();
		if (!spec || spec === primary || fallbacks.includes(spec)) continue;
		fallbacks.push(spec);
	}
	if (!primary && fallbacks.length === 0) return undefined;
	return { primary, fallbacks };
}

/** 规范化整个 modelRoutes 值（读路径容错：用户手改 YAML 不应让 agent 启动失败）。 */
export function normalizeModelRoutes(input: unknown): Record<string, ModelRoleRoute> {
	const out: Record<string, ModelRoleRoute> = {};
	if (!input || typeof input !== "object" || Array.isArray(input)) return out;
	for (const [role, value] of Object.entries(input as Record<string, unknown>)) {
		const route = normalizeRoute(value);
		if (route) out[role] = route;
	}
	return out;
}

/**
 * 从旧表示迁移到 modelRoutes。纯函数：不改写入参，只返回迁移结果与是否发生变化。
 * 对已迁移过的配置（无旧键）返回 changed:false 且原样规范化 routes。
 */
export function migrateLegacyModelConfig(raw: Record<string, unknown>): {
	routes: Record<string, ModelRoleRoute>;
	changed: boolean;
} {
	const routes = normalizeModelRoutes(raw[MODEL_ROUTES_KEY]);
	let changed = false;

	// 已有 modelRoutes 形状非法（非对象/数组）→ 丢弃重建
	const existing = raw[MODEL_ROUTES_KEY];
	if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
		changed = true;
	}

	// 旧 modelRoles：填充缺失角色 / 缺 primary 的角色
	const legacyRoles = raw[LEGACY_MODEL_ROLES_KEY];
	if (legacyRoles !== undefined && (!legacyRoles || typeof legacyRoles !== "object" || Array.isArray(legacyRoles))) {
		changed = true; // 非法形状，丢弃
	} else if (legacyRoles) {
		for (const [role, value] of Object.entries(legacyRoles as Record<string, unknown>)) {
			if (typeof value !== "string" || !value.trim()) {
				changed = true; // 非法条目，丢弃
				continue;
			}
			const spec = value.trim();
			const route = routes[role];
			if (!route) {
				routes[role] = { primary: spec, fallbacks: [] };
				changed = true;
			} else if (!route.primary) {
				routes[role] = { ...route, primary: spec };
				changed = true;
			}
		}
	}

	// 旧 modelFallbacks：并入 default 角色回退链（其链已非空时跳过）
	const legacyFallbacks = raw[LEGACY_MODEL_FALLBACKS_KEY];
	if (legacyFallbacks !== undefined && !Array.isArray(legacyFallbacks)) {
		changed = true; // 非法形状，丢弃
	} else if (Array.isArray(legacyFallbacks)) {
		const specs: string[] = [];
		for (const item of legacyFallbacks) {
			if (typeof item === "string") {
				const spec = item.trim();
				if (spec && !specs.includes(spec)) specs.push(spec);
			}
		}
		if (specs.length > 0 && (routes.default?.fallbacks.length ?? 0) === 0) {
			const primary = routes.default?.primary;
			routes.default = { primary, fallbacks: specs.filter(spec => spec !== primary) };
			changed = true;
		}
	}

	// 旧键存在本身即要求重写（调用方删除旧键）
	if (LEGACY_MODEL_ROLES_KEY in raw || LEGACY_MODEL_FALLBACKS_KEY in raw) changed = true;

	return { routes, changed };
}
