import type { CronCreateInput, CronLogEntryDto, ScheduleAgentResolution, TaskRowDto } from "@cornfield/wire";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { activeAgentIdOf, activeAgentOf } from "../../state/agent-context";
import { useSessionStore } from "../../state/session-store";
import { useSession } from "../../state/use-session";
import {
	buildCronExpression,
	CRON_SCHEDULE_PRESETS,
	type CronPresetId,
	type CronPresetValues,
	cronFieldBounds,
	cronPreset,
	previewCronExpression,
	stateFromCronExpression,
} from "./cron-schedule";
import { groupTasks, isTaskInAgentScope, latestLogOf, type TaskView, taskRunProgress } from "./task-scope";

/**
 * 定时任务工作台（T10C）—— gateway scheduler 的 wire 视图。
 *
 * 数据面（写操作已接）：`get_cron_tasks` / `get_cron_logs` 读，`cron_create` / `cron_update` /
 * `cron_remove` / `cron_test_run` 写，全部经 gateway 生产端点（POST /wire）——调度器的主人是
 * gateway，前端不直连它，也不新建第二个调度器。
 *
 * ## scope（Agent / Project / Session）
 *
 * - **Agent**：一行属于谁看网关解析出来的 `agentId`（`agentResolution` 三态）。身份没解析出来的
 *   旧行只有「执行 home 就是这个 Agent 的家」才算它的 —— 见 `task-scope.ts` 的判定，不在渲染层另写一套。
 *   默认只看**当前焦点 Agent** 的任务；切到「全部 Agent」才看得到未解析/未绑定的行。
 * - **Project**：Agent 声明绑定的 Project（`projectIds` → 名字取自 Project registry）。没声明就是
 *   「未声明绑定（不受约束）」，不是「没有项目」。
 * - **Session**：一次执行落到的 OMP 会话（`CronLogEntryDto.agentSessionPath`）与投递目标会话
 *   （`delivery.toConversationId`），都从执行记录/调度定义里读，不按时间猜。
 *
 * ## 不会执行的行必须看得见
 *
 * `agentResolution: "unbound"` 或 Agent home 不在的行跑不起来（`docs/client/agent-hub.md` §1.7
 * 「无绑定 agentDir 不执行」）。这类行留在列表里、挂上原因、禁用「试跑」——而不是从列表里消失。
 *
 * 无 mock：任一数据源取不到就渲染对应空态/错误态，绝不回退假数据。
 */

function fmtRun(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ScopeMode = "agent" | "all";

export function TasksView(): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [tasks, setTasks] = useState<TaskRowDto[]>([]);
	const [logs, setLogs] = useState<CronLogEntryDto[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [logTask, setLogTask] = useState<TaskRowDto | null>(null);
	const [scopeMode, setScopeMode] = useState<ScopeMode>("agent");
	/** 正在执行的写操作 key（禁用按钮防重复提交）。 */
	const [busy, setBusy] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const focusAgentId = activeAgentIdOf(view);
	const focusAgent = activeAgentOf(view);
	const focus = useMemo(
		() => ({ agentId: focusAgentId, agentDir: focusAgent?.agentDir }),
		[focusAgentId, focusAgent?.agentDir],
	);

	useEffect(() => {
		if (!view.connected) return;
		setError(null);
		void store
			.fetchCronTasks()
			.then(r => setTasks(r.tasks))
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
		void store
			.fetchCronLogs({ days: 3, limit: 200 })
			.then(r => setLogs(r.logs))
			.catch(() => undefined);
	}, [store, view.connected, reloadToken]);

	/** 写操作统一收口：先禁用按钮 → 调命令 → 成功后重读任务表；失败把网关给的原因原样亮出来。 */
	const runAction = useCallback(async (key: string, action: () => Promise<void>, okMessage: string) => {
		setBusy(key);
		setActionError(null);
		setNotice(null);
		try {
			await action();
			setNotice(okMessage);
			setReloadToken(t => t + 1);
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}, []);

	const visibleTasks = useMemo(
		() => (scopeMode === "all" ? tasks : tasks.filter(t => isTaskInAgentScope(t, focus))),
		[tasks, scopeMode, focus],
	);
	const groups = useMemo(() => groupTasks(visibleTasks, focus), [visibleTasks, focus]);
	const projectNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const project of view.projects ?? []) map.set(project.projectId, project.name);
		return map;
	}, [view.projects]);

	return (
		<div className="px-10 pt-8 pb-12">
			<div className="mx-auto max-w-[1000px]">
				<div className="mb-7 flex items-baseline justify-between gap-4">
					<h1 className="text-[32px] font-semibold tracking-[-0.8px] text-ink">定时任务</h1>
					<div className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5">
						{(
							[
								["agent", focusAgent ? `本 Agent · ${focusAgent.name}` : "本 Agent"],
								["all", "全部 Agent"],
							] as [ScopeMode, string][]
						).map(([mode, label]) => (
							<button
								key={mode}
								type="button"
								onClick={() => setScopeMode(mode)}
								className={`rounded-md px-3 py-1.5 text-[12.5px] transition-colors ${
									scopeMode === mode ? "bg-accent text-on-accent" : "text-ink-subtle hover:text-ink"
								}`}
							>
								{label}
							</button>
						))}
					</div>
				</div>

				{actionError && (
					<div className="mb-4 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-[12.5px] leading-relaxed text-ink">
						操作失败：{actionError}
						<button type="button" className="link ml-2" onClick={() => setActionError(null)}>
							清除
						</button>
					</div>
				)}
				{notice && <div className="mb-4 text-[12px] text-ink-subtle">{notice}</div>}

				<div className="space-y-8">
					<CronFormCard
						agents={view.agents.map(a => ({ id: a.id, name: a.name }))}
						defaultAgentId={focusAgentId}
						disabled={!view.connected || busy !== null}
						onCreate={input =>
							runAction("create", async () => void (await store.cronCreate(input)), "已创建定时任务")
						}
					/>
					<TaskListCard
						groups={groups}
						totalCount={tasks.length}
						scopeMode={scopeMode}
						focusName={focusAgent?.name ?? focusAgentId}
						hasFocusAgent={focusAgentId !== undefined}
						logs={logs}
						error={error}
						connected={view.connected}
						busy={busy}
						projectNames={projectNames}
						agents={view.agents.map(a => ({ id: a.id, name: a.name }))}
						onShowLogs={setLogTask}
						onTestRun={task =>
							runAction(
								`test:${task.id}`,
								async () => {
									await store.cronTestRun(task.name);
								},
								`已排定试跑：${task.name}（跑完自行恢复原调度）`,
							)
						}
						onToggleStatus={task =>
							runAction(
								`status:${task.id}`,
								async () => {
									await store.cronUpdate(task.id, { status: task.status === "paused" ? "active" : "paused" });
								},
								task.status === "paused" ? `已启用 ${task.name}` : `已暂停 ${task.name}`,
							)
						}
						onRebind={(task, agentId) =>
							runAction(
								`rebind:${task.id}`,
								async () => {
									await store.cronUpdate(task.id, { agentId });
								},
								`已改绑 ${task.name}`,
							)
						}
						onRemove={task =>
							runAction(
								`remove:${task.id}`,
								async () => {
									await store.cronRemove(task.id);
								},
								`已删除 ${task.name}`,
							)
						}
					/>
				</div>
			</div>

			{logTask && <TaskLogPanel task={logTask} onClose={() => setLogTask(null)} />}
		</div>
	);
}

function CronFormCard({
	agents,
	defaultAgentId,
	disabled,
	onCreate,
}: {
	agents: { id: string; name: string }[];
	defaultAgentId?: string;
	disabled: boolean;
	onCreate: (input: CronCreateInput) => void;
}): React.JSX.Element {
	const [presetId, setPresetId] = useState<CronPresetId>("daily");
	const [minute, setMinute] = useState("0");
	const [time, setTime] = useState("09:00");
	const [weekday, setWeekday] = useState("1");
	const [monthDay, setMonthDay] = useState("1");
	const [raw, setRaw] = useState("");
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [taskType, setTaskType] = useState<"agent" | "shell">("agent");
	const [agentId, setAgentId] = useState(defaultAgentId ?? "");

	const preset = cronPreset(presetId) ?? CRON_SCHEDULE_PRESETS[1];

	const values: CronPresetValues = useMemo(() => {
		if (presetId === "hourly") return { minute: Number(minute) };
		const [h = "9", m = "0"] = time.split(":");
		return {
			hour: Number(h),
			minute: Number(m),
			...(presetId === "weekly" ? { weekday: Number(weekday) } : {}),
			...(presetId === "monthly" ? { monthDay: Number(monthDay) } : {}),
		};
	}, [presetId, minute, time, weekday, monthDay]);

	const expr = presetId === "custom" ? raw.trim() : buildCronExpression(presetId, values);

	const preview = useMemo(() => previewCronExpression(expr, 3), [expr]);

	// 反向识别：用户改了非 custom 字段时不做改写，仅 custom 输入合法时提示可识别预设
	const detected = useMemo(
		() => (presetId === "custom" && preview.valid ? stateFromCronExpression(expr) : null),
		[presetId, preview.valid, expr],
	);

	const canSubmit = !disabled && preview.valid && name.trim().length > 0 && command.trim().length > 0;

	const submit = () => {
		if (!canSubmit) return;
		onCreate({
			name: name.trim(),
			cron: expr,
			command: command.trim(),
			taskType,
			...(agentId ? { agentId } : {}),
		});
		setName("");
		setCommand("");
	};

	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="section-title">新建定时任务</div>

			<div className="space-y-4 px-5 pb-5">
				{/* 归属与执行内容 */}
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="cron-name" label="任务名" hint="唯一">
						<input
							id="cron-name"
							value={name}
							onChange={e => setName(e.target.value)}
							placeholder="daily-hr-attendance"
							spellCheck={false}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
						/>
					</Field>
					<Field id="cron-agent" label="执行的 Agent" hint="绑定后落盘为 resolved agentId">
						<select
							id="cron-agent"
							value={agentId}
							onChange={e => setAgentId(e.target.value)}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
						>
							<option value="">（不绑定 · 不会执行）</option>
							{agents.map(a => (
								<option key={a.id} value={a.id}>
									{a.name}（{a.id}）
								</option>
							))}
						</select>
					</Field>
				</div>

				<Field
					id="cron-command"
					label={taskType === "agent" ? "交给 Agent 的指令" : "shell 命令"}
					hint="到点执行的内容"
				>
					<textarea
						id="cron-command"
						value={command}
						onChange={e => setCommand(e.target.value)}
						rows={2}
						placeholder={taskType === "agent" ? "汇总今天的假勤并发我" : "echo hello"}
						className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
					/>
				</Field>

				<div className="flex items-center gap-3">
					<div className="flex items-center gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
						{(
							[
								["agent", "Agent 任务"],
								["shell", "shell 任务"],
							] as ["agent" | "shell", string][]
						).map(([t, label]) => (
							<button
								key={t}
								type="button"
								onClick={() => setTaskType(t)}
								className={`rounded px-2.5 py-1 text-[12px] ${taskType === t ? "bg-surface-3 text-ink" : "text-ink-subtle hover:text-ink"}`}
							>
								{label}
							</button>
						))}
					</div>
					<span className="text-[11.5px] text-ink-faint">
						Agent 任务会用该 Agent 的身份与配置拉起一个会话（执行记录挂在它自己的会话文件上）
					</span>
				</div>

				{/* 预设 */}
				<div>
					<label className="block">
						<span className="mb-1 block text-[12px] font-medium text-ink-subtle">预设</span>
						<select
							value={presetId}
							onChange={e => {
								const id = e.target.value as CronPresetId;
								setPresetId(id);
								if (id === "custom") {
									setRaw(buildCronExpression(presetId, values));
								} else if (presetId === "custom") {
									const state = stateFromCronExpression(raw);
									if (state.presetId === id) {
										if (state.values.hour !== undefined)
											setTime(
												`${String(state.values.hour).padStart(2, "0")}:${String(state.values.minute ?? 0).padStart(2, "0")}`,
											);
										if (state.values.minute !== undefined) setMinute(String(state.values.minute));
										if (state.values.weekday !== undefined) setWeekday(String(state.values.weekday));
										if (state.values.monthDay !== undefined) setMonthDay(String(state.values.monthDay));
									}
								}
							}}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
						>
							{CRON_SCHEDULE_PRESETS.map(p => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					</label>
				</div>

				{presetId !== "custom" && (
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
						{preset.fields.includes("minute") && (
							<Field id="cron-minute" label="分钟" hint="每小时的第几分钟">
								<NumberField
									id="cron-minute"
									bounds={cronFieldBounds("minute")}
									value={minute}
									onChange={setMinute}
								/>
							</Field>
						)}
						{preset.fields.includes("time") && (
							<Field id="cron-time" label="时间" hint="HH:MM">
								<input
									id="cron-time"
									type="time"
									value={time}
									onChange={e => setTime(e.target.value)}
									className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
								/>
							</Field>
						)}
						{preset.fields.includes("weekday") && (
							<Field id="cron-weekday" label="星期" hint="cron：0=周日">
								<select
									id="cron-weekday"
									value={weekday}
									onChange={e => setWeekday(e.target.value)}
									className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
								>
									{WEEKDAYS.map(w => (
										<option key={w.value} value={w.value}>
											{w.label}（{w.value}）
										</option>
									))}
								</select>
							</Field>
						)}
						{preset.fields.includes("monthDay") && (
							<Field id="cron-monthDay" label="每月第几天" hint="1-31">
								<NumberField
									id="cron-monthDay"
									bounds={cronFieldBounds("monthDay")}
									value={monthDay}
									onChange={setMonthDay}
								/>
							</Field>
						)}
					</div>
				)}

				{presetId === "custom" && (
					<Field id="cron-custom" label="cron 表达式" hint="5 字段：分 时 日 月 星期（周日=0）">
						<input
							id="cron-custom"
							value={raw}
							onChange={e => setRaw(e.target.value)}
							placeholder="0 9 * * 1-5"
							spellCheck={false}
							className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
						/>
					</Field>
				)}

				{/* 表达式 + 下次触发预览 */}
				<div className="rounded-md border border-hairline bg-surface-2 px-3 py-2.5">
					<div className="flex items-baseline justify-between">
						<div className="section-title">表达式</div>
						{preview.valid && presetId !== "custom" && (
							<div className="font-mono text-[11px] text-ink-faint">cron 表达式（预览）</div>
						)}
					</div>
					<div className="mt-1 font-mono text-[14px] text-ink">
						{expr || <span className="text-ink-faint">（空）</span>}
					</div>
					{!preview.valid && expr && (
						<div className="mt-1 text-[11.5px] text-ink-faint">表达式无效：{preview.error}</div>
					)}
					{preview.valid && preview.nextRuns.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
							{preview.nextRuns.map((ts, i) => (
								<div key={ts} className="font-mono text-[11.5px] text-ink-subtle">
									<span className="mr-1 text-ink-faint">{i === 0 ? "下次" : `第 ${i + 1} 次`}</span>
									{fmtRun(ts)}
								</div>
							))}
						</div>
					)}
					{detected && detected.presetId !== "custom" && (
						<div className="mt-1 text-[11px] text-ink-faint">
							识别为预设「{cronPreset(detected.presetId)?.label}」——切换预设可直接编辑
						</div>
					)}
				</div>

				<div className="flex items-center gap-3">
					<button type="button" disabled={!canSubmit} onClick={submit} className="btn disabled:opacity-50">
						创建任务
					</button>
					<span className="text-[11.5px] text-ink-faint">
						{!name.trim() || !command.trim()
							? "填写任务名与执行内容后可创建"
							: preview.valid
								? agentId
									? "写入 gateway scheduler（同时落盘解析后的 Agent 身份）"
									: "未选 Agent：任务会创建但不会执行"
								: "表达式无效，无法创建"}
					</span>
				</div>
			</div>
		</div>
	);
}

const WEEKDAYS: { value: number; label: string }[] = [
	{ value: 1, label: "周一" },
	{ value: 2, label: "周二" },
	{ value: 3, label: "周三" },
	{ value: 4, label: "周四" },
	{ value: 5, label: "周五" },
	{ value: 6, label: "周六" },
	{ value: 0, label: "周日" },
];

function Field({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-[12px] font-medium text-ink-subtle">
				{label}
				<span className="ml-1.5 font-mono text-[10.5px] text-ink-faint">{hint}</span>
			</label>
			{children}
		</div>
	);
}

function NumberField({
	id,
	bounds,
	value,
	onChange,
}: {
	id: string;
	bounds: { min: number; max: number };
	value: string;
	onChange: (v: string) => void;
}): React.JSX.Element {
	return (
		<input
			id={id}
			type="number"
			min={bounds.min}
			max={bounds.max}
			value={value}
			onChange={e => onChange(e.target.value)}
			className="w-full rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
		/>
	);
}

const RESOLUTION_LABELS: Record<ScheduleAgentResolution, string> = {
	registered: "已绑定 Agent",
	unregistered: "身份未解析（按目录执行）",
	unbound: "未绑定 Agent",
};

function TaskListCard({
	groups,
	totalCount,
	scopeMode,
	focusName,
	hasFocusAgent,
	logs,
	error,
	connected,
	busy,
	projectNames,
	agents,
	onShowLogs,
	onTestRun,
	onToggleStatus,
	onRebind,
	onRemove,
}: {
	groups: ReturnType<typeof groupTasks>;
	totalCount: number;
	scopeMode: ScopeMode;
	focusName?: string;
	hasFocusAgent: boolean;
	logs: CronLogEntryDto[];
	error: string | null;
	connected: boolean;
	busy: string | null;
	projectNames: Map<string, string>;
	/** 改绑候选（注册表里的 Agent；空列表 = 没有可改绑的目标）。 */
	agents: { id: string; name: string }[];
	onShowLogs: (task: TaskRowDto) => void;
	onTestRun: (task: TaskRowDto) => void;
	onToggleStatus: (task: TaskRowDto) => void;
	onRebind: (task: TaskRowDto, agentId: string) => void;
	onRemove: (task: TaskRowDto) => void;
}): React.JSX.Element {
	const visibleCount = groups.reduce((n, g) => n + g.rows.length, 0);

	return (
		<div className="rounded-xl border border-hairline bg-surface">
			<div className="flex items-baseline justify-between px-5 pt-4 pb-2">
				<div className="section-title">任务列表</div>
				<div className="font-mono text-[11px] text-ink-faint">
					{connected && !error
						? `${visibleCount} 个任务${scopeMode === "agent" ? "（本 Agent）" : `（全部 · 共 ${totalCount}）`} · 来自 gateway scheduler`
						: ""}
				</div>
			</div>

			{!connected && <div className="px-5 pb-6 text-center text-[12px] text-ink-faint">未连接——任务列表不可用</div>}
			{connected && error && (
				<div className="px-5 pb-6 text-center text-[12px] text-ink-faint">任务列表不可用：{error}</div>
			)}
			{connected && !error && visibleCount === 0 && (
				<div className="px-5 pb-6 text-center text-[12px] text-ink-faint">
					{totalCount === 0
						? "暂无定时任务——可在上方创建，或去 gateway 侧维护"
						: scopeMode === "agent"
							? hasFocusAgent
								? `${focusName ?? "本 Agent"} 名下暂无定时任务（切「全部 Agent」可看到未绑定/身份未解析的行）`
								: "当前没有焦点 Agent——切「全部 Agent」查看全部任务"
							: "没有匹配的任务"}
				</div>
			)}

			{connected && !error && visibleCount > 0 && (
				<div className="pb-2">
					{groups.map((group, gi) => (
						<Fragment key={group.key}>
							<div
								className={`flex items-baseline justify-between border-t border-hairline px-5 py-2 ${gi === 0 ? "border-t-0" : ""}`}
							>
								<div className="flex items-baseline gap-2">
									<span className="section-title">{group.label}</span>
									{group.bucket === "agent" && group.agentId && (
										<span className="font-mono text-[10.5px] text-ink-faint">{group.agentId}</span>
									)}
									<ProjectChips projectIds={group.projectIds} names={projectNames} />
								</div>
								<span className="font-mono text-[11px] text-ink-faint">
									{group.rows.length} 个任务
									{group.blockedCount > 0 ? ` · ${group.blockedCount} 个不会执行` : ""}
								</span>
							</div>
							{group.rows.map(row => (
								<TaskRow
									key={row.task.id}
									view={row}
									lastLog={latestLogOf(logs, row.task.id)}
									busy={busy}
									agents={agents}
									onShowLogs={onShowLogs}
									onTestRun={onTestRun}
									onToggleStatus={onToggleStatus}
									onRebind={onRebind}
									onRemove={onRemove}
								/>
							))}
						</Fragment>
					))}
				</div>
			)}
		</div>
	);
}

/** Project 归属：声明了才显示名字；未声明 ≠ 没有项目。 */
function ProjectChips({ projectIds, names }: { projectIds?: string[]; names: Map<string, string> }): React.JSX.Element {
	if (!projectIds || projectIds.length === 0) {
		return <span className="text-[10.5px] text-ink-faint">未声明项目绑定（不受约束）</span>;
	}
	return (
		<span className="flex items-baseline gap-1.5">
			{projectIds.map(id => (
				<span key={id} className="badge neutral">
					{names.get(id) ?? id}
				</span>
			))}
		</span>
	);
}

function TaskRow({
	view,
	lastLog,
	busy,
	agents,
	onShowLogs,
	onTestRun,
	onToggleStatus,
	onRebind,
	onRemove,
}: {
	view: TaskView;
	lastLog: CronLogEntryDto | undefined;
	busy: string | null;
	agents: { id: string; name: string }[];
	onShowLogs: (task: TaskRowDto) => void;
	onTestRun: (task: TaskRowDto) => void;
	onToggleStatus: (task: TaskRowDto) => void;
	onRebind: (task: TaskRowDto, agentId: string) => void;
	onRemove: (task: TaskRowDto) => void;
}): React.JSX.Element {
	const task = view.task;
	const progress = taskRunProgress(task);
	const [rebindTo, setRebindTo] = useState("");
	const busyHere = busy?.endsWith(`:${task.id}`) ?? false;

	return (
		<div className="flex items-start gap-3 border-t border-hairline px-5 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-2">
					<span className="text-[13.5px] font-medium text-ink">{task.name}</span>
					<span className="badge neutral">{task.scheduleType}</span>
					{task.taskType === "agent" && <span className="badge neutral">agent</span>}
					{!task.enabled && <span className="badge neutral">disabled</span>}
					{task.status === "paused" && <span className="badge neutral">已暂停</span>}
					{view.expired && <span className="badge neutral text-warning">已过期</span>}
					{progress.exhausted && <span className="badge neutral">已跑满 {progress.total} 次</span>}
					{view.bucket !== "agent" && (
						<span className="badge neutral text-warning">{RESOLUTION_LABELS[task.agentResolution]}</span>
					)}
				</div>
				{task.cron && <div className="mt-0.5 font-mono text-[11.5px] text-ink-subtle">{task.cron}</div>}
				<div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-faint">
					{task.nextRunAt !== undefined && task.nextRunAt > 0 && <span>下次：{fmtRun(task.nextRunAt)}</span>}
					{task.lastRunAt !== undefined && task.lastRunAt > 0 && <span>上次：{fmtRun(task.lastRunAt)}</span>}
					<span>{progress.text}</span>
					{(task.consecutiveFailures ?? 0) > 0 && (
						<span className="text-warning">
							连续失败 {task.consecutiveFailures} 次
							{task.retry ? `（重试上限 ${task.retry.maxAttempts} 次）` : ""}
						</span>
					)}
					{task.delivery?.toConversationId && <span>投递会话：{task.delivery.toConversationId}</span>}
				</div>
				<div className="mt-1 text-[11px] text-ink-faint">
					<span>{view.bindingLabel}</span>
				</div>
				{view.blockedReason && <div className="mt-1 text-[11px] text-warning">不会执行：{view.blockedReason}</div>}
				{task.lastDeliveryError && (
					// 投递失败 ≠ 任务失败：任务本体可能已完成，两件事分开显示。
					<div className="mt-1 text-[11px] text-warning">上次投递失败：{task.lastDeliveryError}</div>
				)}
				{lastLog && (
					<div className="mt-1 flex items-baseline gap-2 text-[11px] text-ink-faint">
						<span
							className={lastLog.status === "success" ? "font-medium text-success" : "font-medium text-danger"}
						>
							{lastLog.status}
						</span>
						<span className="font-mono">{fmtRun(lastLog.ts)}</span>
						{lastLog.durationMs !== null && <span>{(lastLog.durationMs / 1000).toFixed(1)}s</span>}
						{/* Session scope：这次执行落到的会话文件（执行记录自带，不按时间猜） */}
						{lastLog.agentSessionPath && (
							<span className="truncate pl-1 text-ink-faint" title={lastLog.agentSessionPath}>
								会话：{lastLog.agentSessionPath.split("/").pop()}
							</span>
						)}
						{lastLog.output && (
							<span className="truncate pl-1 text-ink-faint">{lastLog.output.slice(0, 80)}</span>
						)}
					</div>
				)}
			</div>

			<div className="mt-0.5 flex shrink-0 flex-wrap items-center justify-end gap-1.5">
				<button
					type="button"
					onClick={() => onShowLogs(task)}
					aria-label={`${task.name} 查看日志`}
					className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
				>
					日志
				</button>
				<button
					type="button"
					disabled={busyHere || view.blockedReason !== undefined}
					title={view.blockedReason ?? "立即试跑一次（跑完恢复原调度）"}
					onClick={() => onTestRun(task)}
					aria-label={`${task.name} 试跑`}
					className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
				>
					试跑
				</button>
				<button
					type="button"
					disabled={busyHere}
					onClick={() => onToggleStatus(task)}
					aria-label={`${task.name} 启用或暂停`}
					className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
				>
					{task.status === "paused" ? "启用" : "暂停"}
				</button>
				{busy === `rebind:${task.id}` ? (
					<span className="font-mono text-[11px] text-ink-faint">改绑中…</span>
				) : (
					<select
						value={rebindTo}
						onChange={e => {
							const next = e.target.value;
							setRebindTo("");
							if (next) onRebind(task, next);
						}}
						aria-label={`${task.name} 改绑 Agent`}
						className="rounded-md border border-hairline bg-surface-2 px-1.5 py-1 text-[11.5px] text-ink-subtle"
					>
						<option value="">改绑 Agent…</option>
						{agents.map(a => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</select>
				)}
				<button
					type="button"
					disabled={busyHere}
					onClick={() => onRemove(task)}
					aria-label={`${task.name} 删除`}
					className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1 text-[11.5px] text-ink-subtle transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
				>
					删除
				</button>
			</div>
		</div>
	);
}

/** 任务日志弹层：get_cron_logs(taskId) 最近 30 条运行记录（只读，经 gateway 代理）。 */
function TaskLogPanel({ task, onClose }: { task: TaskRowDto; onClose: () => void }): React.JSX.Element {
	const store = useSessionStore();
	const [entries, setEntries] = useState<CronLogEntryDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	useEffect(() => {
		let alive = true;
		setEntries(null);
		setError(null);
		void store
			.fetchCronLogs({ taskId: task.name, days: 7, limit: 30 })
			.then(r => {
				if (alive) setEntries(r.logs);
			})
			.catch(err => {
				if (alive) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			alive = false;
		};
	}, [store, task.name]);

	const toggleExpand = (id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div
			className="fixed inset-0 z-modal flex items-start justify-center bg-ink/40 p-6"
			role="dialog"
			aria-modal="true"
		>
			<div className="mt-8 max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-hairline bg-surface shadow-2xl">
				<div className="flex items-center justify-between border-b border-hairline px-5 py-3">
					<div className="min-w-0">
						<span className="text-[14px] font-semibold text-ink">{task.name}</span>
						<span className="ml-2 font-mono text-[11px] text-ink-faint">运行日志 · 最近 7 天</span>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭日志"
						className="rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
					>
						关闭 ✕
					</button>
				</div>

				<div className="max-h-[70vh] overflow-y-auto">
					{error && <div className="px-5 py-8 text-center text-[12px] text-ink-faint">日志不可用：{error}</div>}
					{!error && entries === null && (
						<div className="px-5 py-8 text-center text-[12px] text-ink-faint">加载日志…</div>
					)}
					{!error && entries !== null && entries.length === 0 && (
						<div className="px-5 py-8 text-center text-[12px] text-ink-faint">该任务近 7 天无运行记录</div>
					)}
					{entries?.map(entry => (
						<div key={entry.id} className="border-b border-hairline px-5 py-2.5 last:border-b-0">
							<div className="flex items-baseline gap-2.5">
								<span
									className={
										entry.status === "success"
											? "font-mono text-[10.5px] font-semibold text-success"
											: entry.status === "failed" || entry.status === "fail"
												? "font-mono text-[10.5px] font-semibold text-danger"
												: "font-mono text-[10.5px] font-semibold text-ink-subtle"
									}
								>
									{entry.status}
								</span>
								<span className="font-mono text-[11px] text-ink-subtle">{fmtRun(entry.ts)}</span>
								{entry.durationMs !== null && (
									<span className="font-mono text-[10.5px] text-ink-faint">
										{(entry.durationMs / 1000).toFixed(1)}s
									</span>
								)}
								{entry.exitCode !== null && (
									<span className="font-mono text-[10.5px] text-ink-faint">exit {entry.exitCode}</span>
								)}
								<button
									type="button"
									onClick={() => toggleExpand(entry.id)}
									disabled={!entry.output}
									className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-default disabled:hover:bg-transparent"
								>
									{entry.output ? (expanded.has(entry.id) ? "收起" : "展开") : "—"}
								</button>
							</div>
							{/* Session scope：这次执行落到哪个会话文件（agent 任务才有） */}
							{entry.agentSessionPath && (
								<div
									className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint"
									title={entry.agentSessionPath}
								>
									会话：{entry.agentSessionPath}
								</div>
							)}
							{(expanded.has(entry.id) || (entry.output?.length ?? 0) < 120) && entry.output && (
								<div className="mt-1">
									<pre className="max-h-56 overflow-auto rounded-md border border-hairline bg-surface-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-subtle">
										{entry.output}
									</pre>
									{entry.outputTruncated && (
										<div className="mt-0.5 text-[10px] text-ink-faint">输出超过 2KB 已截断</div>
									)}
								</div>
							)}
							{(entry.output?.length ?? 0) >= 120 && !expanded.has(entry.id) && entry.output && (
								<div className="mt-1 max-h-16 overflow-hidden font-mono text-[10.5px] text-ink-faint">
									{entry.output.slice(0, 140)}…
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
