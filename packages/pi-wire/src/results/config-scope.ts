/**
 * 配置作用域结果形状（模型控制中心 #05：作用域读取 / 按作用域写入 / 恢复继承 / 模型选择读写）。
 * 作用域语义同 coding-agent Settings：global = <agentDir>/config.yml，project =
 * <cwd>/.cornfield/config.yml，项目覆盖按 Settings#deepMerge 合并于全局之上。
 * 恢复继承 = 删除项目覆盖（而非把全局值复制进项目文件）。
 */

/** 单个可覆盖键的三层取值（project > global > schema 默认）。 */
export interface ConfigScopeKeyDto {
	/** settings 键（如 "modelRoutes"、"defaultThinkingLevel"）。 */
	key: string;
	/** 项目配置已覆盖该键。 */
	overridden: boolean;
	/** 项目值（.cornfield/config.yml；未覆盖省略）。 */
	projectValue?: unknown;
	/** 全局值（agentDir/config.yml；未设置省略）。 */
	globalValue?: unknown;
	/** 生效值（global+project 合并视图；两层都未设置 = schema 默认）。 */
	effectiveValue: unknown;
}

/** get_config_scope 响应（作用域读取）。 */
export interface ConfigScopeDto {
	/** 项目级 .cornfield/config.yml 是否存在（Settings#hasProjectConfigFile 同源）。 */
	hasProjectConfig: boolean;
	/** 项目配置文件路径（文件存在时返回）。 */
	projectConfigPath?: string;
	/** 全局配置文件路径（<agentDir>/config.yml）。 */
	globalConfigPath: string;
	/** 可覆盖键逐键三层取值。 */
	keys: ConfigScopeKeyDto[];
}

/**
 * restore_config_inheritance 响应：删除该键的项目覆盖后，生效值回落全局值或 schema 默认。
 * removed=false 表示项目文件本来就没有该覆盖（幂等）。
 */
export interface ConfigInheritanceRestoreDto {
	/** 被恢复继承的 settings 键。 */
	key: string;
	/** 项目文件中原有覆盖且已删除。 */
	removed: boolean;
	/** 删除后的生效值。 */
	effectiveValue: unknown;
}

/**
 * 模型选择两层视图（#05：会话临时模型与持久化默认模型的读侧区分）。
 * 写侧本就分开——set_model 持久化（settings.modelRoles.default）、set_model_temporary 仅本会话；
 * 读侧由 session.source 标记区分，persistedDefault 独立给出持久化层取值。
 */
export interface ModelSelectionDto {
	/** 当前会话生效模型。 */
	session: {
		provider: string;
		modelId: string;
		/** 来源：temporary = 仅本会话（set_model_temporary 设置）；persistent = 与持久化默认一致；registry-default = 无持久化值时按注册表默认解析。 */
		source: "temporary" | "persistent" | "registry-default";
	};
	/** 持久化默认模型（settings.modelRoles.default 按 `provider/modelId` 解析；从未持久化过为 null）。 */
	persistedDefault: { provider: string; modelId: string } | null;
}
