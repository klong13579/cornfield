import type { ModelCatalogEntryDto } from "@cornfield/wire";

/**
 * 模型候选的共享纯函数（运行配置页 #05 UX 改进）：available 过滤 + 查询过滤 +
 * provider 分组。「模型选择」select（optgroup）与角色编辑器 combobox（分组浮层）
 * 共用同一份分组表示，避免两处各写一套。
 */

/** 仅保留可用模型（available；其余状态在目录页可见可诊断）。 */
export function availableModels(models: ModelCatalogEntryDto[]): ModelCatalogEntryDto[] {
	return models.filter(m => m.status === "available");
}

/** 子串过滤（provider / modelId / 显示名，大小写不敏感；空查询返回原列表）。 */
export function filterModels(models: ModelCatalogEntryDto[], query: string): ModelCatalogEntryDto[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return models;
	}
	return models.filter(
		m => m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
	);
}

export interface ModelProviderGroup {
	provider: string;
	models: ModelCatalogEntryDto[];
}

/** 按 provider 分组（组名字母序，组内保持原顺序）。 */
export function groupModelsByProvider(models: ModelCatalogEntryDto[]): ModelProviderGroup[] {
	const by = new Map<string, ModelCatalogEntryDto[]>();
	for (const m of models) {
		const list = by.get(m.provider);
		if (list) {
			list.push(m);
		} else {
			by.set(m.provider, [m]);
		}
	}
	return [...by.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, list]) => ({ provider, models: list }));
}
