/**
 * `get_memory` 结果形状（W3 D3；T10B 改为按真实 scope 分区）。
 *
 * 一个概念一种表示：serve 端 `server/memory-scope.ts` 的投影**就是**这些类型（它从本文件引入），
 * web-app 也从 `@cornfield/wire` 引入，两端不再各写一遍。
 *
 * 三条不能混的语义，形状上必须分开：
 *   读不到 ≠ 没内容      每个 zone 带 `error`（旧实现把读失败吞成 null，页面显示成「未生成」）
 *   没沉淀 ≠ 空记忆      `MemorySessionZoneDto.pending`
 *   不适用 ≠ 没有        zone 为 null 时由 `resolution.notes` 说明原因
 */

/** 记忆分区范围：用户 / Agent / Project / Session / 全局库。 */
export type MemoryScope = "user" | "agent" | "project" | "session" | "global";

/** 文本文件投影（>128KB 截断并标记 truncated）。 */
export interface MemoryTextFileDto {
	path: string;
	content: string;
	truncated: boolean;
	/** mtime（毫秒，整数）；读到内容但 stat 失败时缺省（内容有效，只是没有时间）。 */
	updatedAt?: number;
}

/** 一个 scope 的记忆目录投影（MEMORY.md / memory_summary.md / raw_memories.md）。 */
export interface MemoryFileZoneDto {
	scope: MemoryScope;
	/** 采用的根；空态为 null。 */
	memoryRoot: string | null;
	/** 采用的根是哪条解析规则给的（`declared` / `canonical` / `legacy`）。 */
	rootKind?: string;
	/** 按优先级搜过的候选根 —— 空态时告诉用户「去哪儿找」，而不是只说「没有」。 */
	searchedRoots: string[];
	memoryMd: MemoryTextFileDto | null;
	summaryMd: MemoryTextFileDto | null;
	rawMd: MemoryTextFileDto | null;
	/** 本区任一文件读取失败的原因（读失败与「文件不存在」是两件事）。 */
	error?: string;
	/** 本区在当前上下文不适用/不可计算的原因。 */
	unavailableReason?: string;
}

/** 会话记忆：本会话在记忆管线里的 stage-1 输出（按会话文件取）。 */
export interface MemorySessionZoneDto {
	scope: "session";
	/** 会话 JSONL 文件（threads.rollout_path 的匹配键）。 */
	rolloutPath: string;
	threadId?: string;
	/** stage-1 原始记忆；尚无输出 = 空串。 */
	rawMemory?: string;
	/** stage-1 会话摘要；尚无输出 = 空串。 */
	summary?: string;
	/** stage-1 生成时间（秒）。 */
	generatedAt?: number;
	/** 该输出对应的会话文件更新时间（秒）。 */
	sourceUpdatedAt?: number;
	/** 记忆管线还没处理过这个会话（不是错误）。 */
	pending: boolean;
	error?: string;
}

/** 记忆条目（vector_embeddings 行）。 */
export interface MemoryEntryDto {
	id: string;
	content: string;
	importance: number;
	lastAccessedAt: number;
}

/** 记忆分区（namespace 分组，importance 降序）。 */
export interface MemorySectionDto {
	namespace: string;
	entries: MemoryEntryDto[];
}

/** 全局记忆库（self-evolution vector_embeddings，跨 Project）。 */
export interface MemoryStoreDto {
	scope: MemoryScope;
	dbPath: string;
	sections: MemorySectionDto[];
	totalEntries: number;
	/** 库读失败的原因（读失败不能降级成空列表）。 */
	error?: string;
}

/** 投影锚点：这份记忆是「谁的、按哪个会话根算的」。 */
export interface MemoryResolutionDto {
	agentId: string;
	agentDir: string;
	sessionCwd: string;
	projectRoot: string | null;
	sessionFile: string | null;
	/** 是否已 attach（false 时 sessionCwd/sessionFile 是按 agentDir 推算的，不是会话事实）。 */
	attached: boolean;
	storeScope: "global" | "project";
	/** 人读说明：某个 zone 为什么不可计算 / 为什么读不出来。 */
	notes: string[];
}

/** `get_memory` 响应（按 scope 分区）。 */
export interface MemoryProjectionDto {
	/** `~/.cornfield/user.md`（身份画像，跨 Project）。 */
	user: MemoryTextFileDto | null;
	/** user.md 读取失败的原因（读不到 ≠ 没建过）。 */
	userError?: string;
	/** Agent 自己的记忆 home。 */
	agent: MemoryFileZoneDto | null;
	/** 会话所在 Project 的记忆投影。 */
	project: MemoryFileZoneDto | null;
	/** 本会话的 stage-1 记忆。 */
	session: MemorySessionZoneDto | null;
	/** 全局记忆库。 */
	memoryStore: MemoryStoreDto;
	/** 锚点。 */
	resolution: MemoryResolutionDto;
}
