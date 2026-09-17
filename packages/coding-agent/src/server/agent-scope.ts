/**
 * Agent scope 锚点解析（WP10 · T10B）。
 *
 * Skills / Memory 工作台要显示「这是谁的、在哪个 Project、按哪个会话根算」，这些事实必须来自
 * 既有解析器，一处推导 —— 两处推导不一致时，页面会读一个 Agent、显示另一个的路径：
 *
 *   agentDir            哪个目录是它的家 —— `resolveAgentRuntimeDir`（本文件唯一的推导；default agent
 *                       的 meta.agentDir 是 serve 进程 cwd，不是它的家）
 *   会话根 sessionCwd    已 attach 会话的 cwd（= registry agent 的 agentDir；未 attach 时按 agentDir 推算）
 *   配置/记忆项目根      已 attach = 那个会话活着的 `Settings#getCwd()`（按 agent 身份解析：default 在
 *                       serve 里是它的家）；未 attach = 它的家 / agentDir。记忆的 canonical 根与
 *                       config 的 project 层是同一个根，两者不许各报一个
 *   Project             已 attach = 会话的归属，`session/session-workspace` 判（会话头记的
 *                       `projectId` 权威，旧会话才按 cwd 匹配回落）；未 attach = 按 agentDir 这条
 *                       声明过的替身目录匹配（没有会话可问，来源如实标 `cwd`）
 *   声明的记忆目录        WP1 `deriveWorkspaceContext`（本模块不重新推导，只调用）
 *
 * 失败模型：归属解析不出来（注册表读坏了 / 会话记的 Project 注册表里没有 / 声明文件读不出）
 * 不是「未归属」—— 记 `projectError`，让调用方少报一个 scope 而不是编一个。
 */

import { getDefaultAgentHome, logger } from "@cornfield/utils";
import { findAgentRecord, loadAgentDirectory } from "../agent-domain/agent-directory";
import { deriveWorkspaceContext } from "../agent-domain/default-agent";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { AgentRecord, ProjectId, ProjectRecord, ProjectSource } from "../agent-domain/types";
import { resolveSessionWorkspace, type SessionWorkspaceSource } from "../session/session-workspace";
import { readWorkspaceDeclaration } from "../skeleton/workspace";
import type { AgentMeta, AttachedSession } from "./session-registry";

/** default agent 的注册 id（serve 启动时自建，P1 语义）。 */
export const DEFAULT_AGENT_ID = "default";

export interface AgentScopeAnchor {
	agentId: string;
	/** Agent 的物理 home（技能扫描、记忆轮换都以它为界）。 */
	agentDir: string;
	/** 会话根：项目级技能/记忆的判定依据。 */
	sessionCwd: string;
	/**
	 * 配置/记忆的**项目根**（`Settings#getCwd()`）：config 的 project 层与记忆的 canonical 根都落
	 * 在它下面。它是 f(Agent 身份) —— default Agent 在 serve 里 = 它的家，registry agent = 会话的
	 * 工作根 —— 而 `sessionCwd` 是「会话在哪干活」，两者不能互相替代（default 会话在工作中，
	 * 配置根却是它自己的家）。未 attach 时退化成 `agentDir`。
	 */
	configRoot: string;
	/** 本会话的 session 文件（未 attach = undefined）。 */
	sessionFile?: string;
	/** 是否已 attach（false 时 sessionCwd 是按 agentDir 推算的）。 */
	attached: boolean;
	/** 会话所属 Project（未归属 = undefined）。 */
	project?: ProjectRecord;
	/**
	 * 那个归属是怎么来的（`"session"` = 会话头记的权威值，`"cwd"` = 按目录算的，
	 * `"none"` = 问了，没有任何东西声明过）。未 attach 时 `sessionCwd` 是 agentDir 的替身，
	 * 这里的 `"cwd"` 说的就是「按目录算的」，不是「会话的 cwd」。
	 */
	projectSource?: ProjectSource;
	/** 归属解析不出来时的原因（有值 = 归属未知，不是未归属）。 */
	projectError?: string;
	/** WP1 `WorkspaceContext.memoryDir`（agentDir 声明了才有）。 */
	declaredMemoryDir?: string;
}

/**
 * Agent 进程的运行目录（sdk 的 `agentDir`、`CORNFIELD_AGENT_DIR`）—— 「这个 Agent 是谁」的唯一决定者。
 *
 * 一处推导，两个调用方：本模块的 scope 锚点，以及委派子会话的服务端（`./session-tree-wire`，它必须把
 * 子进程的家交给子进程）。规则只有一条 —— default agent 是 serve 自己，它的家是全局 agent 目录；
 * 其余 Agent 的家是 registry 声明的那个目录（`AgentMeta.agentDir`）。
 *
 * `undefined` = 解析不出来，**不是**「那就用别人的家」：一个未说明家的非 default Agent 没有运行目录，
 * 调用方要么自己给出缺省（本模块的锚点），要么如实报错（委派不能把子进程放进一个不是那个 Agent 的家里）。
 */
export function resolveAgentRuntimeDir(input: { agentId: string; agentDir?: string }): string | undefined {
	if (input.agentId === DEFAULT_AGENT_ID) return getDefaultAgentHome();
	return input.agentDir?.trim() || undefined;
}

export interface ResolveAgentScopeInput {
	agentId: string;
	/** registry 元数据（未知 agent = undefined）。 */
	meta?: AgentMeta;
	/** 已 attach 的会话（未 attach = undefined）。 */
	attached?: AttachedSession;
}

/** 解析焦点 Agent 的 scope 锚点。不抛：读不到的每一块都有明确的缺省与原因。 */
export async function resolveAgentScope(input: ResolveAgentScopeInput): Promise<AgentScopeAnchor> {
	const { agentId, meta, attached } = input;
	const agentDir = resolveAgentRuntimeDir({ agentId, agentDir: meta?.agentDir }) ?? getDefaultAgentHome();
	const sessionCwd = attached?.session.sessionManager.getCwd() ?? agentDir;
	// 配置/记忆的项目根问会话活着的那份 Settings（不在本模块重推一份身份规则）。
	const configRoot = attached?.session.settings.getCwd() ?? agentDir;
	const anchor: AgentScopeAnchor = {
		agentId,
		agentDir,
		sessionCwd,
		configRoot,
		attached: attached !== undefined,
	};
	const sessionFile = attached?.session.sessionFile;
	if (sessionFile) anchor.sessionFile = sessionFile;

	const projects = await loadProjectRecords(anchor);
	if (projects.error) {
		anchor.projectError = projects.error;
	} else if (projects.records) {
		// 有会话就问 resolver（归属的唯一判定），没有就按 agentDir 这条声明过的替身目录匹配。
		const attributed: AttributedProject = attached
			? await attributedProject(attached.session.sessionManager, agentDir)
			: {
					ok: true,
					projectId: matchProjectForPath(projects.records, agentDir)?.projectId,
					source: "cwd",
				};
		if (!attributed.ok) {
			anchor.projectError = attributed.error;
		} else {
			const record =
				attributed.projectId === undefined
					? undefined
					: projects.records.find(candidate => candidate.projectId === attributed.projectId);
			// resolver 刚在同一份注册表里认过这个 id，这一份读里却没有：注册表在两次读之间变了。
			// 少报一个不留原因的归属，会把「刚被删掉」显示成「从来没有过」。
			if (attributed.projectId !== undefined && !record) {
				anchor.projectError = `Project "${attributed.projectId}" 是这个会话记录的归属，但注册表的这次读里已经没有它。`;
			} else {
				if (record) anchor.project = record;
				anchor.projectSource = attributed.source;
			}
		}
	}

	const declared = await resolveDeclaredWorkspace(agentId, agentDir, sessionCwd, anchor.project);
	if (declared.memoryDir !== undefined) anchor.declaredMemoryDir = declared.memoryDir;
	return anchor;
}

/** 归属的判定结果：拿到了（说不定是「问了，没人声明过」）还是没拿到（带原因）。 */
type AttributedProject = { ok: true; projectId?: ProjectId; source: ProjectSource } | { ok: false; error: string };

/**
 * 已 attach 的会话：归属问 `session/session-workspace`，本模块不重写一份判定。
 *
 * 读不出来（注册表损坏 / 会话记的 Project 注册表里没有 / workspace 声明读不出）不是「未归属」：
 * 锚点记 `projectError` —— 调用方少报一个 scope，而不是编一个。
 */
async function attributedProject(session: SessionWorkspaceSource, agentDir: string): Promise<AttributedProject> {
	try {
		const workspace = await resolveSessionWorkspace({ session, agentDir });
		return { ok: true, projectId: workspace.projectId, source: workspace.projectSource };
	} catch (err) {
		logger.debug("scope:project-attribution-unresolved", {
			agentDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, error: `归属解析不出来：${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Project registry 读取：空列表是事实，读坏了是另一种事实。 */
async function loadProjectRecords(anchor: AgentScopeAnchor): Promise<{ records?: ProjectRecord[]; error?: string }> {
	try {
		return { records: await loadProjects() };
	} catch (err) {
		logger.debug("scope:project-registry-unreadable", {
			agentId: anchor.agentId,
			sessionCwd: anchor.sessionCwd,
			error: err instanceof Error ? err.message : String(err),
		});
		return { error: `Project registry 读不出来：${err instanceof Error ? err.message : String(err)}` };
	}
}

/**
 * 声明里读出来的记忆目录（来自 agentDir 的同一份声明，一次读盘）。
 *
 * 没有声明、声明读不出来、声明里没写 `knowledge.memoryDir`，三者都少报一个 memoryDir ——
 * 调用方（memory scope）的既有语义就是「声明了才算，没声明就按 legacy 候选算」。
 */
async function resolveDeclaredWorkspace(
	agentId: string,
	agentDir: string,
	sessionCwd: string,
	project?: ProjectRecord,
): Promise<{ memoryDir?: string }> {
	try {
		const entries = await loadAgentDirectory();
		const entry = findAgentRecord(entries, agentId);
		const record: AgentRecord = entry?.agent ?? {
			agentId,
			agentDir,
			displayName: agentId,
			enabled: true,
		};
		// 读模型已经读过声明的 agent 直接用它的缓存；没有（default agent / 未注册目录）才读盘。
		let declaration = entry?.declaration;
		if (!declaration) {
			const read = await readWorkspaceDeclaration(agentDir);
			if (read.state === "declared") declaration = read.declaration;
		}
		// WP1 的派生：本模块只调用，不重新推导。
		const context = deriveWorkspaceContext({
			agent: record,
			project,
			cwd: sessionCwd,
			workspaceDeclaration: declaration,
		});
		return context.memoryDir !== undefined ? { memoryDir: context.memoryDir } : {};
	} catch (err) {
		logger.debug("scope:declaration-unresolved", {
			agentId,
			agentDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return {};
	}
}
