import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionListEntry } from "@oh-my-pi/pi-wire";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { SessionSnapshot } from "../session/session-snapshot";
import { SessionStore } from "../session/session-store";
import { listRegistered } from "../skeleton/registry";
import { loadWorkspace } from "../skeleton/workspace";

/**
 * 多 Agent 会话注册表（P3）。
 *
 * 职责：把「注册表里的 agentDir 元数据」与「进程内活跃的 AgentSession」分开管理。
 *
 * - 元数据层：`~/.omp/agent/registry.json` 只读加载（绝不做写操作），加上 serve 自带的
 *   default agent（P1 兼容：cwd 进程的那个会话）。列表展示（server_snapshot / list_agents）
 *   只依赖这层，零成本。
 * - 会话层：lazy attach —— 收到 attach/switch_session 或命令定向到某 agent 时才调
 *   sessionFactory 实例化 AgentSession + SessionStore。idle = 只有元数据，active = 已 attach。
 *
 * 事件路由：每个 attached session 的 SessionStore 事件重新发为带 sessionId 的
 * RegistryEvent，上层（wire-server）按连接的 active 路由，不再全局广播。
 */

export interface AgentMeta {
	/** 注册名（registry key），如 "default" / "hr" / "ops"。 */
	id: string;
	/** 显示名：workspace.json name > registry displayName > id。 */
	name: string;
	/** agentDir 绝对路径。 */
	agentDir: string;
	/** 技能数（skillsDir 扫描，best-effort，失败为 undefined）。 */
	skillCount?: number;
}

export interface AttachedSession {
	meta: AgentMeta;
	session: AgentSession;
	store: SessionStore;
	unsubscribeStore: () => void;
}

/** attach 时由上层（serve.ts）提供：如何为这个 agentDir 建一个 AgentSession。 */
export type SessionFactory = (meta: AgentMeta) => Promise<AgentSession>;

export type RegistryEvent =
	| { kind: "attached"; sessionId: string }
	| { kind: "detached"; sessionId: string }
	| { kind: "snapshot"; sessionId: string; snapshot: SessionSnapshot; event: AgentSessionEvent };

/** 从磁盘读全部 agent 元数据（registry.json + 各 agentDir 的 workspace.json）。不写任何文件。 */
export async function loadAgentMetas(): Promise<AgentMeta[]> {
	const registered = await listRegistered();
	const metas: AgentMeta[] = [];
	for (const { name, entry } of registered) {
		const workspace = await loadWorkspace(entry.path).catch(() => null);
		metas.push({
			id: name,
			name: workspace?.name ?? entry.displayName ?? name,
			agentDir: entry.path,
			skillCount: await countSkills(entry.path, workspace?.skillsDir),
		});
	}
	return metas;
}

async function countSkills(agentDir: string, skillsDir: string | undefined): Promise<number | undefined> {
	const dir = path.join(agentDir, skillsDir ?? ".omp/skills");
	try {
		const entries = await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan({ cwd: dir, onlyFiles: true }));
		return entries.length;
	} catch {
		return undefined;
	}
}

export class SessionRegistry {
	readonly #factory: SessionFactory;
	readonly #metas = new Map<string, AgentMeta>();
	readonly #attached = new Map<string, AttachedSession>();
	readonly #listeners = new Set<(event: RegistryEvent) => void>();
	/** attach 进行中的去重（并发 attach 同一 id 只建一次）。 */
	readonly #attaching = new Map<string, Promise<AttachedSession>>();

	constructor(factory: SessionFactory) {
		this.#factory = factory;
	}

	/** 注册元数据（serve 启动时灌入 default + registry.json 全量）。幂等。 */
	registerMeta(meta: AgentMeta): void {
		this.#metas.set(meta.id, meta);
	}

	/** 全部 agent 元数据（含未 attach）。 */
	listMetas(): AgentMeta[] {
		return [...this.#metas.values()];
	}

	getMeta(id: string): AgentMeta | undefined {
		return this.#metas.get(id);
	}

	isAttached(id: string): boolean {
		return this.#attached.has(id);
	}

	getAttached(id: string): AttachedSession | undefined {
		return this.#attached.get(id);
	}

	listAttached(): AttachedSession[] {
		return [...this.#attached.values()];
	}

	/**
	 * 注入一个已存在的 session（serve 启动时自建的 default 用）。
	 * 与 attach 不同：不调 factory，直接接管事件订阅。
	 */
	attachExisting(id: string, entry: Omit<AttachedSession, "unsubscribeStore">): void {
		this.#metas.set(id, entry.meta);
		const unsubscribeStore = entry.store.subscribe((snapshot, event) => {
			this.#emit({ kind: "snapshot", sessionId: id, snapshot, event });
		});
		this.#attached.set(id, { ...entry, unsubscribeStore });
		this.#emit({ kind: "attached", sessionId: id });
	}

	/**
	 * Lazy attach：实例化 agent 的 AgentSession（幂等，并发安全）。
	 * 未注册的 id 抛错（上层转 ok:false）。
	 */
	async attach(id: string): Promise<AttachedSession> {
		const existing = this.#attached.get(id);
		if (existing) return existing;
		const inflight = this.#attaching.get(id);
		if (inflight) return inflight;

		const meta = this.#metas.get(id);
		if (!meta) {
			throw new Error(`unknown agent: ${id}`);
		}

		const promise = (async () => {
			const session = await this.#factory(meta);
			const store = SessionStore.attach(session);
			const entry: AttachedSession = {
				meta,
				session,
				store,
				unsubscribeStore: () => {},
			};
			entry.unsubscribeStore = store.subscribe((snapshot, event) => {
				this.#emit({ kind: "snapshot", sessionId: id, snapshot, event });
			});
			this.#attached.set(id, entry);
			logger.info("serve:agent-attached", {
				agentId: id,
				agentDir: meta.agentDir,
				sessionId: session.sessionId,
			});
			this.#emit({ kind: "attached", sessionId: id });
			return entry;
		})();

		this.#attaching.set(id, promise);
		try {
			return await promise;
		} finally {
			this.#attaching.delete(id);
		}
	}

	/** 释放一个 attached agent（dispose session）。未 attach 时 no-op。 */
	async detach(id: string): Promise<void> {
		const entry = this.#attached.get(id);
		if (!entry) return;
		this.#attached.delete(id);
		entry.unsubscribeStore();
		entry.store.dispose();
		try {
			await entry.session.dispose();
		} catch (err) {
			logger.warn("serve:agent-detach-dispose-failed", { agentId: id, error: String(err) });
		}
		logger.info("serve:agent-detached", { agentId: id });
		this.#emit({ kind: "detached", sessionId: id });
	}

	/** 全量释放（serve 停机时）。 */
	async disposeAll(): Promise<void> {
		for (const id of [...this.#attached.keys()]) {
			await this.detach(id);
		}
	}

	/**
	 * 组装 server_snapshot 的列表（含运行态字段）。
	 * activeIds：当前需要标记 active 的 agent（由调用方按连接焦点决定）。
	 */
	buildSessionList(activeIds: ReadonlySet<string>): SessionListEntry[] {
		return this.listMetas().map(meta => {
			const attached = this.#attached.get(meta.id);
			const entry: SessionListEntry = {
				id: meta.id,
				name: meta.name,
				active: activeIds.has(meta.id),
				attached: attached !== undefined,
				agentDir: meta.agentDir,
				skillCount: meta.skillCount,
			};
			if (attached) {
				entry.sessionFile = attached.session.sessionFile;
				const model = attached.session.model;
				if (model) entry.model = { provider: model.provider, id: model.id, name: model.name };
				entry.phase = attached.store.getSnapshot().phase;
			}
			return entry;
		});
	}

	subscribe(listener: (event: RegistryEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// 单个监听器异常不拖垮其它
			}
		}
	}
}
