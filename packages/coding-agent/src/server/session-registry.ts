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
 * 身份 = (Agent, Project)：一个 Agent 可以同时服务两个 Project（`docs/client/agent-hub.md` §1），
 * 那就必须能有两个并存的会话，谁也不顶替谁 —— 今天的 key 只有 agentId，第二个 attach 会把
 * 第一个从表里挤掉（并且 detach 掉它的 session）。所以**公共 API 一律按 (agentId, projectId)**
 * 定位，用 `projectId` 而不是工作根：根要问 resolver 才知道，而 `getAttached` 必须是同步的。
 * 附件自己报出它的**地址**（`AttachedSession.address`，即 (Agent, 工作根)）供路由与展示读。
 * 工作根由 `../session/session-workspace` 一处判定，这里不写第二份。
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

/**
 * 一个**调用方自己建好的**会话（`attachExisting` 的输入）：serve 启动时的 default 走这条路径。
 * 它没经过 resolver，所以没有工作根可言 —— registry 不会替它编一个，地址就取 `meta.agentDir`。
 */
export interface ExistingSession {
	meta: AgentMeta;
	session: AgentSession;
	store: SessionStore;
}

export interface AttachedSession extends ExistingSession {
	/**
	 * **附件地址**（事实，不是输入）：事件的 `sessionId` 就是这个。绑了 Project 时 =
	 * `attachmentKey(agentId, 工作根)`，没绑定 = `agentId` 本身（＝今天注册表的 key）。
	 * 调用方**读**它（`attached.address` / `event.sessionId`），不要自己拼。
	 */
	address: string;
	/** 这个附件的工作根（绑 Project = 它的 root，否则 = `meta.agentDir`；装配时由 resolver 定）。 */
	root: string;
	/** 绑的 Project；未绑定 = `undefined`（不是「默认 Project」）。 */
	projectId?: ProjectId;
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
 * 附件地址：(Agent, 工作根)。绑了 Project 的附件才是这个形状；**没绑的就是 `agentId` 本身**
 * —— 那是今天注册表的 key，事件路由（wire-server 按 activeAgentId 比 `event.sessionId`）
 * 与 `getAttached(agentId)` 因而逐字节不变。
 *
 * 地址是**事实**，不是输入：装配时由 resolver 定下来，之后挂在 `AttachedSession.address` 上、
 * 填进事件的 `sessionId`。调用方读它，不要自己拼（一个 Project 只声明一个 root，
 * `project-store` 拒绝同 root 两名，所以两个 Project 就是两个地址）。
 */
export function attachmentKey(agentId: string, root?: string): string {
	return root === undefined ? agentId : `${agentId}\u0000${root}`;
}

/** 这个附件的地址：绑了 Project 才带工作根。 */
function addressOf(agentId: string, meta: AgentMeta, workspace: ResolvedSessionWorkspace): string {
	return workspace.projectId === undefined
		? attachmentKey(agentId)
		: attachmentKey(agentId, attachmentRoot(meta, workspace));
}

/**
 * 查表槽位（内部）：按调用方能给出的身份 (agentId, projectId) 定位，**不是**附件地址 ——
 * 地址要等 resolver 解出工作根才成形，而查表必须同步（事件路由就在同步路径上）。
 * 一个 Project 只声明一个 root（`../agent-domain/project-store` 拒绝同 root 两名），
 * 槽位与地址因而一一对应；没绑 Project 时两者都是 agentId。
 */
function slot(agentId: string, projectId?: ProjectId): string {
	return projectId === undefined ? agentId : `${agentId}\u0000${projectId}`;
}

/**
 * 注册表事件。`sessionId` 是**附件地址**（`AttachedSession.address`）—— 一个 Agent 可以有两个附件，
 * 事件必须说清是哪一个。没绑 Project 的附件地址就是 `agentId` 本身，所以今天「按 agentId 比
 * `event.sessionId`」的路由行为不变；绑了 Project 的会话要按地址路由，地址从 `attach()` 的
 * 返回值（或 `getAttached()` 的结果）读，**不要自己拼**。
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
	/** key = `slot(agentId, projectId)`（见模块注释；不是地址 —— 地址要解析完才知道）。 */
	readonly #attached = new Map<string, AttachedSession>();
	readonly #listeners = new Set<(event: RegistryEvent) => void>();
	/** attach 进行中的去重，key = 同一个槽位（并发 attach 同一 (Agent, Project) 只建一次）。 */
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

	/** 这个 (Agent, Project) 的附件在不在。（不带 projectId = 这个 Agent 自己根上的那个附件。） */
	isAttached(agentId: string, projectId?: ProjectId): boolean {
		return this.#attached.has(slot(agentId, projectId));
	}

	/**
	 * 取某个附件。`projectId` 省略 = 这个 Agent 自己根上的那个附件（今天的语义）。
	 * 地址不在这里拼 —— 要地址读 `attached.address`。
	 */
	getAttached(agentId: string, projectId?: ProjectId): AttachedSession | undefined {
		return this.#attached.get(slot(agentId, projectId));
	}

	listAttached(): AttachedSession[] {
		return [...this.#attached.values()];
	}

	/**
	 * 接管一个已存在的会话（serve 启动时自建的 default 用）。
	 * 与 attach 不同：不调 factory、不解析工作区，直接接管事件订阅。
	 *
	 * **不收 projectId**：这条路径没有 resolver 的答案，registry 不会替它编一个工作根；
	 * 要一个绑 Project 的附件就走 `attach(agentId, projectId)`。
	 */
	attachExisting(agentId: string, entry: ExistingSession): void {
		const address = attachmentKey(agentId);
		this.#metas.set(agentId, entry.meta);
		const unsubscribeStore = entry.store.subscribe((snapshot, event) => {
			this.#emit({ kind: "snapshot", sessionId: address, snapshot, event });
		});
		this.#attached.set(slot(agentId), {
			...entry,
			address,
			root: entry.meta.agentDir,
			unsubscribeStore,
		});
		this.#emit({ kind: "attached", sessionId: address });
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

		const key = slot(agentId, projectId);
		// 快路径：已经建好的（或正在建的）直接拿，不白问一次 resolver。
		const cached = this.#hit(key);
		if (cached) return await cached;

		// 解析失败（未声明的 projectId / Project 注册表读不出来 / agentDir 声明坏掉）就在这里抛：
		// 不建、也不落回任何默认根。
		const workspace = await resolveSessionWorkspace({ agentDir: meta.agentDir, projectId, header: null });

		// 解析是唯一的 await；它回来之后到登记去重项之间**没有 await**，所以并发的第二次调用
		// 到这里时要么看到已接进来的那一个，要么看到同槽位的 inflight —— 不会两次都去建会话
		// （那会挤掉第一个，并把它留在那里没人 dispose）。这次复查因此不是多余的。
		const settled = this.#hit(key);
		if (settled) return await settled;

		const promise = this.#createAttachment(key, agentId, meta, workspace);
		this.#attaching.set(key, promise);
		try {
			return await promise;
		} finally {
			if (this.#attaching.get(key) === promise) this.#attaching.delete(key);
		}
	}

	/** 已建好的附件，或同槽位的在建项；都没有 = `undefined`。 */
	#hit(key: string): Promise<AttachedSession> | AttachedSession | undefined {
		return this.#attached.get(key) ?? this.#attaching.get(key);
	}

	/** 建会话并接入注册表。`key` 是调用方那条路径上算好的槽位（不再重算，免得两处判断分家）。 */
	async #createAttachment(
		key: string,
		agentId: string,
		meta: AgentMeta,
		workspace: ResolvedSessionWorkspace,
	): Promise<AttachedSession> {
		const session = await this.#factory(meta, workspace);
		const store = SessionStore.attach(session);
		const address = addressOf(agentId, meta, workspace);
		const entry: AttachedSession = {
			meta,
			session,
			store,
			address,
			root: attachmentRoot(meta, workspace),
			projectId: workspace.projectId,
			unsubscribeStore: () => {},
		};
		entry.unsubscribeStore = store.subscribe((snapshot, event) => {
			this.#emit({ kind: "snapshot", sessionId: address, snapshot, event });
		});
		this.#attached.set(key, entry);
		logger.info("serve:agent-attached", {
			agentId,
			agentDir: meta.agentDir,
			root: entry.root,
			projectId: workspace.projectId,
			address,
			sessionId: session.sessionId,
		});
		this.#emit({ kind: "attached", sessionId: address });
		return entry;
	}

	/** 释放一个附件（dispose session）。未 attach 时 no-op。 */
	async detach(agentId: string, projectId?: ProjectId): Promise<void> {
		await this.#detachSlot(slot(agentId, projectId));
	}

	async #detachSlot(key: string): Promise<void> {
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
		this.#emit({ kind: "detached", sessionId: entry.address });
	}

	/** 全量释放（serve 停机时）。 */
	async disposeAll(): Promise<void> {
		for (const key of [...this.#attached.keys()]) {
			await this.#detachSlot(key);
		}
	}

	/**
	 * 组装 server_snapshot 的列表（含运行态字段）。
	 * activeIds：当前需要标记 active 的 agent（由调用方按连接焦点决定）。
	 *
	 * **一行 = 一个 Agent**（DTO 是 agent 列表：id/name/role/skillCount/dingtalk 全是 agent 的事实），
	 * 运行态字段取「这个 Agent 自己 agentDir 上的附件」。绑 Project 的附件**不在这里冒充 agent 行**：
	 * 它的 `id` 是同一个 agent、名字也是同一个，而消费方是按 `id` 建索引的（`SessionSidebar` 的
	 * `new Map(agents.map(a => [a.id, a.name]))`、`insights-scope` 的 `find(a => a.id === identity)`）
	 * —— 多一行同 id 不是「多看见一个」，而是把 agent 自己那行覆盖掉。
	 *
	 * 所以「哪个 Project 上开着哪个会话」由**会话索引**回答：`list_sessions` 每条 entry 带
	 * 会话头里的权威 `projectId`（绑 Project 的会话 JSONL 就写在 `<agentDir>/sessions` 下，一定被扫到）。
	 * 要看全部附件读 `listAttached()`。
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
