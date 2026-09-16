/**
 * serve 侧的 Session Tree 桥 —— 把父会话的委派账本搬到 wire 面。
 *
 * 桥不拥有任何语义：账本、状态机、结果带回的幂等门闩都在 `../session/session-tree-manager`
 * 与 `../session/session-tree-store` 里，这里只做四件事 ——
 *
 *   1. **给一个 attached 会话配一个 manager**（`hostFor`）。必须**每会话一个**：
 *      `bringBack()` 的「第一次带回」判定与账本写锁都是实例内的，每次命令新建实例会让
 *      两次并发带回各自读到「还没带回」，于是同一条结果被注入两遍 —— 正是 `firstTime`
 *      存在的理由。
 *   2. **读**（`readSessionTree`）：`manager.records()` 会先把账本与 supervisor 对齐，
 *      再用 `SessionLogTreeStore` 的严格校验读回磁盘快照（读不出来的条目是硬错误，不是
 *      「这条不存在」）。
 *   3. **委派**（`delegateChildSession`）：真的起一个独立 cornfield 子进程、把它记进
 *      本会话的账本，并**把 objective 交给它**（wire 面唯一的 prompt）——账本里的
 *      `objective` 是给父会话看的，不是子会话收到的。起不来、没通过注册门（子进程没以
 *      本会话为 parent 挂上 broker）、**子进程自称的 Agent 与账本不一致**、或派工报文
 *      没被接受，整条命令失败并带上真实原因，并且不返回任何一条「已委派」记录 ——
 *      没有「乐观 started 记录」这种东西。
 *
 *      子进程的 cwd 只能是**服务端自己声明过的**位置（见 `authorizeChildCwd`）：那正是
 *      一个目录能决定子进程导入并执行什么代码的地方，而 cwd 是调用方给的。
 *   4. **带回**（`bringBackChildResult`）：`manager.bringBack()` 解析结果指针并盖时间戳，
 *      只有 `firstTime` 时才把内容并入父会话 —— 重复带回不报错，也不再注入。
 *
 * ## 委派时父会话为什么要自己上线 broker
 *
 * 子会话回传状态只有一条路：intercom 消息。子进程注册时带 `parentId`，回传时再按这个 id
 * 在花名册上**解析**父会话（`intercom-extension/index.ts#resolveSupervisorTarget`）——
 * 父会话不在花名册上，子会话的每一条上报都找不到收件人。所以 serve 在第一次委派前会以
 * 自己的身份上线（`ServeIntercomPresence`），并用同一个连接做两件事：读花名册判断子会话
 * 是否真的挂上了边（注册门），以及接收子会话上报。没有 broker（gateway 没跑）时这一步
 * 直接失败，委派返回 ok:false —— 那正是事实：一个没人能寻址的子会话不算启动成功。
 *
 * 上线用的 id 是**派生态**（`<会话的 intercom id>-tree`）：本会话自己的 intercom 连接
 * 属于会话运行时（intercom 扩展），同一个 id 再注册会把那条连接顶掉。
 */

import * as path from "node:path";
import { logger } from "@cornfield/utils";
import type {
	BroughtBackChildResultDto,
	ChildSessionNodeDto,
	DelegateChildInput,
	DelegatedChildDto,
	SessionTreeDto,
} from "@cornfield/wire";
import { resolveCornfieldBinary } from "../commands/serve-sidecar";
import { IntercomClient } from "../intercom-extension/broker/client";
import { type ChildSessionRoster, createIntercomRegistrationProbe } from "../intercom-extension/child-session-edge";
import {
	attachChildSessionReports,
	type ChildSessionReportSink,
	type ChildSessionReportSource,
	createIntercomLivenessProbe,
} from "../intercom-extension/child-session-tree";
import { loadConfig } from "../intercom-extension/config";
import type { SessionInfo, SessionRegistration } from "../intercom-extension/types";
import type { AgentSession } from "../session/agent-session";
import type { ChildSessionCommand } from "../session/child-session-process";
import { type ChildSession, ChildSessionSupervisor } from "../session/child-session-supervisor";
import type { ChildSessionRecord } from "../session/session-tree";
import { SessionTreeManager, type SessionTreeSelf } from "../session/session-tree-manager";
import { SessionLogTreeStore } from "../session/session-tree-store";
import { resolveAgentRuntimeDir } from "./agent-scope";
import type { AgentMeta } from "./session-registry";

/** 带回的结果写进父会话时用的 custom entry 类型（与会话日志里可检索的标签同值）。 */
export const CHILD_RESULT_CUSTOM_TYPE = "child_session_result";

/** 注入父会话时打在首行的标签，与 `child-session-report` 的 `[child-session]` 同族。 */
const CHILD_RESULT_TAG = "[child-session-result]";

/** serve 一个进程同时跑几个子会话。与 supervisor 的默认上限一致（每个子会话是一个真实进程）。 */
const SERVE_CHILD_CONCURRENCY = 3;

/**
 * `delegate_child` 的入参就是 pi-wire 的 canonical 形状（`DelegateChildInput`），不在这里
 * 再定义一个：命令面与实现面各长一份输入类型，就是让两边慢慢地不一致。
 */
export interface DelegationHostInput {
	session: AgentSession;
	meta: AgentMeta;
	/** 桥声明的委派身份（谁在委派、子会话把哪条边当作父边）。 */
	self: SessionTreeSelf;
}

/**
 * 一台主机的委派实现：谁真的把子进程拉起来、子进程用哪个会话身份上线。
 *
 * 拆出来是因为「起子进程」有几个不同的合法宿主（serve 自己、测试里的 fixture 进程），
 * 而账本纪律、入参校验、DTO 投影是三者共用的。生产缺省就是 `createServeDelegationHost`，
 * 只有测试/嵌入方会传别的。
 */
export interface DelegationHost {
	/** 本会话唯一的那一个 manager（单写者，见文件头第 1 条）。 */
	manager: SessionTreeManager;
	/** 子进程程序。生产是 `cornfield --mode wire-stdio`。 */
	command: ChildSessionCommand;
	/** 委派前上线（生产：连上 broker 并接管子会话上报）。失败＝这条委派失败。 */
	open(): Promise<void>;
}

/** 宿主接缝：测试/嵌入方换掉整个委派实现；生产不传。 */
export interface SessionTreeWireOptions {
	host?: (input: DelegationHostInput) => DelegationHost;
	/** 目标 Agent 查询（serve 装配注册表）。缺省只认父会话自己的 Agent。 */
	resolveAgent?: (agentId: string) => AgentMeta | undefined;
}

/**
 * 每个 attached 会话一个 host（见文件头第 1 条 —— 这是正确性要求，不是缓存优化）。
 *
 * 会话被 detach / 重建时 `AgentSession` 换对象，WeakMap 的键随之失效，不会把旧会话的
 * 账本视图留在内存里。
 */
const hosts = new WeakMap<AgentSession, DelegationHost>();

function hostFor(session: AgentSession, meta: AgentMeta, options: SessionTreeWireOptions): DelegationHost {
	const existing = hosts.get(session);
	if (existing) return existing;
	// root/depth/project 一律不填：它们今天没有被持久化（WP1 权威表把完整树节点列为
	// 待建），编一个出来就是替会话声明一个没人记录过的身份。
	const self: SessionTreeSelf = {
		sessionId: session.sessionId,
		agentId: meta.id,
		intercomSessionId: parentEdgeId(session),
	};
	const host = (options.host ?? createServeDelegationHost)({ session, meta, self });
	hosts.set(session, host);
	return host;
}

/**
 * 一个 attached 会话直接委派出去的子会话。
 *
 * 只回答这一层：孙会话在子会话自己的日志里，要展开就拿子会话的 sessionId 再查一次。
 */
export async function readSessionTree(
	session: AgentSession,
	meta: AgentMeta,
	options: SessionTreeWireOptions = {},
): Promise<SessionTreeDto> {
	const records = await hostFor(session, meta, options).manager.records();
	const tree: SessionTreeDto = {
		sessionId: session.sessionId,
		agentId: meta.id,
		agentName: meta.name,
		children: records.map(record => toChildSessionNode(record)),
	};
	const title = session.sessionName;
	if (title) tree.title = title;
	return tree;
}

/**
 * 从 `session` 委派一个子会话，成功才返回一条**真实**记录。
 *
 * 五道门，任何一道不过都抛出（wire 面 → ok:false + 真实原因）：
 *   1. 目标 Agent 必须存在（注册表说了算）、它的家必须解析得出来，cwd 覆盖必须是绝对路径、
 *      且落在服务端授权的位置里（见 `authorizeChildCwd`）；
 *   2. 父会话必须能上线 broker —— 否则子会话的上报没有收件人；
 *   3. 子进程必须真的起来、并以本会话为 parent 挂上 broker（supervisor 的注册门）；
 *   4. 子进程必须以目标 Agent 的家为运行目录，并**自称**跑在那个 Agent 上（见
 *      `confirmChildAgent`）—— 账本里那一行不是证据；
 *   5. objective 必须真的交到子进程手上 —— 一条没拿到活的子会话不会产出任何东西。
 *
 * 已委派的子会话在 launch 失败、或派工没送出去时，账本里留下一条 `failed` 条目（manager
 * 的既有语义：父会话确实委派过，账本要说清发生了什么），而不是凭空消失 —— 但它不会出现在
 * 这次返回里。
 */
export async function delegateChildSession(
	session: AgentSession,
	meta: AgentMeta,
	input: DelegateChildInput,
	options: SessionTreeWireOptions = {},
): Promise<DelegatedChildDto> {
	const objective = input.objective?.trim();
	if (!objective) throw new Error("delegate_child needs a non-empty objective");
	const cwdOverride = input.cwd?.trim();
	if (cwdOverride && !path.isAbsolute(cwdOverride)) {
		throw new Error(`delegate_child cwd must be an absolute path, got ${JSON.stringify(cwdOverride)}`);
	}

	const host = hostFor(session, meta, options);
	const target = resolveTargetAgent(input.agentId, meta, options);
	// 两件事，不是一个：`agentDir` 决定子进程**是哪个 Agent**（配置、技能、记忆都按它加载），
	// `cwd` 是它在哪个工作区干活。default agent 这里两者天然不同（它的家是全局 agent 目录，
	// 而它干活的地方就是 serve 的项目根），所以不能拿一个当两个用。
	const agentDir = targetAgentDir(target);
	const cwd = cwdOverride || target.agentDir;
	if (cwdOverride) {
		authorizeChildCwd({
			requested: cwdOverride,
			authorized: [target.agentDir, session.sessionManager.getCwd()],
			agentId: target.id,
		});
	}
	// 先上线再起子进程：子进程的 `started` 上报是在启动瞬间发出的，父会话那时必须在花名册上。
	await host.open();

	const { child, record } = await host.manager.delegate({
		agentId: target.id,
		agentDir,
		cwd,
		command: host.command,
		...(input.label?.trim() ? { delegationRole: input.label.trim() } : {}),
		objective,
	});
	try {
		// 先确认它真的是账本里那个 Agent，再把活交出去：派工是这条命令的不可逆点，
		// 一个跑在别人配置下的子会话不应该先拿到任务再被发现。
		await confirmChildAgent(child, record.node.agentId);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await host.manager.fail(
			record.node.sessionId,
			`the child never confirmed it runs as Agent "${record.node.agentId}": ${reason}`,
		);
		logger.warn("serve:child-session-agent-unconfirmed", {
			parentSessionId: session.sessionId,
			childSessionId: record.node.sessionId,
			runId: record.runId,
			agentId: record.node.agentId,
			reason,
		});
		throw new Error(`delegate_child: the child session does not run as Agent "${record.node.agentId}" (${reason})`, {
			cause: error,
		});
	}
	try {
		// 派工走子进程自己的请求通道（`prompt` 是 wire 面唯一的派工命令，且它在子进程侧
		// 立刻返回 —— 子会话随后自己跑，用上报回传进度，这里不阻塞等它做完）。
		// 不做 `retryOnRestart`：一条 prompt 不是幂等命令，重放会让子会话把同一件事做两遍。
		await child.request({ type: "prompt", message: objective });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// 没送出去的委派不是委派：账本记 failed（父会话确实起过进程，账本要说清结局），
		// 子进程停掉（否则它白占一个并发额度，且永远不会产出），整条命令抛出真实原因。
		await host.manager.fail(record.node.sessionId, `the objective never reached the child: ${reason}`);
		logger.warn("serve:child-session-objective-undelivered", {
			parentSessionId: session.sessionId,
			childSessionId: record.node.sessionId,
			runId: record.runId,
			reason,
		});
		throw new Error(`delegate_child: the child session never received its objective (${reason})`, { cause: error });
	}
	logger.info("serve:child-session-delegated", {
		parentSessionId: session.sessionId,
		childSessionId: record.node.sessionId,
		agentId: record.node.agentId,
		runId: record.runId,
	});
	return toDelegatedChildDto(record);
}

/**
 * 子进程能跑在哪个目录里 —— 只认服务端自己声明过的位置。
 *
 * cwd 会变成子进程的工作目录，而工作目录决定它在启动时**导入并执行什么代码**：项目
 * `.cornfield/extensions/*.ts`、项目 settings 里点名的 extension、项目自定义工具/命令，
 * 全部按 cwd 发现，且发生在子进程还没通过注册门之前。所以「绝对路径」不构成安全边界，
 * 而 cwd 是调用方（wire 面）给的。
 *
 * 允许的两个位置都是**服务端的东西**，不是调用方的输入：
 *
 *   - 目标 Agent 的 home（也是缺省 cwd，来自注册表）；
 *   - 本会话自己的工作目录（`session.sessionManager.getCwd()`，由 serve 装配时定）。
 *
 * 第二个位置不给出新能力：那正是本会话运行时**已经在加载扩展的目录**，把子进程放进去只是
 * 让它在同一个工作区里干活。第三个目录则是「用一条 IPC 请求决定在谁的目录里执行代码」。
 *
 * 比较是**精确相等**（`path.resolve` 归一后）：不做前缀、不做软链推断 —— 试图比调用方更
 * 聪明地判断「这条路径算不算那个目录」正是要关掉的那条路。等价路径（软链、macOS 的
 * `/tmp` 与 `/private/tmp`）会被拒绝，错误信息里带上服务端认可的那几个位置，调用方重发即可。
 */
function authorizeChildCwd(input: { requested: string; authorized: readonly string[]; agentId: string }): void {
	const resolved = path.resolve(input.requested);
	const allowed = input.authorized.map(candidate => path.resolve(candidate));
	if (allowed.includes(resolved)) return;
	throw new Error(
		`delegate_child cwd ${JSON.stringify(input.requested)} is not a location this server authorizes for a child session; ` +
			`a child of Agent "${input.agentId}" runs in ${allowed.map(location => JSON.stringify(location)).join(" or ")}`,
	);
}

/**
 * 目标 Agent 的家（`CORNFIELD_AGENT_DIR`）—— 子进程必须以它为自己的身份。
 *
 * 解析不出来的 Agent 不是「用别人的家凑合」：那正是这条防御要关掉的那条路（账本写 ops、
 * 进程跑在父会话的配置上）。这里直接失败，而不是把一个不是任何 Agent 的目录交给子进程。
 */
function targetAgentDir(target: AgentMeta): string {
	const dir = resolveAgentRuntimeDir({ agentId: target.id, agentDir: target.agentDir });
	if (!dir) {
		throw new Error(`delegate_child: Agent ${JSON.stringify(target.id)} has no agent directory to run a child in`);
	}
	return dir;
}

/**
 * 子会话自己报的 Agent 身份 —— 唯一能证明「账本上的 Agent 就是真的在跑的那个」的东西。
 *
 * 问了才信：服务端把目标 Agent 的家写进子进程环境，但「写进去了」不等于「子进程按它解析出了
 * 那个 Agent」（目录不属于这个 Agent、声明把默认 Agent 指到了别人、子进程根本没起来都是真的
 * 会发生的）。`get_state` 的回答是子会话自己算出来的身份，与账本不一致就整条命令失败。
 *
 * 拿不到回答（超时 / 子进程已经不在）同样算失败：无法确认不是确认通过。
 */
async function confirmChildAgent(child: ChildSession, expectedAgentId: string): Promise<void> {
	const state = await child.request<{ agentId?: unknown }>({ type: "get_state" });
	const reported = typeof state?.agentId === "string" ? state.agentId.trim() : "";
	if (reported === expectedAgentId) return;
	throw new Error(
		`the child session reports Agent ${JSON.stringify(reported || null)}, the ledger names ${JSON.stringify(expectedAgentId)}`,
	);
}

/** 目标 Agent：wire 没选就是父会话自己的 Agent；选了就必须在注册表里（未知 = 真错误）。 */
function resolveTargetAgent(agentId: string | undefined, meta: AgentMeta, options: SessionTreeWireOptions): AgentMeta {
	const wanted = agentId?.trim();
	if (!wanted || wanted === meta.id) return meta;
	const found = options.resolveAgent?.(wanted);
	if (!found) throw new Error(`delegate_child: unknown agent ${JSON.stringify(wanted)}`);
	return found;
}

/**
 * 把子会话的结果带回父会话。
 *
 * `firstTime` 由 manager 判定并随账本一起落盘；这一层只在它为真时注入，且注入走
 * `deliverAs: "nextTurn"` —— 父会话正在流式回合中时，结果排队等下一轮，而不是像
 * `steer` 那样打断它（一次委派结果的到达，不是插队改写当前任务的授权）。
 */
export async function bringBackChildResult(
	session: AgentSession,
	meta: AgentMeta,
	childSessionId: string,
	options: SessionTreeWireOptions = {},
): Promise<BroughtBackChildResultDto> {
	const brought = await hostFor(session, meta, options).manager.bringBack(childSessionId);
	const result: BroughtBackChildResultDto = {
		childSessionId,
		resultRef: brought.resultRef,
		content: brought.content,
		firstTime: brought.firstTime,
		broughtBackAt: brought.broughtBackAt,
		injected: false,
	};
	if (!brought.firstTime) return result;

	await session.sendCustomMessage(
		{
			customType: CHILD_RESULT_CUSTOM_TYPE,
			content: formatChildResultInjection(brought.record, brought.content),
			display: true,
			attribution: "agent",
		},
		{ deliverAs: "nextTurn" },
	);
	result.injected = true;
	logger.info("Child session result brought back", {
		parentSessionId: session.sessionId,
		childSessionId,
		resultRef: brought.resultRef,
	});
	return result;
}

/**
 * 注入父会话的文本：先一行机器可读的来源（标签 + 事实），空行，再是子会话产出的原文。
 *
 * 来源行不是装饰 —— 父会话的模型要能分辨「这条是子会话带回来的产物」与「用户说的话」，
 * 否则一次带回和一次用户输入在历史里长得一样。
 */
export function formatChildResultInjection(record: ChildSessionRecord, content: string): string {
	const provenance: Record<string, unknown> = {
		childSessionId: record.node.sessionId,
		resultRef: record.node.resultRef,
		broughtBackAt: record.node.resultBroughtBackAt,
	};
	if (record.node.delegationRole) provenance.delegationRole = record.node.delegationRole;
	if (record.node.objective) provenance.objective = record.node.objective;
	return `${CHILD_RESULT_TAG} ${JSON.stringify(provenance)}\n\n${content}`;
}

/**
 * 父边 id：子会话把哪条边当作它的 parent。
 *
 * 会话自己的 intercom 身份由运行时决定（`PI_INTERCOM_STABLE_ID` → config.json 的 stableId
 * → 会话 id），这里跟着同一套优先级，再加一个后缀。后缀不是装饰：本会话自己的连接属于
 * 会话运行时，broker 对同一个 id 的再次注册会**顶掉**前一条连接，serve 用同一个 id 上线
 * 就等于把会话自己的 intercom 掐了。
 */
function parentEdgeId(session: AgentSession): string {
	const configured = process.env.PI_INTERCOM_STABLE_ID?.trim() || loadConfig().stableId || session.sessionId;
	return `${configured}-tree`;
}

/** 账本记录 → `delegate_child` 的回执（只投影「真的发生了」的那几个事实）。 */
function toDelegatedChildDto(record: ChildSessionRecord): DelegatedChildDto {
	const dto: DelegatedChildDto = {
		sessionId: record.node.sessionId,
		runId: record.runId,
		status: record.node.status,
		agentId: record.node.agentId,
	};
	if (record.lastPid !== undefined) dto.pid = record.lastPid;
	if (record.node.objective) dto.objective = record.node.objective;
	if (record.node.delegationRole) dto.delegationRole = record.node.delegationRole;
	return dto;
}

/** 账本记录 → wire 投影（字段一一对应，不做推断；缺父边即报错，不补一个假值）。 */
function toChildSessionNode(record: ChildSessionRecord): ChildSessionNodeDto {
	const node = record.node;
	const parentSessionId = node.parentSessionId;
	if (parentSessionId === undefined) {
		throw new Error(
			`Session tree entry for "${node.sessionId}" has no parent edge; a ledger node is a child of the session that owns the ledger`,
		);
	}
	const dto: ChildSessionNodeDto = {
		sessionId: node.sessionId,
		parentSessionId,
		rootSessionId: node.rootSessionId,
		depth: node.depth,
		agentId: node.agentId,
		status: node.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (node.projectId) dto.projectId = node.projectId;
	if (node.delegationRole) dto.delegationRole = node.delegationRole;
	if (node.objective) dto.objective = node.objective;
	if (node.resultRef !== undefined) dto.resultRef = node.resultRef;
	if (node.resultBroughtBackAt !== undefined) dto.resultBroughtBackAt = node.resultBroughtBackAt;
	if (record.lastPid !== undefined) dto.lastPid = record.lastPid;
	if (record.escalation) {
		dto.escalation = {
			blocking: record.escalation.blocking,
			question: record.escalation.question,
			at: record.escalation.at,
		};
	}
	if (record.statusDetail) dto.statusDetail = record.statusDetail;
	return dto;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产宿主：真的起 cornfield 子进程，父会话自己上线 broker 做注册门与上报收口。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 上线用的那条连接 —— 只要它能注册、能读花名册、能收消息、能说自己还在不在。
 *
 * 结构化类型而不是 `IntercomClient`：测试要拿一条会重连的连接把「连接被换掉」这条路径
 * 跑出来，而不是只跑一次成功连接。`IntercomClient` 满足它。
 */
export interface DelegationPresenceClient extends ChildSessionRoster, ChildSessionReportSource {
	connect(registration: SessionRegistration, sessionId?: string): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
}

/**
 * 父会话在 broker 上的委派身份。
 *
 * 一个连接做三件事，因为它们必须看同一份花名册：注册门（子会话有没有挂上这条父边）、
 * 存活探测（reconcile 用）、以及接收子会话上报（`attachChildSessionReports`）。
 *
 * 连接在**第一次委派**时才建立：读账本、带回结果都不该让 serve 去连 broker。
 */
export class ServeIntercomPresence {
	readonly #session: AgentSession;
	readonly #meta: AgentMeta;
	readonly #sessionId: string;
	readonly #createClient: () => DelegationPresenceClient;
	#client: DelegationPresenceClient | null = null;
	#connecting: Promise<DelegationPresenceClient> | null = null;
	/**
	 * 上报收口当下挂在**哪一条连接**上。
	 *
	 * 必须记连接本身，不能只记一个「挂过了」的布尔：连接没了之后 `listSessions()` 会换一条
	 * 新连接，旧句柄不会把新连接上的消息转过来。只记布尔就会在重连后永远提前返回，于是
	 * 之后的每一条 completed / waiting / 结果上报都被静默丢掉 —— 而委派照样报成功。
	 */
	#reports: { client: DelegationPresenceClient; detach: () => void } | null = null;

	constructor(input: {
		session: AgentSession;
		meta: AgentMeta;
		sessionId: string;
		/** 连接工厂。生产是新的 `IntercomClient`；测试/嵌入方换掉它。 */
		createClient?: () => DelegationPresenceClient;
	}) {
		this.#session = input.session;
		this.#meta = input.meta;
		this.#sessionId = input.sessionId;
		this.#createClient = input.createClient ?? (() => new IntercomClient());
	}

	/** 本连接在 broker 上的 id —— 也是子会话要注册的 `parentId`。 */
	get sessionId(): string {
		return this.#sessionId;
	}

	/** 花名册读取（`ChildSessionRoster` 的结构满足者）。连不上就抛，不返回空花名册。 */
	async listSessions(options: { timeoutMs?: number } = {}): Promise<SessionInfo[]> {
		const client = this.#client;
		if (client?.isConnected()) return await client.listSessions(options);
		this.#connecting ??= this.#connect();
		try {
			return await (await this.#connecting).listSessions(options);
		} finally {
			this.#connecting = null;
		}
	}

	async #connect(): Promise<DelegationPresenceClient> {
		const client = this.#createClient();
		try {
			await client.connect(this.#registration(), this.#sessionId);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// 半死的连接不能留在对象里：下一次委派要重新尝试，而不是拿一条坏 socket 当真。
			await client.disconnect().catch(() => {});
			if (this.#client === client) this.#client = null;
			throw new Error(
				`the parent session could not come online on the intercom broker (${detail}); a Child Session's parent edge cannot be observed without it`,
			);
		}
		this.#client = client;
		logger.info("serve:delegation-owner-online", {
			parentSessionId: this.#session.sessionId,
			intercomSessionId: this.#sessionId,
		});
		return client;
	}

	/**
	 * 把子会话上报接进账本。
	 *
	 * **每次委派都要调**（`open()` 就是这么用的）：连接会掉，掉了之后 `listSessions()` 会
	 * 换一条新连接，而收口是挂在某一条**连接对象**上的。所以这里按连接判定而不是「挂过就
	 * 算」：同一条连接上重复挂会消费两遍同一条上报，换了连接不重挂就一条都收不到。
	 */
	attachReports(sink: ChildSessionReportSink): void {
		const client = this.#client;
		if (!client) throw new Error("delegation owner is not online; reports cannot be attached");
		if (!client.isConnected()) {
			throw new Error(
				"the parent session's intercom connection dropped; a child session's reports would have no listener",
			);
		}
		if (this.#reports?.client === client) return;
		// 旧连接上那一条先摘掉：它已经不再投递任何消息，留着只是让「哪条连接在收」有第二个答案。
		this.#reports?.detach();
		this.#reports = { client, detach: attachChildSessionReports(client, sink) };
	}

	#registration(): SessionRegistration {
		return {
			name: `${this.#meta.name} · delegation`,
			cwd: this.#session.sessionManager.getCwd(),
			model: this.#session.model?.id ?? "unknown",
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
			status: "delegating",
			runtimeFallbackAlias: false,
		};
	}
}

/**
 * 打包内嵌的 cornfield 目录。
 *
 * serve 不是 Electron 主进程，正常取不到 `resourcesPath`（空串 = 跳过这条来源，落到安装位/
 * dev 构建/PATH）。这一段注释就是它存在的理由：不能悄悄把相对路径当打包目录用。
 */
function packagedResourcesPath(): string {
	const value = (process as { resourcesPath?: string }).resourcesPath;
	return typeof value === "string" ? value : "";
}

/** 真实 serve 宿主：真 supervisor（真注册门）+ 真子进程程序。 */
function createServeDelegationHost(input: DelegationHostInput): DelegationHost {
	const { session, meta, self } = input;
	const parentId = self.intercomSessionId ?? self.sessionId;
	const presence = new ServeIntercomPresence({ session, meta, sessionId: parentId });
	// 注册门与存活探测都读同一个连接的同一份花名册：父边只有一条，「子进程是否挂在这条边上」
	// 与「这条边下还有哪些活进程」必须看到同一个世界。
	const manager = new SessionTreeManager({
		self,
		supervisor: new ChildSessionSupervisor({
			registration: createIntercomRegistrationProbe({ roster: presence, parentId }),
			maxConcurrent: SERVE_CHILD_CONCURRENCY,
		}),
		store: new SessionLogTreeStore(session.sessionManager),
		// 存活探测走花名册（重启后的唯一凭据），与 supervisor 的内存视图互为补充。
		liveness: createIntercomLivenessProbe({ roster: presence, parentId }),
	});
	return {
		manager,
		command: { bin: resolveCornfieldBinary(packagedResourcesPath()), args: ["--mode", "wire-stdio"] },
		async open(): Promise<void> {
			await presence.listSessions();
			presence.attachReports(manager);
		},
	};
}
