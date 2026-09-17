/**
 * 听记 provenance 解析（T10C）。
 *
 * 听记落盘在客户端级目录（`~/.cornfield/listen/`），所以「这条录音是谁录的、在哪个项目、哪个会话」
 * 不能在展示层猜 —— 它必须在写入时确定并随记录落盘。这个模块把「写入方手里的事实」翻译成
 * {@link ListenProvenance}，两个写入方共用：
 *
 *   serve（wire `record_transcribe*`）  agentDir/agentId 来自 agent-scope（registry + 会话）
 *   CLI / TUI（`/record`）                agentDir = getDefaultAgentHome()（default Agent 的家）
 *
 * 失败模型：Project 注册表读不出来 / cwd 匹配不到 → **不写这一项**（缺省 = 未标注），
 * 而不是写一个猜测值。写入方仍然拿到 agentDir —— 那是它确定知道的事实。
 */

import { getDefaultAgentHome, logger } from "@cornfield/utils";
import { loadProjects, matchProjectForPath } from "../agent-domain/project-store";
import type { ListenProvenance } from "./listen-service";

export interface ListenProvenanceInput {
	/** 注册表 key；CLI/TUI 没有 agent 身份时缺省。 */
	agentId?: string;
	/** Agent 的 home。缺省 = 进程自己的配置根（getDefaultAgentHome）。 */
	agentDir?: string;
	/** 归属判定用的路径（通常是会话 cwd；缺省 = agentDir）。 */
	cwd?: string;
	/** 写入时所在会话文件（serve 写入时为当前 attach 会话）。 */
	sessionFile?: string;
}

/** 写入方（CLI/TUI/serve）统一入口：确定的事实落盘，不确定的留空。 */
export async function resolveListenProvenance(input: ListenProvenanceInput = {}): Promise<ListenProvenance> {
	const agentDir = input.agentDir ?? getDefaultAgentHome();
	const provenance: ListenProvenance = { agentDir };
	if (input.agentId) provenance.agentId = input.agentId;
	if (input.sessionFile) provenance.sessionFile = input.sessionFile;

	const projectId = await resolveProjectId(input.cwd ?? agentDir);
	if (projectId) provenance.projectId = projectId;
	return provenance;
}

/** cwd → projectId（Project registry 最深的祖先 root 获胜）；读不到就没有这一项。 */
async function resolveProjectId(cwd: string): Promise<string | undefined> {
	try {
		const projects = await loadProjects();
		return matchProjectForPath(projects, cwd)?.projectId;
	} catch (err) {
		logger.debug("listen:project-attribution-unavailable", {
			cwd,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}
