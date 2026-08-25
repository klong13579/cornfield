import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { PiClientListener } from "@oh-my-pi/pi-client";
import { PiClient } from "@oh-my-pi/pi-client";
import type { WireCommand, WireServerEvent } from "@oh-my-pi/pi-wire";
import type {
	DomainReportResult,
	FsDiffResult,
	FsEditResult,
	FsListResult,
	FsReadResult,
	FsWriteResult,
	GetConfigResult,
	GetSessionMessagesResult,
	GetSkillsResult,
	GitBranchesResult,
	GitCommitResult,
	GitDiffResult,
	GitLogResult,
	GitShowResult,
	GitStatusResult,
	ListAgentsResult,
	ListDomainsResult,
	ListSessionsResult,
	MemoryProjectionDto,
	SetConfigResult,
} from "./types";

/** wire 连接地址的 localStorage 覆盖键（对齐 web-app 的 ServeConnectionConfig 语义）。 */
export const WIRE_URL_STORAGE_KEY = "omp.wire.url";
/** omp serve 默认监听端口（与 desktop sidecar 一致）。 */
const DEFAULT_WIRE_PORT = 7891;

function defaultWireUrl(): string {
	const proto = window.location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${window.location.hostname}:${DEFAULT_WIRE_PORT}/ws`;
}

function loadWireUrl(): string {
	try {
		const stored = window.localStorage.getItem(WIRE_URL_STORAGE_KEY);
		if (stored) return stored;
	} catch {
		// localStorage 不可用时回默认
	}
	return defaultWireUrl();
}

/**
 * WireClient —— editor-extension 浏览器侧连 `omp serve` 的唯一入口。
 *
 * 与 web-app 的 PiClientAdapter 同源，但刻意不做业务命令包装：只透传
 * PiClient 的 request/subscribe，各票（文件/设置/diff/审批/agent/git）
 * 自行拼 WireCommand。连接建立是 fire-and-forget（autoReconnect），
 * 断线时在途请求由 pi-client fail-fast（PiDisconnectedError），UI 层按需处理。
 */
export class WireClient {
	readonly #client: PiClient;
	readonly #pushListeners = new Set<(event: WireServerEvent) => void>();

	constructor(url: string = loadWireUrl(), token = "") {
		this.#client = new PiClient({ url, token, autoReconnect: true });
		this.#client.subscribe(this.#handleClientEvent);
	}

	/** 触发连接（幂等，失败不 reject —— 交给 request 层的错误处理）。 */
	ensureConnected(): void {
		void this.#client.connect().catch(() => {
			// 首连失败交给后续 request 的 PiDisconnectedError 暴露
		});
	}

	/** 泛型命令请求，直接透传 WireCommand。 */
	request<TResult>(command: WireCommand): Promise<TResult> {
		return this.#client.request<TResult>(command);
	}

	/** 订阅服务端 push 帧（permission_request / session_snapshot / …），返回退订函数。 */
	onPush(listener: (event: WireServerEvent) => void): () => void {
		this.#pushListeners.add(listener);
		return () => this.#pushListeners.delete(listener);
	}

	get connected(): boolean {
		return this.#client.status === "open";
	}

	#handleClientEvent: PiClientListener = event => {
		if (event.type === "push") {
			for (const listener of this.#pushListeners) {
				try {
					listener(event.event);
				} catch {
					// 一个监听器崩不能拖垮其它
				}
			}
		}
	};

	// ── 文件通路（票 06 / 08）──
	fsList(sessionId: string | undefined, path?: string): Promise<FsListResult> {
		return this.request<FsListResult>({ type: "fs_list", sessionId, path });
	}

	fsRead(sessionId: string | undefined, path: string): Promise<FsReadResult> {
		return this.request<FsReadResult>({ type: "fs_read", sessionId, path });
	}

	fsWrite(sessionId: string | undefined, path: string, content: string): Promise<FsWriteResult> {
		return this.request<FsWriteResult>({ type: "fs_write", sessionId, path, content });
	}

	fsDiff(payload: { path: string; content: string } | { before: string; after: string }): Promise<FsDiffResult> {
		return this.request<FsDiffResult>({ type: "fs_diff", ...payload });
	}

	fsEdit(
		sessionId: string | undefined,
		path: string,
		edits: { old_text: string; new_text: string; all?: boolean }[],
	): Promise<FsEditResult> {
		return this.request<FsEditResult>({ type: "fs_edit", sessionId, path, mode: "replace", edits });
	}

	// ── git（票 11）──
	gitStatus(sessionId: string | undefined): Promise<GitStatusResult> {
		return this.request<GitStatusResult>({ type: "git_status", sessionId });
	}

	gitDiff(sessionId: string | undefined, cached = false): Promise<GitDiffResult> {
		return this.request<GitDiffResult>({ type: "git_diff", sessionId, cached });
	}

	gitLog(sessionId: string | undefined, count = 20): Promise<GitLogResult> {
		return this.request<GitLogResult>({ type: "git_log", sessionId, count });
	}

	gitShow(sessionId: string | undefined, revision: string): Promise<GitShowResult> {
		return this.request<GitShowResult>({ type: "git_show", sessionId, revision });
	}

	gitBranches(sessionId: string | undefined): Promise<GitBranchesResult> {
		return this.request<GitBranchesResult>({ type: "git_branches", sessionId });
	}

	/** git_commit（票 11 补）：提交工作区改动。paths 缺省 = 全部（git add -A）。 */
	gitCommit(message: string, sessionId?: string, paths?: string[]): Promise<GitCommitResult> {
		return this.request<GitCommitResult>({ type: "git_commit", sessionId, message, paths });
	}

	// ── 配置（票 07）──
	getConfig(key?: string): Promise<GetConfigResult> {
		return this.request<GetConfigResult>({ type: "get_config", key });
	}

	setConfig(key: string, value: unknown): Promise<SetConfigResult> {
		return this.request<SetConfigResult>({ type: "set_config", key, value });
	}

	/** 设置面板改模型：即时作用于 session（同时上层仍需 set_config 持久化默认值）。 */
	setModel(provider: string, modelId: string): Promise<void> {
		return this.request<void>({ type: "set_model", provider, modelId });
	}

	/** 设置面板改 thinking：即时作用于 session（同上，持久化走 set_config）。 */
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.request<void>({ type: "set_thinking_level", level });
	}

	// ── 审批（票 09）──
	permissionRespond(requestId: string, choice: string): Promise<void> {
		return this.request<void>({ type: "permission_respond", requestId, choice });
	}

	// ── 我的 agent（票 10）──
	listAgents(): Promise<ListAgentsResult> {
		return this.request<ListAgentsResult>({ type: "list_agents" });
	}

	// ── 域（B1）──
	listDomains(): Promise<ListDomainsResult> {
		return this.request<ListDomainsResult>({ type: "list_domains" });
	}

	// ── 域战报（B2，CEO 工作台）──
	domainReport(domainId: string): Promise<DomainReportResult> {
		return this.request<DomainReportResult>({ type: "domain_report", domainId });
	}

	getMemory(): Promise<MemoryProjectionDto> {
		return this.request<MemoryProjectionDto>({ type: "get_memory" });
	}

	getSkills(sessionId?: string): Promise<GetSkillsResult> {
		return this.request<GetSkillsResult>({ type: "get_skills", sessionId });
	}

	listSessions(sessionId?: string, limit?: number): Promise<ListSessionsResult> {
		return this.request<ListSessionsResult>({ type: "list_sessions", sessionId, limit });
	}

	// ── 追溯台（B4，User Story 23）──
	getSessionMessages(sessionFile: string): Promise<GetSessionMessagesResult> {
		return this.request<GetSessionMessagesResult>({ type: "get_session_messages", sessionFile });
	}
}

let sharedClient: WireClient | undefined;

/** 浏览器全局单例（各 contribution 共用同一条 WS 连接）。 */
export function getWireClient(): WireClient {
	if (!sharedClient) {
		sharedClient = new WireClient();
	}
	return sharedClient;
}
