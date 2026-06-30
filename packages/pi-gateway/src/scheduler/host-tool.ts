/**
 * `cron` host tool — the LLM-callable interface to the scheduler.
 *
 * Modeled on openclaw's `cron-tool.ts` (https://github.com/openclaw/openclaw):
 *   - The gateway registers the tool definition with the OMP subprocess
 *     via the `set_host_tools` RPC command (`agent-bridge.ts`).
 *   - The OMP subprocess exposes it to the LLM as a regular `AgentTool`.
 *   - When the LLM calls `cron.add`, the OMP subprocess sends a
 *     `host_tool_call` frame back to the gateway; this module's
 *     `handleCronAction` runs locally and returns the result.
 *
 * **Delivery auto-inference** (D4): when the LLM omits the `delivery`
 * field, the handler reads the bridge's active chat context and
 * infers `{channel, toUserId}` for DM or `{channel, toConversationId}`
 * for group. The LLM can override any of those fields by passing an
 * explicit `delivery` object. The LLM is **not** required to know about
 * channel registries — that lookup happens here.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { AgentBridge } from "../agent-bridge";
import type { ChannelRegistry } from "../channels/registry";
import type { HostToolHandler, HostToolResultBody, RpcHostToolDefinition } from "../host-tool-dispatcher";
import type { InboundMessage } from "../types";
import type { SchedulerDbStorage } from "./storage";
import {
	type CronDeliveryOutput,
	parseSchedule,
	type ScheduledTask,
	type TaskExecution,
	validateCronDelivery,
} from "./types";

/**
 * Context the cron tool needs at call time. Closed over from the
 * `AgentBridge` instance (which is per-account) and the gateway-wide
 * `ChannelRegistry`. The `bridge` reference is used purely to read
 * `getActiveChatContext()` for delivery auto-inference; it is not used
 * for any other RPC.
 *
 * `getStorage` is a lazy getter because the scheduler DB is created by
 * the gateway's `CronLifecycle.start()` (called after the bridge is
 * constructed). Reading at call time keeps the host tool available
 * regardless of when the storage comes online.
 */
export interface CronToolContext {
	/** Returns the active AgentBridge for delivery auto-inference. Lazy
	 *  because the bridge is constructed after the dispatcher in the
	 *  gateway's start sequence. */
	getBridge: () => import("../agent-bridge").AgentBridge;
	registry: ChannelRegistry;
	getStorage: () => import("./storage").SchedulerDbStorage | null;
	/**
	 * AccountId of the agent that owns this dispatcher instance. Stamped
	 * on every `cron.add` so the row's `createdByAccountId` audit field
	 * records which agent the conversation belonged to at create time.
	 * Always set: the OMP subprocess is per-accountId, so this is the
	 * agent's identity for the lifetime of the dispatcher.
	 */
	accountId: string;
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const CRON_TOOL_PARAMETERS = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("list"),
		Type.Literal("show"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("enable"),
		Type.Literal("disable"),
		Type.Literal("run"),
		Type.Literal("runs"),
	]),
	name: Type.Optional(Type.String({ description: "Task name (must be unique). Used by add." })),
	id: Type.Optional(Type.String({ description: "Task id. Used by update / remove / show / run / runs." })),
	schedule: Type.Optional(
		Type.String({
			description:
				"Cron expression (e.g. '0 9 * * *'), interval shorthand (e.g. '30m'), or ISO timestamp (e.g. '2026-12-31T23:59:00'). Used by add / update.",
		}),
	),
	command: Type.Optional(Type.String({ description: "Shell command. Required for shell tasks." })),
	prompt: Type.Optional(Type.String({ description: "Agent prompt. Required for agent tasks." })),
	taskType: Type.Optional(Type.Union([Type.Literal("shell"), Type.Literal("agent")])),
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	enabledToolsets: Type.Optional(Type.Array(Type.String())),
	timeoutMs: Type.Optional(Type.Number()),
	skills: Type.Optional(Type.Array(Type.String())),
	preScript: Type.Optional(Type.String()),
	agentDir: Type.Optional(Type.String()),
	repeatCount: Type.Optional(Type.Number()),
	delivery: Type.Optional(
		Type.Object({
			channel: Type.Optional(Type.String()),
			accountId: Type.Optional(Type.String()),
			toUserId: Type.Optional(Type.String()),
			toConversationId: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("none")])),
		}),
	),
});

const CRON_TOOL_DEFINITION: RpcHostToolDefinition = {
	name: "cron",
	label: "Cron",
	description:
		"Manage THIS AGENT's scheduled tasks. " +
		"\"My\" in a cron context refers to the current agent (the OMP subprocess serving this account), not the user asking. " +
		"All users in the same agent see the same task list; the agent owns its tasks. " +
		"There is no per-user or per-conversation scope — when the user asks \"我有哪些任务\" / \"what are my tasks\", " +
		"the answer is the agent's full task list, not just tasks the user created. " +
		"`createdByUserId` and `createdByAccountId` on each task are audit fields; do not use them to filter by creator. " +
		"Use `cron.list` to enumerate, then client-side filter by `createdByUserId` only if the user explicitly asks \"which tasks did I create\".\n\n" +
		"Actions: `add` / `list` / `show` / `update` / `remove` / `enable` / `disable` / `runs`.\n\n" +
		"**MANDATORY: use this host tool, NOT `bash` + `omp gateway cron ...` CLI.** Calling the CLI from bash bypasses delivery auto-inference and you will fail to set the sender's userId / conversationId correctly. The host tool reads the active chat context and fills delivery in for you. If you find yourself typing `omp gateway cron` in a `bash` call, STOP and use this tool instead.\n\n" +
		"**`add` example (DM, agent task, 18:00 daily report):**\n" +
		"```\n" +
		"cron.add({\n" +
		'  action: "add",\n' +
		'  name: "daily-1800-report",\n' +
		'  schedule: "0 18 * * *",\n' +
		'  taskType: "agent",\n' +
		'  agentDir: "/abs/path/to/agent",\n' +
		'  prompt: "汇总今日面试/候选人进展并发送给当前用户",\n' +
		"  // delivery: OMIT in DM — gateway auto-fills from active chat\n" +
		"})\n" +
		"```\n\n" +
		"**`add` rules (mandatory):**\n" +
		"- In a chat (DM or group) — OMIT the `delivery` field. The gateway auto-infers `{channel, accountId, toUserId}` for DM or `{channel, accountId, toConversationId}` for group from the active conversation. Do NOT read `gateway.json` / `BOOT.md` / call `dws` to look up the sender — let auto-inference handle it.\n" +
		"- To target a SPECIFIC user or conversation (not the active one), pass `delivery` explicitly: `{channel, toUserId}` (DM) or `{channel, toConversationId}` (group). Explicit delivery is preferred when the target differs from the active chat.\n" +
		'- For `taskType: "agent"` — `agentDir` is required and `prompt` is the agent\'s instructions (not `command`).\n' +
		'- For `taskType: "shell"` — `command` is the shell command (not `prompt`).\n' +
		"- `name` must be unique; pick a descriptive slug (e.g. `daily-1830-report`, `interview-prep-1h`).\n" +
		"- `schedule` accepts a cron expression (`0 18 * * *`), an interval (`every 30m`), or a one-shot ISO timestamp.\n" +
		"- After `add`, the tool returns the persisted task — read it back and report name / schedule / delivery / `createdByUserId` (creator) to the user verbatim.\n\n" +
		"**`update` / `show` / `remove` / `enable` / `disable` / `runs`** take `id` or `name`. The v2 schema uses `channel` / `toUserId` / `toConversationId` (NOT v1 `deliver` / `deliverUser` / `account`). " +
		"Since the agent owns its tasks, `show` / `update` / `remove` work on ANY task in the agent regardless of who created it. " +
		"`runs` returns the task's execution history (also works on any task in the agent).",
	parameters: CRON_TOOL_PARAMETERS as unknown as Record<string, unknown>,
};

/**
 * Public factory: returns the registered `cron` host tool. Called once per
 * `AgentBridge` instance at startup; the returned handler is registered
 * into the `HostToolDispatcher` and the definition is sent to OMP via
 * `set_host_tools`.
 */
export function createCronToolDefinitions(ctx: CronToolContext): HostToolHandler[] {
	return [
		{
			definition: CRON_TOOL_DEFINITION,
			handle: async args => handleCronAction(args as CronToolArgs, ctx),
		},
	];
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

interface CronToolArgs {
	action: "add" | "list" | "show" | "update" | "remove" | "enable" | "disable" | "run" | "runs";
	[key: string]: unknown;
}

async function handleCronAction(args: CronToolArgs, ctx: CronToolContext): Promise<HostToolResultBody> {
	const storage = ctx.getStorage();
	if (!storage) return errResult("cron storage is not initialized (gateway scheduler not started yet)");
	try {
		switch (args.action) {
			case "add":
				return await handleAdd(args, ctx);
			case "list":
				return ok(serializeTaskList(storage.listTasks()));
			case "show":
				return handleShow(args, storage);
			case "update":
				return await handleUpdate(args, ctx);
			case "remove":
				return handleRemove(args, storage);
			case "enable":
				return handleSetStatus(args, "active", storage);
			case "disable":
				return handleSetStatus(args, "disabled", storage);
			case "run":
				return errResult("'run' via LLM is not yet supported; use `omp gateway cron run <name>` from the CLI");
			case "runs":
				return handleRuns(args, storage);
			default:
				return errResult(`Unknown action: ${String(args.action)}`);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		logger.error("[CronTool] action failed", { action: args.action, error: message });
		return errResult(message);
	}
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function handleAdd(args: CronToolArgs, ctx: CronToolContext): Promise<HostToolResultBody> {
	const name = stringArg(args, "name");
	if (!name) return errResult("add: name is required");
	const schedule = stringArg(args, "schedule");
	if (!schedule) return errResult("add: schedule is required");

	// Parse the schedule up front so we (a) reject invalid input with a
	// clear error and (b) persist the correct scheduleType. Previously
	// we hard-coded `scheduleType: "cron"`, which worked only because
	// the engine re-parses `cron` at trigger time as a fallback
	// (`engine.ts`: `task.scheduleType ?? parsed.type ?? "cron"`).
	// Storing the wrong type made `cron.show` lie to the LLM about
	// what it had just created — e.g. a one-shot `+5m` task showed
	// `scheduleType: "cron"`.
	const parsedSchedule = parseSchedule(schedule);
	if (parsedSchedule.error) {
		return errResult(`add: invalid schedule ${JSON.stringify(schedule)}: ${parsedSchedule.error}`);
	}

	const taskType = (stringArg(args, "taskType") ?? "shell") as "shell" | "agent";
	const command = taskType === "agent" ? stringArg(args, "prompt") : stringArg(args, "command");
	if (!command) {
		return errResult(
			taskType === "agent" ? "add: prompt is required for agent tasks" : "add: command is required for shell tasks",
		);
	}

	const agentDir = stringArg(args, "agentDir");
	if (taskType === "agent" && !agentDir) {
		return errResult("add: agentDir is required for agent tasks");
	}

	const delivery = resolveDeliveryForAdd(args, ctx);
	if (delivery.kind === "error") return errResult(delivery.message);
	if (delivery.kind === "missing") {
		return errResult(
			"add: delivery is required and could not be auto-inferred (no active chat context). " +
				"Pass `delivery: {channel, toUserId}` (DM) or `{channel, toConversationId}` (group).",
		);
	}

	const createdByUserId = ctx.getBridge().getActiveChatContext()?.userId;
	const created = ctx.getStorage()!.addTask({
		name,
		cron: schedule,
		command,
		scheduleType: parsedSchedule.type,
		taskType,
		model: stringArg(args, "model"),
		provider: stringArg(args, "provider"),
		enabledToolsets: arrayArg(args, "enabledToolsets"),
		timeoutMs: numberArg(args, "timeoutMs"),
		skills: arrayArg(args, "skills"),
		preScript: stringArg(args, "preScript"),
		agentDir,
		delivery: { ...delivery.value, mode: delivery.value.mode ?? "announce" },
		repeatCount: numberArg(args, "repeatCount"),
		repeatCompleted: 0,
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		createdByUserId,
		createdByAccountId: ctx.accountId,
	});
	return ok(serializeTask(created));
}

// ---------------------------------------------------------------------------
// show / list / remove / enable / disable / runs
// ---------------------------------------------------------------------------

function handleShow(args: CronToolArgs, storage: SchedulerDbStorage): HostToolResultBody {
	const task = resolveTask(args, storage);
	if (!task) return errResult("show: task not found (pass name or id)");
	return ok(serializeTask(task));
}

function handleRemove(args: CronToolArgs, storage: SchedulerDbStorage): HostToolResultBody {
	const task = resolveTask(args, storage);
	if (!task) return errResult("remove: task not found (pass name or id)");
	storage.deleteTask(task.id);
	return ok({ removed: task.id, name: task.name });
}

function handleSetStatus(
	args: CronToolArgs,
	status: "active" | "disabled",
	storage: SchedulerDbStorage,
): HostToolResultBody {
	const task = resolveTask(args, storage);
	if (!task) return errResult(`${status}: task not found (pass name or id)`);
	storage.updateTask(task.id, { status, updatedAt: Date.now() });
	return ok({ id: task.id, name: task.name, status });
}

function handleRuns(args: CronToolArgs, storage: SchedulerDbStorage): HostToolResultBody {
	const task = resolveTask(args, storage);
	if (!task) return errResult("runs: task not found (pass name or id)");
	const limit = numberArg(args, "limit") ?? 10;
	return ok(serializeExecutions(task.id, storage.getExecutions(task.id, limit)));
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function handleUpdate(args: CronToolArgs, ctx: CronToolContext): Promise<HostToolResultBody> {
	const storage = ctx.getStorage();
	if (!storage) return errResult("cron storage is not initialized");
	const task = resolveTask(args, storage);
	if (!task) return errResult("update: task not found (pass name or id)");

	const updates: Partial<ScheduledTask> = { updatedAt: Date.now() };
	if (args.schedule !== undefined) {
		const newSchedule = String(args.schedule);
		// Mirror the validation + type-derivation in `add` so a task whose
		// schedule is updated from cron to one-shot (or vice versa) stores
		// the matching `scheduleType`. Without this, a task created with
		// `0 9 * * *` and later updated to `+5m` would still report
		// `scheduleType: "cron"` in subsequent `show` calls.
		const parsed = parseSchedule(newSchedule);
		if (parsed.error) {
			return errResult(`update: invalid schedule ${JSON.stringify(newSchedule)}: ${parsed.error}`);
		}
		updates.cron = newSchedule;
		updates.scheduleType = parsed.type;
	}
	if (args.command !== undefined) updates.command = String(args.command);
	if (args.prompt !== undefined) updates.command = String(args.prompt);
	if (args.model !== undefined) updates.model = stringArg(args, "model");
	if (args.provider !== undefined) updates.provider = stringArg(args, "provider");
	if (args.enabledToolsets !== undefined) updates.enabledToolsets = arrayArg(args, "enabledToolsets");
	if (args.timeoutMs !== undefined) updates.timeoutMs = numberArg(args, "timeoutMs");
	if (args.skills !== undefined) updates.skills = arrayArg(args, "skills");
	if (args.preScript !== undefined) updates.preScript = stringArg(args, "preScript");
	if (args.agentDir !== undefined) updates.agentDir = stringArg(args, "agentDir") ?? undefined;
	if (args.repeatCount !== undefined) updates.repeatCount = numberArg(args, "repeatCount");
	if (args.delivery !== undefined) {
		const current = task.delivery;
		const merged = {
			channel: stringArg(args.delivery as Record<string, unknown>, "channel") ?? current?.channel,
			accountId: stringArg(args.delivery as Record<string, unknown>, "accountId") ?? current?.accountId,
			toUserId: stringArg(args.delivery as Record<string, unknown>, "toUserId") ?? current?.toUserId,
			toConversationId:
				stringArg(args.delivery as Record<string, unknown>, "toConversationId") ?? current?.toConversationId,
			mode:
				(stringArg(args.delivery as Record<string, unknown>, "mode") as "announce" | "none" | undefined) ??
				current?.mode ??
				"announce",
		};
		const validated = validateCronDelivery(merged);
		if (!validated.ok) return errResult(`update: invalid delivery: ${validated.error}`);
		updates.delivery = validated.value as ScheduledTask["delivery"];
	}

	storage.updateTask(task.id, updates);
	const fresh = storage.getTask(task.id);
	return ok(serializeTask(fresh ?? task));
}

// ---------------------------------------------------------------------------
// Delivery resolution (D4 auto-inference)
// ---------------------------------------------------------------------------

type DeliveryResolution =
	| { kind: "ok"; value: CronDeliveryOutput }
	| { kind: "error"; message: string }
	| { kind: "missing" };

function resolveDeliveryForAdd(args: CronToolArgs, ctx: CronToolContext): DeliveryResolution {
	const explicit = args.delivery as Record<string, unknown> | undefined;
	if (explicit && Object.keys(explicit).length > 0) {
		const validated = validateCronDelivery({
			channel: explicit.channel,
			accountId: explicit.accountId,
			toUserId: explicit.toUserId,
			toConversationId: explicit.toConversationId,
			mode: explicit.mode,
		});
		if (!validated.ok) return { kind: "error", message: `add: invalid delivery: ${validated.error}` };
		// The registry's `get()` looks up by registration key (e.g.
		// `dingtalk:hr` for multi-account setups). The cron tool's
		// `channel` field is the channel's own `id` (e.g. `dingtalk`),
		// so fall back to scanning `getAll()` for a channel whose `id`
		// matches. This keeps the cron tool decoupled from the gateway's
		// multi-account registration convention.
		if (!ctx.registry.get(validated.value.channel)) {
			const matched = ctx.registry.getAll().some(ch => ch.id === validated.value.channel);
			if (!matched) {
				return {
					kind: "error",
					message: `add: channel "${validated.value.channel}" is not registered in the gateway's ChannelRegistry`,
				};
			}
		}
		return { kind: "ok", value: validated.value };
	}

	// Auto-infer from the active chat context. The bridge records the
	// current InboundMessage at the top of forwardWithMeta and clears it
	// at the end; outside of a user-driven prompt the context is undefined
	// (e.g. a cron trigger that itself recurses into the agent) and the
	// tool must require explicit delivery.
	const active: InboundMessage | undefined = ctx.getBridge().getActiveChatContext();
	if (!active) return { kind: "missing" };

	const inferred: Record<string, unknown> = active.isGroup
		? { channel: active.channelId, accountId: active.accountId, toConversationId: active.conversationId }
		: { channel: active.channelId, accountId: active.accountId, toUserId: active.userId };
	const validated = validateCronDelivery(inferred);
	if (!validated.ok) {
		return { kind: "error", message: `add: auto-inferred delivery failed validation: ${validated.error}` };
	}
	if (!ctx.registry.get(validated.value.channel)) {
		const matched = ctx.registry.getAll().some(ch => ch.id === validated.value.channel);
		if (!matched) {
			return {
				kind: "error",
				message: `add: active chat's channel "${validated.value.channel}" is not registered in the gateway's ChannelRegistry`,
			};
		}
	}
	return { kind: "ok", value: validated.value };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTask(args: CronToolArgs, storage: SchedulerDbStorage): ScheduledTask | undefined {
	const id = stringArg(args, "id");
	if (id) return storage.getTask(id);
	const name = stringArg(args, "name");
	if (name) return storage.getTaskByName(name);
	return undefined;
}

function stringArg(o: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!o) return undefined;
	const v = o[key];
	return typeof v === "string" ? v : undefined;
}

function numberArg(args: CronToolArgs, key: string): number | undefined {
	const v = args[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const parsed = Number(v);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function arrayArg(args: CronToolArgs, key: string): string[] | undefined {
	const v = args[key];
	if (!Array.isArray(v)) return undefined;
	return v.filter(x => typeof x === "string") as string[];
}

function ok(payload: unknown): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function errResult(message: string): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text: `error: ${message}` }],
		isError: true,
	};
}

function serializeTask(task: ScheduledTask | undefined): unknown {
	if (!task) return null;
	// Drop large/irrelevant fields for the LLM-facing payload.
	const { lastDeliveryError: _lastDeliveryError, ...rest } = task;
	return rest;
}

function serializeTaskList(tasks: ScheduledTask[]): unknown {
	return tasks.map(t => {
		const { lastDeliveryError: _lastDeliveryError, ...rest } = t;
		return rest;
	});
}

function serializeExecutions(taskId: string, execs: TaskExecution[]): unknown {
	return { taskId, executions: execs };
}
