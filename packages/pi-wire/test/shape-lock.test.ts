import { describe, expect, it } from "bun:test";
import type { WireCommand, WireCommandOfType } from "../src/commands";

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
	"set_skill_enabled",
	"set_model_disabled",
	"inject_permission",
	"permission_respond",
	"record_transcribe",
	"listen_list",
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

	it("covers every type in the union at compile time", () => {
		// 编译期 _noMissing/_noExtra 断言；运行时只验证清单自洽。
		expect(COMMAND_TYPES).toContain("set_mcp_server");
		expect(COMMAND_TYPES).toContain("list_remote_skills");
		expect(COMMAND_TYPES).toContain("listen_list");
	});
});
