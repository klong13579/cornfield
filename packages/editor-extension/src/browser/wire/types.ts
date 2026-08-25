import type {
	DisabledSkillDto,
	MemoryProjectionDto,
	PermissionRequestPush,
	SessionListEntry,
	SkillDto,
	WireServerEvent,
	WireSessionIndexEntry,
} from "@oh-my-pi/pi-wire";

/**
 * wire 命令返回形状（前端 DTO）。
 *
 * 对齐 coding-agent wire-server 的 done() 载荷；类型只在本包内消费，
 * 不新增到 pi-wire（这些是 serve 实现细节，不是协议 schema 的正式成员）。
 */

/** fs_list 目录项（agent workspace，与 web-app FsEntryDto 同构）。 */
export interface FsEntryDto {
	name: string;
	type: "dir" | "file";
	size: number;
}

/** fs_list 响应。 */
export interface FsListResult {
	path: string;
	entries: FsEntryDto[];
}

/** fs_read 响应（>128KB serve 侧截断并标记 truncated）。 */
export interface FsReadResult {
	path: string;
	text: string;
	truncated: boolean;
}

/** fs_write 响应。 */
export interface FsWriteResult {
	path: string;
	bytesWritten: number;
}

/** fs_edit 响应。 */
export interface FsEditResult {
	path: string;
	mode: string;
	diff: string;
	firstChangedLine?: number;
}

/** fs_diff 响应 —— serve 直接返回 unified diff 字符串（非对象）。 */
export type FsDiffResult = string;

/** git_status 响应。 */
export interface GitStatusResult {
	branch: string;
	staged: string[];
	unstaged: string[];
	untracked: string[];
}

/** git_diff 响应。 */
export interface GitDiffResult {
	diff: string;
}

/** git_log 响应单条 commit。 */
export interface GitLogEntry {
	hash: string;
	author: string;
	message: string;
}

/** git_log 响应。 */
export interface GitLogResult {
	commits: GitLogEntry[];
}

/** git_show 响应。 */
export interface GitShowResult {
	revision: string;
	detail: string;
}

/** git_branches 响应。 */
export interface GitBranchesResult {
	current: string;
	local: string[];
	remote: string[];
}

/** get_config 响应。 */
export interface GetConfigResult {
	config: unknown;
}

/** set_config 响应。 */
export interface SetConfigResult {
	ok: true;
	key: string;
	value: unknown;
}

/** list_agents 响应。 */
export interface ListAgentsResult {
	agents: SessionListEntry[];
}

/** list_sessions 响应。 */
export interface ListSessionsResult {
	sessions: WireSessionIndexEntry[];
}

/** get_skills 响应。 */
export interface GetSkillsResult {
	skills: SkillDto[];
	disabled: DisabledSkillDto[];
}

export type {
	DisabledSkillDto,
	MemoryProjectionDto,
	PermissionRequestPush,
	SessionListEntry,
	SkillDto,
	WireServerEvent,
	WireSessionIndexEntry,
};
