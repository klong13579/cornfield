import { describe, expect, it } from "bun:test";
import type { ThinkingLevel } from "@cornfield/agent";
import type { AgentPromptSourcesDto, WireCommand, WireCommandOfType } from "../src/commands";
import type { WireSessionIndexEntry } from "../src/frames";
import type {
	EvolvedSkillDto,
	EvolvedSkillsDto,
	GitChangeDto,
	GitChangeStateDto,
	GitChangesDto,
	MemoryFileZoneDto,
	MemoryProjectionDto,
	MemoryResolutionDto,
	MemorySessionZoneDto,
	MemoryStoreDto,
	MemoryTextFileDto,
	SkillActivation,
	SkillBlockedDto,
	SkillLoadErrorDto,
	SkillScopeFactsDto,
	SkillScopeRowDto,
	SkillStatus,
	SkillsResultDto,
} from "../src/results";
import type { AgentTodoDto } from "../src/results/agent-todos";
import type { AgentCreateDto, AgentCreateInput } from "../src/results/agents";
import type { CronCreateInput, CronUpdateInput } from "../src/results/cron";
import type {
	ProjectDeleteDto,
	ProjectListDto,
	ProjectRecordDto,
	ProjectUpsertDto,
	SessionProjectSourceDto,
} from "../src/results/projects";
import type { ChildSessionStatusDto, DelegateChildInput, DelegatedChildDto } from "../src/results/session-tree";
import type { Scope } from "../src/scope";
import type { SessionSnapshot } from "../src/snapshot";

/**
 * 协议形状锁定（P0，参照 codex schema_fixtures）：
 * - 编译期：关键命令的参数/结果形状通过类型断言锁定（tsgo 检查时生效）
 * - 运行时：命令 type 清单快照，防误删/误改名
 */

// ── 编译期形状断言（tsgo 通过 = 形状未漂移）──

type _SetModel = WireCommandOfType<"set_model">;
type _AssertSetModel = _SetModel extends { type: "set_model"; provider: string; modelId: string } ? true : never;
const _setModelShape: _AssertSetModel = true;

type _Prompt = WireCommandOfType<"prompt">;
type _AssertPrompt = _Prompt extends { type: "prompt"; message: string } ? true : never;
const _promptShape: _AssertPrompt = true;

type _GetStats = WireCommandOfType<"get_stats">;
type _AssertStats = _GetStats extends { type: "get_stats"; period?: "1d" | "7d" | "30d" | "90d" | "all" }
	? true
	: never;
const _statsShape: _AssertStats = true;

type _InstallRemote = WireCommandOfType<"install_remote_skill">;
type _AssertInstallRemote = _InstallRemote extends {
	type: "install_remote_skill";
	source: string;
	name: string;
}
	? true
	: never;
const _installRemoteShape: _AssertInstallRemote = true;

type _McpSet = WireCommandOfType<"set_mcp_server">;
type _AssertMcpSet = _McpSet extends {
	type: "set_mcp_server";
	name: string;
	command?: string;
	args?: string[];
	enabled?: boolean;
}
	? true
	: never;
const _mcpSetShape: _AssertMcpSet = true;

type _ModelCatalog = WireCommandOfType<"get_model_catalog">;
type _AssertModelCatalog = _ModelCatalog extends { type: "get_model_catalog"; sessionId?: string } ? true : never;
const _modelCatalogShape: _AssertModelCatalog = true;

type _SaveProviderKey = WireCommandOfType<"save_provider_api_key">;
type _AssertSaveProviderKey = _SaveProviderKey extends {
	type: "save_provider_api_key";
	providerId: string;
	apiKey: string;
}
	? true
	: never;
const _saveProviderKeyShape: _AssertSaveProviderKey = true;

type _DisconnectProvider = WireCommandOfType<"disconnect_provider">;
type _AssertDisconnectProvider = _DisconnectProvider extends {
	type: "disconnect_provider";
	providerId: string;
	force?: boolean;
}
	? true
	: never;
const _disconnectProviderShape: _AssertDisconnectProvider = true;

type _SetConfigScoped = WireCommandOfType<"set_config">;
type _AssertSetConfigScoped = _SetConfigScoped extends {
	type: "set_config";
	key: string;
	value: unknown;
	scope?: "global" | "project";
}
	? true
	: never;
const _setConfigScopedShape: _AssertSetConfigScoped = true;

type _TestModel = WireCommandOfType<"test_model">;
type _AssertTestModel = _TestModel extends {
	type: "test_model";
	providerId: string;
	modelId: string;
}
	? true
	: never;
const _testModelShape: _AssertTestModel = true;

type _RefreshCatalog = WireCommandOfType<"refresh_catalog">;
type _AssertRefreshCatalog = _RefreshCatalog extends { type: "refresh_catalog" } ? true : never;
const _refreshCatalogShape: _AssertRefreshCatalog = true;

type _GetSessionTree = WireCommandOfType<"get_session_tree">;
type _AssertGetSessionTree = _GetSessionTree extends { type: "get_session_tree"; sessionId?: string } ? true : never;
const _getSessionTreeShape: _AssertGetSessionTree = true;

type _BringBackChildResult = WireCommandOfType<"bring_back_child_result">;
type _AssertBringBackChildResult = _BringBackChildResult extends {
	type: "bring_back_child_result";
	sessionId?: string;
	childSessionId: string;
}
	? true
	: never;
const _bringBackChildResultShape: _AssertBringBackChildResult = true;

type _DelegateChild = WireCommandOfType<"delegate_child">;
// 入参形状就是 pi-wire 的 canonical `DelegateChildInput`：命令面与 DTO 面不各自长一份。
const _delegateChildShape: _Equal<
	_DelegateChild,
	{ id?: string; type: "delegate_child"; sessionId?: string } & DelegateChildInput
> = true;

// 成功回执的形状即「一条真的在跑的子会话」：id/runId/status 三者缺一不可，
// 否则客户端拿不到账本节点的身份，也无法区分「已启动」与「已有结果」。
type _DelegatedChild = DelegatedChildDto;
type _AssertDelegatedChild = _DelegatedChild extends {
	sessionId: string;
	runId: string;
	status: ChildSessionStatusDto;
	agentId: string;
}
	? true
	: never;
const _delegatedChildShape: _AssertDelegatedChild = true;

type _ListProjects = WireCommandOfType<"list_projects">;
type _AssertListProjects = _ListProjects extends { type: "list_projects"; sessionId?: string } ? true : never;
const _listProjectsShape: _AssertListProjects = true;

type _SetProject = WireCommandOfType<"set_project">;
type _AssertSetProject = _SetProject extends {
	type: "set_project";
	projectId: string;
	name: string;
	root: string;
	defaultAgentId?: string;
}
	? true
	: never;
const _setProjectShape: _AssertSetProject = true;

type _DeleteProject = WireCommandOfType<"delete_project">;
type _AssertDeleteProject = _DeleteProject extends { type: "delete_project"; projectId: string } ? true : never;
const _deleteProjectShape: _AssertDeleteProject = true;

// 写面的答复形状：声明回「存储里现在那一份」（不是发出去的那份 `root`），
// 删除回「真的删掉了哪一个」—— 没有 `deleted` 标记位（没声明过就是 ok:false）。
type _AssertProjectUpsertDto = ProjectUpsertDto extends { project: ProjectRecordDto } ? true : never;
const _projectUpsertDtoShape: _AssertProjectUpsertDto = true;

type _AssertProjectDeleteDto = ProjectDeleteDto extends { projectId: string } ? true : never;
const _projectDeleteDtoShape: _AssertProjectDeleteDto = true;

type _ListAgentTodos = WireCommandOfType<"list_agent_todos">;
type _AssertListAgentTodos = _ListAgentTodos extends { type: "list_agent_todos"; sessionId?: string } ? true : never;
const _listAgentTodosShape: _AssertListAgentTodos = true;

type _SetAgentTodo = WireCommandOfType<"set_agent_todo">;
type _AssertSetAgentTodo = _SetAgentTodo extends {
	type: "set_agent_todo";
	sessionId?: string;
	todo: AgentTodoDto;
}
	? true
	: never;
const _setAgentTodoShape: _AssertSetAgentTodo = true;

type _DeleteAgentTodo = WireCommandOfType<"delete_agent_todo">;
type _AssertDeleteAgentTodo = _DeleteAgentTodo extends {
	type: "delete_agent_todo";
	sessionId?: string;
	todoId: string;
}
	? true
	: never;
const _deleteAgentTodoShape: _AssertDeleteAgentTodo = true;

// F1：建 agentDir（create_agent）—— 入参是 `AgentCreateInput`，答复是 `InitResult` 的 wire 投影。
// `created` 必须在答复里：同名目录本来就在是**成功且增量补齐**，不是错误，调用方靠这一位分开。
type _CreateAgent = WireCommandOfType<"create_agent">;
type _AssertCreateAgent = _CreateAgent extends {
	type: "create_agent";
	name: string;
	dir?: string;
	mission?: string;
	template?: string;
}
	? true
	: never;
const _createAgentShape: _AssertCreateAgent = true;

type _AssertAgentCreateInput = AgentCreateInput extends { name: string } ? true : never;
const _agentCreateInputShape: _AssertAgentCreateInput = true;

type _AssertAgentCreateDto = AgentCreateDto extends {
	name: string;
	agentDir: string;
	created: boolean;
	filesWritten: number;
}
	? true
	: never;
const _agentCreateDtoShape: _AssertAgentCreateDto = true;

// ── T10B：Skills / Memory 工作台的 scope 契约 ──
type _GetMemory = WireCommandOfType<"get_memory">;
type _AssertGetMemory = _GetMemory extends { type: "get_memory"; sessionId?: string } ? true : never;
const _getMemoryShape: _AssertGetMemory = true;
const _memoryTargetShape: _GetMemory = { type: "get_memory", sessionId: "agent" };

type _GetSkills = WireCommandOfType<"get_skills">;
type _AssertGetSkills = _GetSkills extends { type: "get_skills"; sessionId?: string } ? true : never;
const _getSkillsShape: _AssertGetSkills = true;

type _SetSkillEnabled = WireCommandOfType<"set_skill_enabled">;
type _AssertSetSkillEnabled = _SetSkillEnabled extends {
	type: "set_skill_enabled";
	sessionId?: string;
	name: string;
	enabled: boolean;
}
	? true
	: never;
const _setSkillEnabledShape: _AssertSetSkillEnabled = true;

type _SkillRow = SkillScopeRowDto;
type _AssertSkillRow = _SkillRow extends {
	name: string;
	source: string;
	level: "user" | "project" | "native";
	provider: string;
	path: string;
	scope: Scope;
	activation: SkillActivation;
	status: SkillStatus;
}
	? true
	: never;
const _skillRowShape: _AssertSkillRow = true;

type _SkillsResult = SkillsResultDto;
type _AssertSkillsResult = _SkillsResult extends {
	skills: SkillScopeRowDto[];
	disabled: SkillScopeRowDto[];
	blocked: SkillBlockedDto[];
	errors: SkillLoadErrorDto[];
	scope: SkillScopeFactsDto;
}
	? true
	: never;
const _skillsResultShape: _AssertSkillsResult = true;

type _MemoryProjection = MemoryProjectionDto;
type _AssertMemoryProjection = _MemoryProjection extends {
	user: MemoryTextFileDto | null;
	userError?: string;
	agent: MemoryFileZoneDto | null;
	project: MemoryFileZoneDto | null;
	session: MemorySessionZoneDto | null;
	memoryStore: MemoryStoreDto;
	resolution: MemoryResolutionDto;
}
	? true
	: never;
const _memoryProjectionShape: _AssertMemoryProjection = true;

// ── git_changes / get_evolved_skills（T12）：两条命令 + 两个新形状 + 降级通道 ──
type _GitChanges = WireCommandOfType<"git_changes">;
type _AssertGitChanges = _GitChanges extends { type: "git_changes"; sessionId?: string } ? true : never;
const _gitChangesShape: _AssertGitChanges = true;

type _GetEvolvedSkills = WireCommandOfType<"get_evolved_skills">;
type _AssertGetEvolvedSkills = _GetEvolvedSkills extends { type: "get_evolved_skills"; sessionId?: string }
	? true
	: never;
const _getEvolvedSkillsShape: _AssertGetEvolvedSkills = true;

// 改动是**两条轴**：X（HEAD→index）与 Y（index→worktree）各自可以为空。
// 合成一个 status 就会把「已 staged 又改了一版」（porcelain `MM`）压成一种。
const _gitChangeShape: _Equal<
	GitChangeDto,
	{ path: string; oldPath?: string; index: GitChangeStateDto | null; worktree: GitChangeStateDto | null }
> = true;

// 清单**必填**：读失败只能走 ok:false（或同一张答复里的 error），
// 不许把它表达成「省掉 changes」或「空 changes」。
const _gitChangesListRequired: _Equal<Pick<GitChangesDto, "changes">, { changes: GitChangeDto[] }> = true;
const _gitChangesError: _Equal<GitChangesDto["error"], string | undefined> = true;

// 演化技能是 self-evolution 的 `EvolvedSkill` 投影：提炼结果 + 使用统计都要留住。
const _evolvedSkillShape: _Equal<
	Pick<EvolvedSkillDto, "name" | "taskPattern" | "approach" | "tools" | "pitfalls" | "version">,
	{
		name: string;
		taskPattern: string;
		approach: string;
		tools: string[];
		pitfalls: string[];
		version: number;
	}
> = true;
const _evolvedSkillsListRequired: _Equal<Pick<EvolvedSkillsDto, "skills">, { skills: EvolvedSkillDto[] }> = true;
const _evolvedSkillsError: _Equal<EvolvedSkillsDto["error"], string | undefined> = true;

// ── T10C：调度写命令使用 canonical 输入，不能丢失 Agent 绑定与可靠性字段 ──
type _CronCreate = WireCommandOfType<"cron_create">;
type _CronUpdate = WireCommandOfType<"cron_update">;
type _CronRemove = WireCommandOfType<"cron_remove">;
type _CronTestRun = WireCommandOfType<"cron_test_run">;
type _Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _cronCreateShape: _Equal<_CronCreate, { id?: string; type: "cron_create" } & CronCreateInput> = true;
const _cronUpdateShape: _Equal<_CronUpdate, { id?: string; type: "cron_update"; taskId: string } & CronUpdateInput> =
	true;
const _cronRemoveShape: _Equal<_CronRemove, { id?: string; type: "cron_remove"; taskId: string }> = true;
const _cronTestRunShape: _Equal<_CronTestRun, { id?: string; type: "cron_test_run"; name: string; inMs?: number }> =
	true;

// ── T24：会话归属（projectId 的权威形状） ──

// new_session 的 projectId 可选：缺省 = 这个会话没有声明归属（与今天行为一致），
// 不是「落回启动根」；给了就必须能被 serve 解出根，解不出走 ok:false。
const _newSessionShape: _Equal<
	WireCommandOfType<"new_session">,
	{ id?: string; type: "new_session"; sessionId?: string; parentSession?: string; projectId?: string }
> = true;

// list_sessions 投影与会话快照都带**权威** projectId（会话头里那一份）；未记录 = undefined，
// 不拿 cwd 反推一个 —— 归属是记录下来的事实，不是投影端按路径猜出来的。
const _sessionIndexProjectId: _Equal<WireSessionIndexEntry["projectId"], string | undefined> = true;
const _sessionSnapshotProjectId: _Equal<SessionSnapshot["projectId"], string | undefined> = true;

// ── T27：归属投影的来源（list_projects 的 currentProjectSource） ──

// 归属三档：会话记的 / 按 cwd 算的 / 没人声明过；字段缺省 = 没问过（没有会话可查）。
// 这里是手抄的一份形状（与 coding-agent 的 `ProjectSource` 同形）—— 漂了就是两个包在说两件事。
const _projectSourceShape: _Equal<SessionProjectSourceDto, "session" | "cwd" | "none"> = true;
const _projectListSourceShape: _Equal<ProjectListDto["currentProjectSource"], SessionProjectSourceDto | undefined> =
	true;

// ── F3：thinking 档位的写盘开关（看板选了不落盘 → 重启回退） ──

// persist 可选（老客户端不带 = 只改会话，行为不变）；带了就真的落到 <agentDir>/config.yml。
const _setThinkingShape: _Equal<
	WireCommandOfType<"set_thinking_level">,
	{ id?: string; type: "set_thinking_level"; sessionId?: string; level: ThinkingLevel; persist?: boolean }
> = true;

// ── F5：agentDir 的 prompt 源清单（单一真相） ──

const _getAgentPromptSourcesShape: _Equal<
	WireCommandOfType<"get_agent_prompt_sources">,
	{ id?: string; type: "get_agent_prompt_sources"; sessionId?: string }
> = true;

// `exists` 是必报字段（不是可选）：缺的源也得报出「它不存在」，否则调用方无从发现缺失。
const _agentPromptSourceShape: _Equal<
	AgentPromptSourcesDto["sources"][number],
	{ path: string; title: string; description: string; exists: boolean }
> = true;

// ── 运行时命令清单快照 ──

const COMMAND_TYPES = [
	// multiplex
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"send_user_message",
	"send_custom_message",
	"get_state",
	"set_todos",
	"set_host_tools",
	"set_active_tools",
	"set_model",
	"set_model_temporary",
	"cycle_model",
	"get_available_models",
	"get_available_thinking_levels",
	"cycle_role_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_plan_mode",
	"send_plan_mode_context",
	"set_plan_reference",
	"set_slash_commands",
	"compact",
	"set_auto_compaction",
	"abort_compaction",
	"abort_branch_summary",
	"run_idle_compaction",
	"set_auto_retry",
	"abort_retry",
	"reload",
	"handoff",
	"run_ephemeral_turn",
	"execute_python",
	"abort_python",
	"get_session_stats",
	"switch_session",
	"branch",
	"fork_from",
	"undo_exchange",
	"retry_from",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_tool",
	"get_async_job_snapshot",
	"format_session_as_text",
	"get_display_context",
	"resolve_role_model",
	// extension
	"subscribe",
	"unsubscribe",
	"get_snapshot",
	"attach",
	"detach",
	"list_agents",
	"create_agent",
	"list_sessions",
	"get_session_messages",
	"fs_list",
	"fs_read",
	"fs_read_image",
	"gateway_status",
	"get_stats",
	"get_memory",
	"get_skills",
	"cancel_queued",
	"list_commands",
	"get_cron_tasks",
	"get_cron_logs",
	// 定时任务写面（T10C）
	"cron_create",
	"cron_update",
	"cron_remove",
	"cron_test_run",
	"set_skill_enabled",
	"set_model_disabled",
	"inject_permission",
	"permission_respond",
	"record_transcribe",
	"record_transcribe_begin",
	"record_transcribe_chunk",
	"record_transcribe_end",
	"listen_list",
	"list_artifacts",
	// 会话诊断（P5）
	"diagnose_session",
	"list_diagnosis_reports",
	"get_diagnosis_report",
	"aggregate_diagnosis",
	// P0 收口（skill hub + MCP）
	"list_remote_skills",
	"install_remote_skill",
	"get_mcp_servers",
	"set_mcp_server",
	"remove_mcp_server",
	"test_mcp_server",
	// P2 纳入（bridge 专有命令）
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"bash",
	"abort_bash",
	"set_disabled_toolsets",
	"export_html",
	// 票 01+02+03（fs 写 / git 最小集 / 配置读写）
	"fs_write",
	"fs_edit",
	"fs_diff",
	"git_status",
	"git_diff",
	"git_log",
	"git_show",
	"git_branches",
	"get_config",
	"set_config",
	"get_tool_switches",
	"get_agent_prompt_sources",
	// 模型控制中心（#02 全量目录 / #03 Provider 接入 / #05 配置作用域）
	"get_model_catalog",
	"get_providers",
	"get_provider",
	"start_provider_oauth",
	"complete_provider_oauth",
	"save_provider_api_key",
	"delete_provider_api_key",
	"set_provider_base_url",
	"disconnect_provider",
	"refresh_provider",
	"refresh_catalog",
	"test_model",
	"get_config_scope",
	"restore_config_inheritance",
	"get_model_selection",
	// Session Tree（T8）：父会话对被委派子会话的账本读取与结果带回
	"get_session_tree",
	"bring_back_child_result",
	// Session Tree（T8 写入口）：从父会话真的委派一个子会话
	"delegate_child",
	// Project（T8）：客户端级 Project registry
	"list_projects",
	"set_project",
	"delete_project",
	// Agent Todo（T10A）：Agent 级 Todo 板
	"list_agent_todos",
	"set_agent_todo",
	"delete_agent_todo",
	// 右栏 Changes / 技能页演化分组（T12）：读不到了走 ok:false，不拿空清单冒充
	"git_changes",
	"get_evolved_skills",
] as const satisfies readonly string[];

/** 从 WireCommand union 提取 type 字面量（编译期核对清单）。 */
type AllCommandTypes = WireCommand["type"];
type Missing = Exclude<AllCommandTypes, (typeof COMMAND_TYPES)[number]>;
type Extra = Exclude<(typeof COMMAND_TYPES)[number], AllCommandTypes>;
const _noMissing: Missing extends never ? true : never = true;
const _noExtra: Extra extends never ? true : never = true;

describe("WireCommand shape lock", () => {
	it("exposes the full command surface", () => {
		expect(COMMAND_TYPES.length).toBeGreaterThanOrEqual(55);
		expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length); // no duplicates
	});

	it("git_changes：降级答复不作废 payload，且空清单不带 error", () => {
		const degraded: GitChangesDto = {
			repoRoot: "/repo",
			changes: [{ path: "a.ts", index: "modified", worktree: null }],
			error: "untracked 枚举被上限截断",
		};
		expect(degraded.error).toBe("untracked 枚举被上限截断");
		expect(degraded.changes).toHaveLength(1);

		// 「工作区确实干净」不带 error —— 它与「有一项没读到」必须能分开。
		const clean: GitChangesDto = { repoRoot: "/repo", changes: [] };
		expect(clean.error).toBeUndefined();
		expect(clean.changes).toEqual([]);
	});

	it("GitChangeDto：未跟踪只落在 worktree 轴，另一轴是 null 而不是空串", () => {
		const untracked: GitChangeDto = { path: "new.ts", index: null, worktree: "untracked" };
		expect(untracked.index).toBeNull();
		expect(untracked.worktree).toBe("untracked");

		// 两轴同时有值（porcelain `MM`）：staged 与工作区各算一件事，不能合成一个。
		const bothAxes: GitChangeDto = { path: "b.ts", index: "modified", worktree: "modified" };
		expect(bothAxes.index).toBe("modified");
		expect(bothAxes.worktree).toBe("modified");

		// rename 的来源路径与目标路径是两个事实。
		const renamed: GitChangeDto = { path: "new.ts", oldPath: "old.ts", index: "renamed", worktree: null };
		expect(renamed.oldPath).toBe("old.ts");
	});

	it("get_evolved_skills：空清单与读失败分开表达", () => {
		const empty: EvolvedSkillsDto = { skills: [] };
		expect(empty.error).toBeUndefined();

		const degraded: EvolvedSkillsDto = {
			skills: [
				{
					name: "s",
					description: "",
					taskPattern: "",
					approach: "",
					tools: [],
					pitfalls: [],
					version: 1,
					createdAt: 0,
					usageCount: 0,
					lastUsedAt: 0,
					successCount: 0,
					failureCount: 0,
				},
			],
			error: "1 行的 tools 列解析失败",
		};
		expect(degraded.skills).toHaveLength(1);
		expect(degraded.error).toContain("解析失败");
	});

	it("list_projects：归属来源三态可分（没问过 / 问了没有 / 有归属）", () => {
		const unasked: ProjectListDto = { projects: [] };
		const askedNone: ProjectListDto = { projects: [], currentProjectSource: "none" };
		const bound: ProjectListDto = { projects: [], currentProjectId: "dtc", currentProjectSource: "session" };

		// 「没问过」连字段都不出现：调用方不得把它渲染成「问了、没有」。
		expect("currentProjectSource" in unasked).toBe(false);
		expect(askedNone.currentProjectSource).toBe("none");
		expect(bound.currentProjectSource).toBe("session");
	});

	it("get_agent_prompt_sources：缺的那项也留在清单里（exists 逐项必报）", () => {
		const dto: AgentPromptSourcesDto = {
			sources: [
				{ path: "AGENTS.md", title: "硬约束与文件地图", description: "启动时无条件读。", exists: true },
				{ path: "TODO.md", title: "当前任务看板", description: "随进展更新。", exists: false },
			],
		};
		// 不存在的源没被裁掉 —— 调用方正是靠它看出「该建哪个」。
		expect(dto.sources.map(source => source.exists)).toEqual([true, false]);
		expect(dto.sources.map(source => source.path)).toEqual(["AGENTS.md", "TODO.md"]);
	});

	it("covers every type in the union at compile time", () => {
		// 编译期 _noMissing/_noExtra 断言；运行时只验证清单自洽。
		expect(COMMAND_TYPES).toContain("set_mcp_server");
		expect(COMMAND_TYPES).toContain("list_remote_skills");
		// F1：建 agentDir —— 有了它，前端能建 agent，而不是只能走 CLI
		expect(COMMAND_TYPES).toContain("create_agent");
		expect(COMMAND_TYPES).toContain("listen_list");
		expect(COMMAND_TYPES).toContain("set_agent_todo");
		expect(COMMAND_TYPES).toContain("delegate_child");
		expect(COMMAND_TYPES).toContain("set_project");
		expect(COMMAND_TYPES).toContain("delete_project");
		expect(COMMAND_TYPES).toContain("git_changes");
		expect(COMMAND_TYPES).toContain("get_evolved_skills");
		expect(COMMAND_TYPES).toContain("get_agent_prompt_sources");
	});
});
