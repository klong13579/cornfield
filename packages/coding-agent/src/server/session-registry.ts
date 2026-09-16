import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@cornfield/utils";
import type { DingtalkAgentConfigDto, SessionListEntry } from "@cornfield/wire";
import type { ProjectId } from "../agent-domain/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { SessionSnapshot } from "../session/session-snapshot";
import { SessionStore } from "../session/session-store";
import { type ResolvedSessionWorkspace, resolveSessionWorkspace } from "../session/session-workspace";
import { listRegistered } from "../skeleton/registry";
import { loadWorkspace } from "../skeleton/workspace";

/**
 * 多 Agent 会话注册表（P3）。
 *
 * 职责：把「注册表里的 agentDir 元数据」与「进程内活跃的 AgentSession」分开管理。
 *
 * - 元数据层：`~/.cornfield/agent/registry.json` 只读加载（绝不做写操作），加上 serve 自带的
 *   default agent（P1 兼容：cwd 进程的那个会话）。列表展示（server_snapshot / list_agents）
 *   只依赖这层，零成本。
 * - 会话层：lazy attach —— 收到 attach/switch_session 或命令定向到某 agent 时才调
 *   sessionFactory 实例化 AgentSession + SessionStore。idle = 只有元数据，active = 已 attach。
 *
 * 事件路由：每个 attached session 的 SessionStore 事件重新发为带 sessionId 的
 * RegistryEvent，上层（wire-server）按连接的 active 路由，不再全局广播。
 *
 * 地址 = (Agent, 工作根)：一个 Agent 可以同时服务两个 Project（`docs/client/agent-hub.md` §1），
 * 那就必须能有两个并存的会话，谁也不顶替谁 —— 今天的 key 只有 agentId，第二个 attach 会把
 * 第一个从表里挤掉（并且 detach 掉它的 session）。所以附件按 `attachmentKey(agentId, root)` 存，
 * `root` 由 `attachmentRoot` 从 resolver 的结果里取（没绑 Project 的就是 agentDir，
 * 即今天的 key）。工作根由 `../session/session-workspace` 一处判定，这里不写第二份。
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
	/** 钉钉机器人配置（gateway.json channels.dingtalk.accounts，按 accountId 匹配；未绑定省略）。 */
	dingtalk?: DingtalkAgentConfigDto;
}

export interface AttachedSession {
	meta: AgentMeta;
	session: AgentSession;
	store: SessionStore;
	unsubscribeStore: () => void;
}

/**
 * attach 时由上层（serve.ts）提供：按 resolver 解出的工作区装配一个 AgentSession。
 *
 * 传的是**整个 workspace**（不是裸 root），因为归属要跟着装配一起落到会话头上：
 * `root = attachmentRoot(meta, workspace)`，`projectId`/`projectSource` 写给 `setResolvedProject`。
 * 拆成两个参数就会有两份「这个会话属于谁」的传递，迟早对不上。
 *
 * 三条根的分工（`docs/client/agent-hub.md` §1.1a）：`meta.agentDir` 是**身份根**
 * （配置/记忆/凭证/session 目录都在这里），`root` 是**工作根**（工具 cwd、skills/context 发现、
 * 配置的 project 层跟着它走），Project root 是**归属**。工厂不许拿一个当另一个用。
 */
export type SessionFactory = (meta: AgentMeta, workspace: ResolvedSessionWorkspace) => Promise<AgentSession>;

/**
 * 这个附件的工作根 —— 全局就这一处：绑了 Project 就是 Project 的 root，没绑就是 `agentDir`
 * （registry agent 历来在 agentDir 上跑，逐字节不变）。装配方与附件地址共用它。
 */
export function attachmentRoot(meta: AgentMeta, workspace: ResolvedSessionWorkspace): string {
	return workspace.projectRoot ?? meta.agentDir;
}

/**
 * 一个附件的地址：(Agent, 工作根)。
 *
 * 工作根是装配时定下来的（`attachmentRoot`，只问 resolver），所以同 (agent, root) 就同附件；
 * 一个 Agent 在两个 Project 上就是两个地址、两条并存的记录。没绑 Project 的附件地址 = agentDir，
 * 也就是今天那个 key。
 */
export function attachmentKey(agentId: string, root: string): string {
	return `${agentId}\u0000${root}`;
}

/**
 * 注册表事件。`sessionId` 是**附件地址**（`attachmentKey(agentId, root)`），不是裸 agentId：
 * 一个 Agent 可以有两个附件，事件必须说清是哪一个。没绑 Project 的附件地址仍以 agentId 打头，
 * 拿 `registry.getAttached(agentId)` 就能取到它的那条 —— 今天的路由（按 agentId 比）行为不变。
 * 绑了 Project 的附件要按地址路由：调用方自己 `attachmentKey(agentId, root)` 拼，或者拿 attach 的返回值。
 */
export type RegistryEvent =
	| { kind: "attached"; sessionId: string }
	| { kind: "detached"; sessionId: string }
	| { kind: "snapshot"; sessionId: string; snapshot: SessionSnapshot; event: AgentSessionEvent };

/** 从磁盘读全部 agent 元数据（registry.json + 各 agentDir 的 workspace.json）。不写任何文件。 */
export async function loadAgentMetas(): Promise<AgentMeta[]> {
	const registered = await listRegistered();
	const dingtalk = await loadDingtalkConfigs();
	const metas: AgentMeta[] = [];
	for (const { name, entry } of registered) {
		const workspace = await loadWorkspace(entry.path).catch(() => null);
		metas.push({
			id: name,
			name: workspace?.name ?? entry.displayName ?? name,
			agentDir: entry.path,
			skillCount: await countSkills(entry.path, workspace?.skillsDir),
			dingtalk: dingtalk.get(name),
		});
	}
	return metas;
}

/**
 * gateway.json → channels.dingtalk.accounts（accountId → 机器人配置）。
 * 读失败（未安装 gateway / 文件损坏）→ 空 Map，serve 仅无绑定视图，不崩溃。
 */
async function loadDingtalkConfigs(): Promise<Map<string, DingtalkAgentConfigDto>> {
	const out = new Map<string, DingtalkAgentConfigDto>();
	try {
		const raw = (await Bun.file(path.join(getConfigRootDir(), "gateway.json")).json()) as {
			channels?: { dingtalk?: { accounts?: Record<string, Record<string, unknown>> } };
		};
		const accounts = raw.channels?.dingtalk?.accounts;
		if (!accounts) return out;
		for (const [accountId, cfg] of Object.entries(accounts)) {
			out.set(accountId, {
				enabled: cfg.enabled !== false,
				robotName: typeof cfg.robotName === "string" ? cfg.robotName : undefined,
				appKey: typeof cfg.appKey === "string" ? cfg.appKey : undefined,
				robotCode: typeof cfg.robotCode === "string" ? cfg.robotCode : undefined,
				hideThinkingBlock: typeof cfg.hideThinkingBlock === "boolean" ? cfg.hideThinkingBlock : undefined,
				deniedTools: Array.isArray(cfg.deniedTools) ? (cfg.deniedTools as string[]) : undefined,
				agentDir: typeof cfg.agentDir === "string" ? cfg.agentDir : undefined,
			});
		}
	} catch (err) {
		if (!isEnoent(err)) logger.warn("serve:dingtalk-config-unavailable", { error: String(err) });
	}
	return out;
}

async function countSkills(agentDir: string, skillsDir: string | undefined): Promise<number | undefined> {
	const dir = path.join(agentDir, skillsDir ?? ".cornfield/skills");
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
	/** key = `attachmentKey(agentId, root)`（见模块注释）。 */
	readonly #attached = new Map<string, AttachedSession>();
	readonly #listeners = new Set<(event: RegistryEvent) => void>();
	/** attach 进行中的去重，key = 附件地址（并发 attach 同一地址只建一次）。 */
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

	/**
	 * 地址的第二段是**工作根**（`attachmentRoot` 取的那个值），不是 projectId。
	 * 不给就用这个 Agent 自己的 agentDir —— 也就是今天 `attach(agentId)` 建的那个附件。
	 * 未注册的 Agent 解不出根，什么也取不到（它不是「默认根」，是没有根）。
	 */
	isAttached(agentId: string, root?: string): boolean {
		const address = this.#address(agentId, root);
		return address !== undefined && this.#attached.has(address);
	}

	/** 取某个附件。`root` 省略 = 这个 Agent 自己根上的那个附件（今天的语义）。 */
	getAttached(agentId: string, root?: string): AttachedSession | undefined {
		const address = this.#address(agentId, root);
		return address === undefined ? undefined : this.#attached.get(address);
	}

	/** 地址：`root` 给了就用它，没给就是这个 Agent 的 agentDir；Agent 没注册就是 `undefined`。 */
	#address(agentId: string, root?: string): string | undefined {
		const resolved = root ?? this.#metas.get(agentId)?.agentDir;
		return resolved === undefined ? undefined : attachmentKey(agentId, resolved);
	}

	listAttached(): AttachedSession[] {
		return [...this.#attached.values()];
	}

	/**
	 * 注入一个已存在的 session（serve 启动时自建的 default 用）。
	 * 与 attach 不同：不调 factory、不解析工作区，直接接管事件订阅。
	 */
	attachExisting(agentId: string, entry: Omit<AttachedSession, "unsubscribeStore">, root?: string): void {
		const key = attachmentKey(agentId, root ?? entry.meta.agentDir);
		this.#metas.set(agentId, entry.meta);
		const unsubscribeStore = entry.store.subscribe((snapshot, event) => {
			this.#emit({ kind: "snapshot", sessionId: key, snapshot, event });
		});
		this.#attached.set(key, { ...entry, unsubscribeStore });
		this.#emit({ kind: "attached", sessionId: key });
	}

	/**
	 * Lazy attach：实例化这个 (Agent, Project) 的 AgentSession（幂等，并发安全）。
	 *
	 * - 未注册的 agentId 抛错（上层转 ok:false）。
	 * - 工作区只问 resolver（`../session/session-workspace`）：绑定 Project 时工作根 = 那个
	 *   Project 的 root，没绑定时 = `meta.agentDir`。**工作根是装配时定的**，之后不搬迁。
	 * - 解析失败（未声明的 projectId、Project 注册表读不出来、agentDir 声明坏掉）直接抛
	 *   `SessionWorkspaceError`，**一个会话都不建**：不许静默落回任何默认根 —— 那会让会话在
	 *   一个谁都没声明过的地方跑。
	 */
	async attach(agentId: string, projectId?: ProjectId): Promise<AttachedSession> {
		const meta = this.#metas.get(agentId);
		if (!meta) {
			throw new Error(`unknown agent: ${agentId}`);
		}

		// 地址（root）要解析完才知道，所以解析在前、查表在后。解析是唯一一个 await 之前的步骤：
		// 它回来之后到登记去重项之间**没有 await**，所以并发的第二次调用要么看到已 attach 的
		// 那一个，要么看到同一地址的 inflight，不会两次都去建会话（那会挤掉第一个、并把它留在
		// 那里没人 dispose）。
		const workspace = await resolveSessionWorkspace({ agentDir: meta.agentDir, projectId, header: null });
		const root = attachmentRoot(meta, workspace);
		const key = attachmentKey(agentId, root);

		const existing = this.#attached.get(key);
		if (existing) return existing;
		const inflight = this.#attaching.get(key);
		if (inflight) return inflight;

		const promise = this.#createAttachment(meta, workspace, key);
		this.#attaching.set(key, promise);
		try {
			return await promise;
		} finally {
			if (this.#attaching.get(key) === promise) this.#attaching.delete(key);
		}
	}

	/** 建会话并接入注册表。调用方已完成解析与地址去重。 */
	async #createAttachment(
		meta: AgentMeta,
		workspace: ResolvedSessionWorkspace,
		key: string,
	): Promise<AttachedSession> {
		const session = await this.#factory(meta, workspace);
		const store = SessionStore.attach(session);
		const entry: AttachedSession = {
			meta,
			session,
			store,
			unsubscribeStore: () => {},
		};
		entry.unsubscribeStore = store.subscribe((snapshot, event) => {
			this.#emit({ kind: "snapshot", sessionId: key, snapshot, event });
		});
		this.#attached.set(key, entry);
		logger.info("serve:agent-attached", {
			agentId: meta.id,
			agentDir: meta.agentDir,
			root: attachmentRoot(meta, workspace),
			projectId: workspace.projectId,
			sessionId: session.sessionId,
		});
		this.#emit({ kind: "attached", sessionId: key });
		return entry;
	}

	/** 释放一个附件（dispose session）。未 attach 时 no-op。 */
	async detach(agentId: string, root?: string): Promise<void> {
		const address = this.#address(agentId, root);
		if (address !== undefined) await this.#detachKey(address);
	}

	async #detachKey(key: string): Promise<void> {
		const entry = this.#attached.get(key);
		if (!entry) return;
		this.#attached.delete(key);
		entry.unsubscribeStore();
		entry.store.dispose();
		try {
			await entry.session.dispose();
		} catch (err) {
			logger.warn("serve:agent-detach-dispose-failed", { agentId: entry.meta.id, error: String(err) });
		}
		logger.info("serve:agent-detached", { agentId: entry.meta.id });
		this.#emit({ kind: "detached", sessionId: key });
	}

	/** 全量释放（serve 停机时）。 */
	async disposeAll(): Promise<void> {
		for (const key of [...this.#attached.keys()]) {
			await this.#detachKey(key);
		}
	}

	/**
	 * 组装 server_snapshot 的列表（含运行态字段）。
	 * activeIds：当前需要标记 active 的 agent（由调用方按连接焦点决定）。
	 *
	 * 一行 = 一个 Agent（DTO 是 agent 列表：id/name/role/skillCount/dingtalk 全是 agent 的事实），
	 * 运行态字段取「这个 Agent 自己 agentDir 上的附件」。绑定 Project 的附件**不在这里冒充 agent 行**
	 * —— 它是另一个根上的会话，归属由会话索引/归属投影（`list_sessions` 的权威 projectId）负责展示；
	 * 需要全部附件时读 `listAttached()`。
	 */
	buildSessionList(activeIds: ReadonlySet<string>): SessionListEntry[] {
		return this.listMetas().map(meta => {
			const attached = this.getAttached(meta.id);
			const entry: SessionListEntry = {
				id: meta.id,
				name: meta.name,
				active: activeIds.has(meta.id),
				attached: attached !== undefined,
				agentDir: meta.agentDir,
				skillCount: meta.skillCount,
				dingtalk: meta.dingtalk,
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
