/**
 * get_memory 结果形状（W3 D3）—— 三分区：memory（记忆库）/ user（user.md）/ project（项目 MEMORY 文件）。
 */

/** 文本文件投影（>128KB 截断并标记 truncated）。 */
export interface MemoryTextFileDto {
	path: string;
	content: string;
	truncated: boolean;
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

/** get_memory 响应。 */
export interface MemoryProjectionDto {
	user: MemoryTextFileDto | null;
	project: {
		memoryRoot: string;
		memoryMd: MemoryTextFileDto | null;
		summaryMd: MemoryTextFileDto | null;
		rawMd: MemoryTextFileDto | null;
	} | null;
	memoryStore: {
		dbPath: string;
		sections: MemorySectionDto[];
		totalEntries: number;
	};
}
