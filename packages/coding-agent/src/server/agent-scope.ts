/**
 * Agent scope 锚点解析（WP10 · T10B）。
 *
 * Skills / Memory 工作台要显示「这是谁的、在哪个 Project、按哪个会话根算」，这些事实必须来自
 * 既有解析器，一处推导 —— 两处推导不一致时，页面会读一个 Agent、显示另一个的路径：
 *
 *   agentDir            registry 元数据（default agent 例外：它的 meta.agentDir 是 serve 进程 cwd，
 *                       不是它的家 —— 用 getAgentDir()，与 sdk.ts 的记忆扩展同源）
 *   会话根 sessionCwd    已 attach 会话的 cwd（= registry agent 的 agentDir；未 attach 时按 agentDir 推算）
 *   Project             WP4 `project-store` 的 `matchProjectForPath`（最深声明的祖先 root 获胜）
 *   声明的记忆目录        WP1 `deriveWorkspaceContext`（本模块不重新推导，只调用）
 *
 * 失败模型：Project 读坏了（存储损坏）不是「未归属」—— 记 `projectError`，让调用方少报一个
 * scope 而不是编一个。记忆目录声明读不到同理，退化为 undefined（WP1 语义：没声明就没有）。
 */

import { getAgentDir, logger } from "@cornfield/utils";
import { findAgentRecord, loadAgentDirectory } from "../agent-domain/agent-directory";
import { deriveWorkspaceContext } from "../agent-domain/default-agent";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { AgentRecord, ProjectRecord } from "../agent-domain/types";
import { loadWorkspace } from "../skeleton/workspace";
import type { AgentMeta, AttachedSession } from "./session-registry";

/** default agent 的注册 id（serve 启动时自建，P1 语义）。 */
export const DEFAULT_AGENT_ID = "default";

export interface AgentScopeAnchor {
	agentId: string;
	/** Agent 的物理 home（技能扫描、记忆轮换都以它为界）。 */
	agentDir: string;
	/** 会话根：项目级技能/记忆的判定依据。 */
	sessionCwd: string;
	/** 本会话的 session 文件（未 attach = undefined）。 */
	sessionFile?: string;
	/** 是否已 attach（false 时 sessionCwd 是按 agentDir 推算的）。 */
	attached: boolean;
	/** 会话所属 Project（未归属 = undefined）。 */
	project?: ProjectRecord;
	/** Project registry 读失败的原因（有值 = 归属未知，不是未归属）。 */
	projectError?: string;
	/** WP1 `WorkspaceContext.memoryDir`（agentDir 声明了才有）。 */
	declaredMemoryDir?: string;
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
	const agentDir = agentId === DEFAULT_AGENT_ID ? getAgentDir() : (meta?.agentDir ?? getAgentDir());
	const sessionCwd = attached?.session.sessionManager.getCwd() ?? agentDir;
	const anchor: AgentScopeAnchor = {
		agentId,
		agentDir,
		sessionCwd,
		attached: attached !== undefined,
	};
	const sessionFile = attached?.session.sessionFile;
	if (sessionFile) anchor.sessionFile = sessionFile;

	const projects = await loadProjectRecords(anchor);
	if (projects.error) anchor.projectError = projects.error;
	else if (projects.records) {
		const match = matchProjectForPath(projects.records, sessionCwd);
		if (match) anchor.project = match;
	}

	const declared = await resolveDeclaredMemoryDir(agentId, agentDir, sessionCwd, anchor.project);
	if (declared !== undefined) anchor.declaredMemoryDir = declared;
	return anchor;
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
 * WP1 的 `WorkspaceContext.memoryDir`。走 agent-directory 的读模型；agentId 不在注册表里
 * （default agent 常见）时用 registry 已知的 agentDir 构造同形记录，声明仍然只从磁盘读一次。
 */
async function resolveDeclaredMemoryDir(
	agentId: string,
	agentDir: string,
	sessionCwd: string,
	project?: ProjectRecord,
): Promise<string | undefined> {
	try {
		const entries = await loadAgentDirectory();
		const entry = findAgentRecord(entries, agentId);
		const record: AgentRecord = entry?.agent ?? {
			agentId,
			agentDir,
			displayName: agentId,
			enabled: true,
		};
		const declaration = entry?.declaration ?? (await loadWorkspace(agentDir)) ?? undefined;
		const context = deriveWorkspaceContext({
			agent: record,
			project,
			cwd: sessionCwd,
			workspaceDeclaration: declaration,
		});
		return context.memoryDir;
	} catch (err) {
		logger.debug("scope:memory-dir-unresolved", {
			agentId,
			agentDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}
