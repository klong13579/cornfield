import { Emitter } from "@opensumi/ide-core-common";
import {
	type FileChangeEvent,
	type FileStat,
	FileSystemError,
	type FileSystemProvider,
	type FileSystemProviderCapabilities,
	FileType,
} from "@opensumi/ide-file-service/lib/common";
import type { Uri } from "@opensumi/ide-utils";
import type { WireClient } from "../wire/client";
import type { FsEntryDto } from "../wire/types";

// FileSystemProviderCapabilities 是 ambient const enum，verbatimModuleSyntax 下不能作为
// 值跨模块访问（TS2748）—— 用数值字面量内联（与 core-common/types/file 定义一致）。
const FS_CAP_READ_WRITE = 2;
const FS_CAP_PATH_CASE_SENSITIVE = 1024;
const FS_CAP_READONLY = 2048;
/** omp agent workspace 的 scheme（只读预览，授权后可编辑）。 */
export const OMP_AGENT_SCHEME = "omp-agent";

/**
 * 解析 `omp-agent://<agentId>/<path>` → { agentId, path }。
 * path 相对 agentDir，根目录为空字符串。缺省 agentId 回落到 default。
 */
export function parseOmpAgentUri(uri: Uri): { agentId: string; path: string } {
	const agentId = uri.authority || "default";
	const path = uri.path.replace(/^\/+/, "");
	return { agentId, path };
}

/** 拼一个子条目的完整 omp-agent:// URI 字符串（FileStat 的 uri 字段用）。 */
function joinAgentUri(parent: Uri, name: string): string {
	const base = parent.toString().replace(/\/+$/, "");
	return `${base}/${name}`;
}

/** FsEntryDto.type 映射到 OpenSumi FileType。 */
function toFileType(entry: FsEntryDto): FileType {
	return entry.type === "dir" ? FileType.Directory : FileType.File;
}

/**
 * OmpAgentFileSystemProvider —— 把 agent workspace 以只读预览挂到 OpenSumi 文件树。
 *
 * 数据面走 wire fs_list / fs_read / fs_write（路径 sandbox 由 serve 的 resolveFsPath 保证）。
 * 未授权 = 只读（writeFile 抛 NoPermissions）；授权后 FileReadWrite 能力 + 可写。
 * 大文件：fs_read 返回 truncated 标记时抛 FileTooLarge —— 不静默截断（serve 层 128KB
 * 上限属 coding-agent wire-server 职责，editor-extension 侧只诚实上报）。
 */
export class OmpAgentFileSystemProvider implements FileSystemProvider {
	readonly #wire: WireClient;
	#authorized = false;
	#watcherSeq = 0;
	readonly #onDidChangeFileEmitter = new Emitter<FileChangeEvent>();
	readonly #onDidChangeCapabilitiesEmitter = new Emitter<void>();

	constructor(wire: WireClient) {
		this.#wire = wire;
	}

	get capabilities(): FileSystemProviderCapabilities {
		return ((this.#authorized ? FS_CAP_READ_WRITE : FS_CAP_READONLY) |
			FS_CAP_PATH_CASE_SENSITIVE) as FileSystemProviderCapabilities;
	}

	get readonly(): boolean {
		return !this.#authorized;
	}

	get authorized(): boolean {
		return this.#authorized;
	}

	/** 切换授权（授权 UI —— 票 09 审批卡 —— 决策后调用）。 */
	setAuthorized(authorized: boolean): void {
		if (this.#authorized === authorized) return;
		this.#authorized = authorized;
		this.#onDidChangeCapabilitiesEmitter.fire();
	}

	readonly onDidChangeCapabilities = this.#onDidChangeCapabilitiesEmitter.event;

	readonly onDidChangeFile = this.#onDidChangeFileEmitter.event;

	watch(): number {
		// 无实时 watcher：serve 端没有 fs 事件推送，返回递增 id 作为占位。
		return ++this.#watcherSeq;
	}

	unwatch(): void {
		// no-op
	}

	async stat(uri: Uri) {
		const { agentId, path } = parseOmpAgentUri(uri);
		if (path === "") {
			const { entries } = await this.#wire.fsList(agentId, undefined);
			return this.#toDirStat(uri, entries);
		}
		const base = path.split("/").pop() ?? "";
		const parent = path.slice(0, Math.max(0, path.length - base.length - 1));
		const { entries } = await this.#wire.fsList(agentId, parent === "" ? undefined : parent);
		const entry = entries.find(e => e.name === base);
		if (!entry) {
			throw FileSystemError.FileNotFound(uri.toString(), `no such entry in agent workspace: ${path}`);
		}
		return this.#toStat(uri.toString(), entry);
	}

	async readDirectory(uri: Uri): Promise<[string, FileType][]> {
		const { agentId, path } = parseOmpAgentUri(uri);
		const { entries } = await this.#wire.fsList(agentId, path === "" ? undefined : path);
		return entries.map(e => [e.name, toFileType(e)]);
	}

	async readFile(uri: Uri) {
		const { agentId, path } = parseOmpAgentUri(uri);
		const { text, truncated } = await this.#wire.fsRead(agentId, path);
		if (truncated) {
			throw FileSystemError.FileTooLarge(uri.toString(), "file exceeds 128KB wire read limit");
		}
		return new TextEncoder().encode(text);
	}

	async writeFile(uri: Uri, content: Uint8Array) {
		if (!this.#authorized) {
			throw FileSystemError.FileIsNoPermissions(uri.toString(), "agent workspace is read-only; authorize first");
		}
		const { agentId, path } = parseOmpAgentUri(uri);
		await this.#wire.fsWrite(agentId, path, new TextDecoder().decode(content));
	}

	createDirectory(uri: Uri) {
		throw FileSystemError.FileIsNoPermissions(uri.toString(), "creating directories over wire is not supported");
	}

	delete(uri: Uri): Promise<void> {
		throw FileSystemError.FileIsNoPermissions(uri.toString(), "deleting files over wire is not supported");
	}

	rename() {
		throw FileSystemError.FileIsNoPermissions("omp-agent", "renaming files over wire is not supported");
	}

	#toStat(uri: string, entry: FsEntryDto): FileStat {
		return {
			uri,
			lastModification: Date.now(),
			isDirectory: entry.type === "dir",
			size: entry.size,
			readonly: !this.#authorized,
		};
	}

	#toDirStat(uri: Uri, entries: FsEntryDto[]): FileStat {
		return {
			uri: uri.toString(),
			lastModification: Date.now(),
			isDirectory: true,
			readonly: !this.#authorized,
			children: entries.map(e => this.#toStat(joinAgentUri(uri, e.name), e)),
		};
	}
}
