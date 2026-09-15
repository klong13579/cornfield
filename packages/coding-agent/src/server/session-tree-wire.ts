/**
 * serve 侧的 Session Tree 桥 —— 把父会话的委派账本搬到 wire 面。
 *
 * 桥不拥有任何语义：账本、状态机、结果带回的幂等门闩都在 `../session/session-tree-manager`
 * 与 `../session/session-tree-store` 里，这里只做三件事 ——
 *
 *   1. **给一个 attached 会话配一个 manager**（`managerFor`）。必须**每会话一个**：
 *      `bringBack()` 的「第一次带回」判定与账本写锁都是实例内的，每次命令新建实例会让
 *      两次并发带回各自读到「还没带回」，于是同一条结果被注入两遍 —— 正是 `firstTime`
 *      存在的理由。
 *   2. **读**（`readSessionTree`）：`manager.records()` 会先把账本与 supervisor 对齐，
 *      再用 `SessionLogTreeStore` 的严格校验读回磁盘快照（读不出来的条目是硬错误，不是
 *      「这条不存在」）。
 *   3. **带回**（`bringBackChildResult`）：`manager.bringBack()` 解析结果指针并盖时间戳，
 *      只有 `firstTime` 时才把内容并入父会话 —— 重复带回不报错，也不再注入。
 *
 * 这台主机**不启动子会话**：wire 面的这两条命令读的是父会话的账本、写的是「已带回」，
 * 两者都是父会话自己的记账；至于「要不要委派、委派什么」，是主 Agent 的策略，没有任何
 * 客户端命令声明过它。所以这里挂的 supervisor 不会 spawn —— 探测直接拒绝，而不是假装
 * 观察到了一条并不存在的父子边（详见 `NO_LAUNCH_REGISTRATION`）。
 */

import { logger } from "@cornfield/utils";
import type { BroughtBackChildResultDto, ChildSessionNodeDto, SessionTreeDto } from "@cornfield/wire";
import type { AgentSession } from "../session/agent-session";
import type { ChildSessionRegistrationProbe } from "../session/child-session-supervisor";
import { ChildSessionSupervisor } from "../session/child-session-supervisor";
import type { ChildSessionRecord } from "../session/session-tree";
import { SessionTreeManager } from "../session/session-tree-manager";
import { SessionLogTreeStore } from "../session/session-tree-store";
import type { AgentMeta } from "./session-registry";

/** 带回的结果写进父会话时用的 custom entry 类型（与会话日志里可检索的标签同值）。 */
export const CHILD_RESULT_CUSTOM_TYPE = "child_session_result";

/** 注入父会话时打在首行的标签，与 `child-session-report` 的 `[child-session]` 同族。 */
const CHILD_RESULT_TAG = "[child-session-result]";

/**
 * 这台主机不启动 Child Session。
 *
 * `ChildSessionSupervisor` 的 registration 探测是「子进程真的在 broker 上挂出了父边」的
 * 唯一证据；没有 broker 的宿主可以显式传 no-op 探测。这里两者都不是：wire 面从不委派，
 * 所以返回一个**拒绝**的探测 —— 万一有人从这里走到 `delegate()`，他拿到的是一句说清
 * 原因的错误，而不是一个没人能寻址、却显示为 started 的子会话。
 */
const NO_LAUNCH_REGISTRATION: ChildSessionRegistrationProbe = {
	async awaitRegistration({ sessionId }): Promise<void> {
		throw new Error(
			`serve does not launch Child Sessions: "${sessionId}" was about to be delegated through the wire surface, which only reads a parent's ledger and records bring-backs`,
		);
	},
};

/**
 * 每个 attached 会话一个 manager（见文件头第 1 条 —— 这是正确性要求，不是缓存优化）。
 *
 * 会话被 detach / 重建时 `AgentSession` 换对象，WeakMap 的键随之失效，不会把旧会话的
 * 账本视图留在内存里。
 */
const managers = new WeakMap<AgentSession, SessionTreeManager>();

function managerFor(session: AgentSession, meta: AgentMeta): SessionTreeManager {
	const existing = managers.get(session);
	if (existing) return existing;
	const manager = new SessionTreeManager({
		// root/depth/project 一律不填：它们今天没有被持久化（WP1 权威表把完整树节点列为
		// 待建），编一个出来就是替会话声明一个没人记录过的身份。
		self: { sessionId: session.sessionId, agentId: meta.id },
		supervisor: new ChildSessionSupervisor({ registration: NO_LAUNCH_REGISTRATION, maxConcurrent: 1 }),
		store: new SessionLogTreeStore(session.sessionManager),
	});
	managers.set(session, manager);
	return manager;
}

/**
 * 一个 attached 会话直接委派出去的子会话。
 *
 * 只回答这一层：孙会话在子会话自己的日志里，要展开就拿子会话的 sessionId 再查一次。
 */
export async function readSessionTree(session: AgentSession, meta: AgentMeta): Promise<SessionTreeDto> {
	const records = await managerFor(session, meta).records();
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
): Promise<BroughtBackChildResultDto> {
	const brought = await managerFor(session, meta).bringBack(childSessionId);
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
